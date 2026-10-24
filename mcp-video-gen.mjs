// dsh-out-video MCP server（stdio）。由 DSH 的 MCP 客户端 spawn（见同目录 cordis.patch.yml）。
//
// 功能：
// - `list_video_models`：列出已接入的百炼视频模型及其必填参数。
// - `generate_video`：提交异步视频生成任务并等待完成，成功后自动下载 mp4 到本地；
//   超过约 8.5 分钟未完成时返回 task_id，让 agent 稍后用 `check_video_task` 收尾。
//   支持文生视频、图生视频、首尾帧、声动人像（口型同步）、视频风格化、视频指令编辑。
//   所有 URL 参数都可以直接给**本地文件路径**，server 会自动走 dashscope 上传通道转成
//   oss:// 引用（并附带 X-DashScope-OssResourceResolve: enable 头）。
// - `check_video_task`：查询任务状态；已成功且本地文件缺失时补下载。
//
// 凭据：环境变量 DSH_VIDEO_API_KEY → QWEN_TOKEN_PLAN_CN_API_KEY →
// DSH 托管的 `$DSH_HOME/.credentials.yaml` 的 `refs`（与 Models 页写入的同一份）。
// key 只发往 dashscope.aliyuncs.com 与其 OSS 上传桶，不写日志、不进错误信息、不进返回结果。
//
// 输出目录：环境变量 DSH_VIDEO_GEN_DIR，默认 `~/.dsh/video-gen`；文件名用 task_id，重复下载幂等。
//
// 注意：stdout 只承载 MCP 协议帧，任何诊断一律走 stderr。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const ENDPOINTS = {
  'video-generation': `${DASHSCOPE_BASE}/services/aigc/video-generation/video-synthesis`,
  image2video: `${DASHSCOPE_BASE}/services/aigc/image2video/video-synthesis`,
};
const TASK_URL = (id) => `${DASHSCOPE_BASE}/tasks/${encodeURIComponent(id)}`;

const DEFAULT_MODEL = 'wan3.0-video';
const POLL_INTERVAL_MS = 10_000;
const FIRST_POLL_DELAY_MS = 5_000;
const POLL_DEADLINE_MS = 8.5 * 60 * 1000; // 留 1.5 分钟余量给下载，总超时由 toolCallTimeoutMs(10min) 兜底
const SUBMIT_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 模型注册表：endpoint 决定提交路径；requires 是提交前必须齐备的 input 字段（校验用，
 * 缺了会被友好拒绝而不是白跑一次失败任务）；inputMap 把工具参数名映射到 dashscope 的
 * input 字段名（happyhorse 的源视频字段叫 media）；hint 进入 list_video_models 的输出。
 */
const MODEL_REGISTRY = {
  'wan3.0-video': {
    endpoint: 'video-generation',
    requires: [],
    hint: '文生视频：只给 prompt 即可；加 img_url 则为图生视频。支持 duration（秒）和 size（如 1280*720）。',
  },
  'wan2.5-i2v-preview': {
    endpoint: 'video-generation',
    requires: ['img_url'],
    hint: '图生视频：必须提供 img_url（首帧图，本地路径或 URL），prompt 描述运镜/动作。',
  },
  'wanx2.1-kf2v-plus': {
    endpoint: 'image2video',
    requires: ['first_frame_url'],
    hint: '首尾帧生视频：必须 first_frame_url，可选 last_frame_url（输出宽高比随首帧）。时长固定 5 秒，分辨率仅 720P（parameters.resolution）。',
  },
  videoretalk: {
    endpoint: 'image2video',
    requires: ['video_url', 'audio_url'],
    hint: '声动人像（口型同步）：人物视频 video_url（mp4/avi/mov，2-120 秒，≤300MB，正面近景人脸）+ 人声音频 audio_url（wav/mp3/aac，2-120 秒，清晰人声无背景乐）。多人脸视频可用 ref_image_url 指定目标人物；音频比视频长时可设 parameters.video_extension=true。',
  },
  'video-style-transform': {
    endpoint: 'video-generation',
    requires: ['video_url'],
    hint: '视频风格化：必须提供 video_url（源视频），prompt 描述目标风格。',
  },
  'happyhorse-1.0-video-edit': {
    endpoint: 'video-generation',
    requires: ['media_url'],
    inputMap: { media_url: 'media' },
    hint: '视频指令编辑：必须提供 media_url（源视频，本地路径或 URL），prompt 用自然语言描述编辑（换装/换风格/替换元素等），最多可配 5 张参考图（parameters 透传）。',
  },
};

