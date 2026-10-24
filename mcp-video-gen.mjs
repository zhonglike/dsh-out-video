// dsh-video-gen MCP server（stdio）。由 DSH 的 MCP 客户端 spawn（见同目录 cordis.patch.yml）。
//
// 功能：
// - `generate_video`：提交百炼异步视频生成任务并等待完成（默认 wan3.0-video 文生视频；
//   传 img_url 走图生视频，传 first_frame_url/last_frame_url 走首尾帧）。成功后自动把
//   mp4 下载到本地媒体目录，返回 URL + 本地路径。生成超过约 8.5 分钟时返回 task_id，
//   让 agent 稍后用 `check_video_task` 收尾。
// - `check_video_task`：查询任务状态；已成功且本地文件缺失时补下载。
//
// 凭据：环境变量 DSH_VIDEO_API_KEY → QWEN_TOKEN_PLAN_CN_API_KEY →
// DSH 托管的 `$DSH_HOME/.credentials.yaml` 的 `refs`（与 Models 页写入的同一份）。
// key 只发往 dashscope.aliyuncs.com，不写日志、不进错误信息、不进返回结果。
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
const SUBMIT_URL = `${DASHSCOPE_BASE}/services/aigc/video-generation/video-synthesis`;
const taskUrl = (id) => `${DASHSCOPE_BASE}/tasks/${encodeURIComponent(id)}`;

const DEFAULT_MODEL = 'wan3.0-video';
const POLL_INTERVAL_MS = 10_000;
const FIRST_POLL_DELAY_MS = 5_000;
const POLL_DEADLINE_MS = 8.5 * 60 * 1000; // 留 1.5 分钟余量给下载，总超时由 toolCallTimeoutMs(10min) 兜底
const SUBMIT_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

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

/** 提交生成任务，返回 task_id。 */
async function submitTask({ model, input, parameters }) {
  const body = await dashscopeFetch(
    SUBMIT_URL,
    {
      method: 'POST',
      headers: { 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model, input, parameters }),
    },
    SUBMIT_TIMEOUT_MS
  );
  const taskId = body?.output?.task_id;
  if (!taskId) throw new Error(`提交成功但未返回 task_id：${JSON.stringify(body).slice(0, 200)}`);
  return taskId;
}

/** 查询一次任务，折成扁平结果。 */
async function getTask(taskId) {
  const body = await dashscopeFetch(taskUrl(taskId), { method: 'GET' }, 30_000);
  const output = body?.output ?? {};
  return {
    status: String(output.task_status ?? 'UNKNOWN'),
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

const MODEL_HINTS = [
  '- wan3.0-video（默认）：文生视频/图生视频，只需 prompt（可配 img_url）',
  '- wan2.5-i2v-preview：图生视频，必须给 img_url（公网可访问的图片直链）',
  '- wanx2.1-kf2v-plus：首尾帧生视频，给 first_frame_url（可配 last_frame_url）',
  '- videoretalk / video-style-transform / happyhorse-1.0-video-edit：特殊模型，参数随模型不同，报错时以 dashscope 返回的信息为准',
].join('\n');

function text(result) {
  return { content: [{ type: 'text', text: result }] };
}

const server = new McpServer({ name: 'video-gen', version: '0.1.0' });

server.tool(
  'generate_video',
  `生成一段短视频（百炼 wan 系列异步生成，通常 1-5 分钟）。成功时返回视频直链和已下载的本地 mp4 路径；超时未完成时返回 task_id，请稍后调用 check_video_task 收尾。\n可选模型：\n${MODEL_HINTS}`,
  {
    prompt: z.string().min(1).describe('视频内容描述，中英文皆可；图生视频时描述期望的运镜/动作'),
    model: z.string().optional().describe(`模型 id，默认 ${DEFAULT_MODEL}`),
    img_url: z.string().url().optional().describe('图生视频的首帧图片直链（http/https，需公网可访问）'),
    first_frame_url: z.string().url().optional().describe('首尾帧模型的首帧图片直链'),
    last_frame_url: z.string().url().optional().describe('首尾帧模型的尾帧图片直链'),
    duration: z.number().int().positive().optional().describe('时长（秒），如 5'),
    size: z.string().optional().describe('分辨率，宽*高，如 1280*720'),
    parameters: z.record(z.string(), z.unknown()).optional().describe('其余透传给 dashscope parameters 的参数'),
  },
  async ({ prompt, model, img_url, first_frame_url, last_frame_url, duration, size, parameters }) => {
    try {
      const input = { prompt: prompt.slice(0, 4000) };
      if (img_url) input.img_url = img_url;
      if (first_frame_url) input.first_frame_url = first_frame_url;
      if (last_frame_url) input.last_frame_url = last_frame_url;
      const params = { ...(parameters ?? {}) };
      if (duration) params.duration = duration;
      if (size) params.size = size;

      const usedModel = model?.trim() || DEFAULT_MODEL;
      const taskId = await submitTask({ model: usedModel, input, parameters: params });
      process.stderr.write(`[video-gen] task ${taskId} submitted (${usedModel})\n`);

      const deadline = Date.now() + POLL_DEADLINE_MS;
      await new Promise((r) => setTimeout(r, FIRST_POLL_DELAY_MS));
      let last = null;
      while (Date.now() < deadline) {
        last = await getTask(taskId);
        if (last.status === 'SUCCEEDED' || last.status === 'FAILED' || last.status === 'CANCELED') break;
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
        return text(`任务${last.status === 'FAILED' ? '失败' : '被取消'}：task_id=${taskId}\n原因: ${last.message || 'dashscope 未返回具体原因'}`);
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
      return text(`任务状态: ${result.status}（PENDING/RUNNING 表示仍在生成，请稍后再查）`);
    } catch (err) {
      return { content: [{ type: 'text', text: `查询失败：${err?.message ?? err}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