/** 从 DSH 托管凭据文档读 `refs.<name>`；文档是 dsh 机器写入的扁平两段结构，逐行解析即可。 */
function readDshCredential(name) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const raw = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    const lines = String(raw).split(/\r?\n/);
    let inRefs = false;
    for (const line of lines) {
      if (/^\S/.test(line)) inRefs = line.startsWith('refs:');
      if (!inRefs) continue;
      const m = line.match(/^\s{2,}([A-Za-z0-9_]+):\s*(.+?)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return '';
}

function resolveApiKey() {
  const fromEnv =
    process.env.DSH_VIDEO_API_KEY?.trim() || process.env.QWEN_TOKEN_PLAN_CN_API_KEY?.trim();
  return fromEnv || readDshCredential('QWEN_TOKEN_PLAN_CN_API_KEY') || '';
}

function mediaDir() {
  const dir = process.env.DSH_VIDEO_GEN_DIR?.trim() || path.join(os.homedir(), '.dsh', 'video-gen');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 统一的 dashscope 调用：超时、非 2xx 与业务错误都折成可读 Error（绝不带 key）。 */
async function dashscopeFetch(url, options, timeoutMs) {
  const key = resolveApiKey();
  if (!key) throw new Error('没有可用的 dashscope API key（检查 DSH_VIDEO_API_KEY 或 ~/.dsh/.credentials.yaml 的 refs）');
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`请求 dashscope 失败：${err?.cause?.code ?? err?.name ?? 'network error'}`);
  }
  const bodyText = await res.text();
  let body = {};
  try {
    body = JSON.parse(bodyText);
  } catch {}
  if (!res.ok) {
    const msg = body?.message ?? body?.error?.message ?? bodyText.slice(0, 200) ?? '';
    throw new Error(`dashscope HTTP ${res.status}：${msg}`);
  }
  return body;
}

/**
 * 上传本地文件到 dashscope 临时存储（getPolicy → OSS PostObject），返回 oss:// 引用。
 * 引用在提交时配合 X-DashScope-OssResourceResolve: enable 头使用。
 */
async function uploadToDashscope(filePath, model) {
  const data = await dashscopeFetch(
    `${DASHSCOPE_BASE}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,
    { method: 'GET' },
    30_000
  ).then((j) => j.data);
  const stat = fs.statSync(filePath);
  if (data.max_file_size_mb && stat.size > data.max_file_size_mb * 1024 * 1024) {
    throw new Error(`文件 ${path.basename(filePath)} 超过上传上限 ${data.max_file_size_mb}MB`);
  }
  const objectKey = `${data.upload_dir}/${Date.now()}-${path.basename(filePath)}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', data.oss_access_key_id);
  form.append('Signature', data.signature);
  form.append('policy', data.policy);
  form.append('key', objectKey);
  form.append('x-oss-object-acl', data.x_oss_object_acl);
  form.append('success_action_status', '200');
  if (data.x_oss_forbid_overwrite !== undefined) {
    form.append('x-oss-forbid-overwrite', String(data.x_oss_forbid_overwrite));
  }
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await fetch(data.upload_host, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`上传 ${path.basename(filePath)} 失败：OSS HTTP ${res.status}`);
  return `oss://dashscope-file-mgr/${objectKey}`;
}

/** URL 参数值解析：本地文件（存在）→ 自动上传；其余按 URL 原样使用。 */
async function resolveMediaRef(value, model, fieldName) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (/^(https?:|oss:|data:)/i.test(v)) return v;
  const local = v.startsWith('~/')
    ? path.join(os.homedir(), v.slice(2))
    : path.resolve(v.replace(/^file:\/\//i, ''));
  if (fs.existsSync(local)) {
    process.stderr.write(`[video-gen] uploading local ${fieldName}: ${local}\n`);
    return uploadToDashscope(local, model);
  }
  throw new Error(`${fieldName} 既不是可访问的 URL，也不是存在的本地文件：${v}`);
}

/** 提交生成任务，返回 task_id。任一 oss:// 引用出现时附带 resolve 头。 */
async function submitTask(model, endpoint, input, parameters) {
  const headers = { 'X-DashScope-Async': 'enable' };
  if (Object.values(input).some((v) => typeof v === 'string' && v.startsWith('oss://'))) {
    headers['X-DashScope-OssResourceResolve'] = 'enable';
  }
  const body = await dashscopeFetch(
    ENDPOINTS[endpoint],
    { method: 'POST', headers, body: JSON.stringify({ model, input, parameters }) },
    SUBMIT_TIMEOUT_MS
  );
  const taskId = body?.output?.task_id;
  if (!taskId) throw new Error(`提交成功但未返回 task_id：${JSON.stringify(body).slice(0, 200)}`);
  return taskId;
}

/** 查询一次任务，折成扁平结果。PRE-PROCESSING/POST-PROCESSING 等都视为进行中。 */
async function getTask(taskId) {
  const body = await dashscopeFetch(TASK_URL(taskId), { method: 'GET' }, 30_000);
  const output = body?.output ?? {};
  return {
    status: String(output.task_status ?? 'UNKNOWN'),
    terminal: ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(String(output.task_status)),
    videoUrl: typeof output.video_url === 'string' ? output.video_url : '',
    message: [output.code, output.message].filter(Boolean).join(': '),
    usage: body?.usage ?? null,
  };
}

function localVideoPath(taskId) {
  return path.join(mediaDir(), `${taskId}.mp4`);
}

/** 下载 mp4 到本地（文件名 = task_id，已存在即跳过），返回本地路径。 */
async function downloadVideo(taskId, videoUrl) {
  const target = localVideoPath(taskId);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载视频失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  return target;
}

function registryText() {
  const lines = Object.entries(MODEL_REGISTRY).map(([id, m]) => {
    const need = m.requires.length > 0 ? `必填: ${m.requires.join(', ')}` : '必填: 无（prompt 驱动）';
    return `- ${id}${id === DEFAULT_MODEL ? '（默认）' : ''} — ${need}\n  ${m.hint}`;
  });
  return ['已接入的百炼视频模型（generate_video 的 model 参数）：', ...lines, '', '所有 URL 类参数都可直接给本地文件路径，server 会自动上传。'].join('\n');
}

function text(result) {
  return { content: [{ type: 'text', text: result }] };
}

const server = new McpServer({ name: 'video-gen', version: '0.2.0' });

server.tool(
  'list_video_models',
  '列出本插件已接入的视频生成模型、各自必填参数与限制。生成视频前先看一眼可以少走弯路。',
  {},
  async () => text(registryText())
);

server.tool(
  'generate_video',
  `生成一段短视频（百炼异步生成，通常 1-5 分钟）。成功时返回视频直链和已下载的本地 mp4 路径；超时未完成时返回 task_id，请稍后调用 check_video_task 收尾。先用 list_video_models 查看每个模型的必填参数与限制。`,
  {
    prompt: z.string().optional().describe('内容描述/编辑指令；文生视频与视频编辑模型必填，图生视频与首尾帧模型推荐提供'),
    model: z.string().optional().describe(`模型 id，默认 ${DEFAULT_MODEL}；详见 list_video_models`),
    img_url: z.string().optional().describe('图生视频首帧图片（URL 或本地路径）'),
    first_frame_url: z.string().optional().describe('首尾帧模型的首帧图片（URL 或本地路径）'),
    last_frame_url: z.string().optional().describe('首尾帧模型的尾帧图片（URL 或本地路径）'),
    video_url: z.string().optional().describe('源视频（videoretalk / video-style-transform 必填；URL 或本地路径）'),
    audio_url: z.string().optional().describe('人声音频（videoretalk 必填；URL 或本地路径）'),
    ref_image_url: z.string().optional().describe('videoretalk 多人脸时指定目标人物的参考图（URL 或本地路径）'),
    media_url: z.string().optional().describe('happyhorse-1.0-video-edit 的源视频（URL 或本地路径）'),
    duration: z.number().int().positive().optional().describe('时长（秒），部分模型固定不可改'),
    size: z.string().optional().describe('分辨率，宽*高，如 1280*720（部分模型只认 resolution）'),
    resolution: z.string().optional().describe('清晰度档位，如 720P/1080P'),
    parameters: z.record(z.string(), z.unknown()).optional().describe('其余透传给 dashscope parameters 的参数（如 video_extension、watermark、seed）'),
    input_extra: z.record(z.string(), z.unknown()).optional().describe('其余透传给 dashscope input 的字段（覆盖同名常规参数）'),
  },
  async (args) => {
    const {
      prompt, model, img_url, first_frame_url, last_frame_url, video_url, audio_url,
      ref_image_url, media_url, duration, size, resolution, parameters, input_extra,
    } = args;
    try {
      const usedModel = model?.trim() || DEFAULT_MODEL;
      const reg = MODEL_REGISTRY[usedModel];
      const endpoint = reg?.endpoint ?? 'video-generation';

      const input = {};
      if (prompt?.trim()) input.prompt = prompt.trim().slice(0, 4000);
      const refs = { img_url, first_frame_url, last_frame_url, video_url, audio_url, ref_image_url, media_url };
      for (const [field, value] of Object.entries(refs)) {
        if (!value?.trim()) continue;
        const key = reg?.inputMap?.[field] ?? field;
        input[key] = await resolveMediaRef(value, usedModel, field);
      }
      Object.assign(input, input_extra ?? {});

      if (reg) {
        const missing = reg.requires.filter((f) => !input[f]);
        if (missing.length > 0) {
          return {
            content: [{
              type: 'text',
              text: `模型 ${usedModel} 缺少必填参数：${missing.join(', ')}。\n${reg.hint}`,
            }],
            isError: true,
          };
        }
      } else {
        process.stderr.write(`[video-gen] model ${usedModel} not in registry; using video-generation endpoint\n`);
      }

      const params = { ...(parameters ?? {}) };
      if (duration) params.duration = duration;
      if (size) params.size = size;
      if (resolution) params.resolution = resolution;

      const taskId = await submitTask(usedModel, endpoint, input, params);
      process.stderr.write(`[video-gen] task ${taskId} submitted (${usedModel})\n`);

      const deadline = Date.now() + POLL_DEADLINE_MS;
      await new Promise((r) => setTimeout(r, FIRST_POLL_DELAY_MS));
      let last = null;
      while (Date.now() < deadline) {
        last = await getTask(taskId);
        if (last.terminal) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!last) return text(`任务已提交：task_id=${taskId}（轮询未开始即超时，请稍后用 check_video_task 查询）`);
      if (last.status === 'SUCCEEDED') {
        const localPath = await downloadVideo(taskId, last.videoUrl);
        return text(
          `视频生成完成。\n模型: ${usedModel}\ntask_id: ${taskId}\n视频直链: ${last.videoUrl}\n本地文件: ${localPath}\n视频直链为 OSS 签名地址，约 24 小时后过期；本地文件长期可用。`
        );
      }
      if (last.status === 'FAILED' || last.status === 'CANCELED') {
        return text(
          `任务${last.status === 'FAILED' ? '失败' : '被取消'}：task_id=${taskId}\n原因: ${last.message || 'dashscope 未返回具体原因'}\n提示: 若涉及上传的素材，请确认其内容符合模型要求（如 videoretalk 需清晰人声、正面人脸）。`
        );
      }
      return text(
        `任务仍在生成中（${last.status}），已等待超过 ${Math.round(POLL_DEADLINE_MS / 60000)} 分钟。\ntask_id: ${taskId}\n请稍后调用 check_video_task 查询结果。`
      );
    } catch (err) {
      return { content: [{ type: 'text', text: `生成失败：${err?.message ?? err}` }], isError: true };
    }
  }
);

server.tool(
  'check_video_task',
  '查询 generate_video 返回的任务状态；已成功且本地文件缺失时会补下载 mp4。',
  { task_id: z.string().min(1).describe('generate_video 返回的 task_id') },
  async ({ task_id }) => {
    try {
      const result = await getTask(task_id);
      if (result.status === 'SUCCEEDED') {
        const localPath = await downloadVideo(task_id, result.videoUrl);
        return text(`任务已完成。\n视频直链: ${result.videoUrl}\n本地文件: ${localPath}`);
      }
      if (result.status === 'FAILED' || result.status === 'CANCELED') {
        return text(`任务${result.status === 'FAILED' ? '失败' : '被取消'}。\n原因: ${result.message || 'dashscope 未返回具体原因'}`);
      }
      return text(`任务状态: ${result.status}（进行中，请稍后再查）`);
    } catch (err) {
      return { content: [{ type: 'text', text: `查询失败：${err?.message ?? err}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
