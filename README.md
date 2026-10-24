# dsh-out-video

DeepSeek Harness（DSH）视频生成插件：把百炼（dashscope）异步视频生成接入 agent 工具面板，agent 可直接调用生成/编辑视频并自动下载到本地。

## 工具

- **list_video_models** — 列出已接入模型、必填参数与限制。
- **generate_video** — 提交任务并等待完成。成功返回视频直链 + 本地 mp4 路径；超过约 8.5 分钟未完成时返回 `task_id`，可稍后用 `check_video_task` 收尾。所有 URL 参数都可以直接给**本地文件路径**，server 会自动通过 dashscope 上传通道转成 `oss://` 引用。
- **check_video_task** — 查询任务状态；已成功且本地文件缺失时补下载。

视频生成通常 1-5 分钟。文件名用 task_id，重复下载幂等。

## 模型

| model | 必填参数 | 说明 |
|---|---|---|
| `wan3.0-video`（默认） | 无（prompt） | 文生视频；加 `img_url` 转图生视频。`duration`、`size` 可调 |
| `wan2.5-i2v-preview` | `img_url` | 图生视频，prompt 描述运镜 |
| `wanx2.1-kf2v-plus` | `first_frame_url` | 首尾帧过渡；可选 `last_frame_url`；时长固定 5 秒、720P |
| `videoretalk` | `video_url` + `audio_url` | 声动人像/口型同步；人物视频（2-120s，≤300MB）+ 清晰人声（2-120s）；多人脸用 `ref_image_url` |
| `video-style-transform` | `video_url` | 视频风格化 |
| `happyhorse-1.0-video-edit` | `media_url` | 自然语言指令编辑视频（换装/换风格/替换元素） |

通用可选：`duration`、`size`、`resolution`；`parameters` / `input_extra` 可透传任意 dashscope 参数。

## 安装

```bash
git clone https://github.com/zhonglike/dsh-out-video
cd dsh-out-video && npm install
dsh plugin --profile <你的profile> add "link:<本插件绝对路径>"
```

安装后按需修改插件内 `cordis.patch.yml` 的两处本机路径：

- `command`：node 可执行文件路径（示例为 `D:\nodjs\node.exe`，也可用 PATH 里的 `node`）
- `args`：`mcp-video-gen.mjs` 的绝对路径

重启 DSH 即生效。

## 配置

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `DSH_VIDEO_API_KEY` | dashscope key（优先级最高） | — |
| `QWEN_TOKEN_PLAN_CN_API_KEY` | dashscope key（次选） | — |
| `DSH_VIDEO_GEN_DIR` | 视频下载目录 | `~/.dsh/video-gen` |

未设置环境变量时，自动读取 DSH 托管的 `~/.dsh/.credentials.yaml` 中 `refs.QWEN_TOKEN_PLAN_CN_API_KEY`（即 Models 页写入的那把 key）。key 只发往 `dashscope.aliyuncs.com` 与其 OSS 上传桶，不写日志、不进返回结果。

## 依赖

- DSH（MCP 客户端通过 stdio 启动本插件的 server）
- Node.js ≥ 18（`@modelcontextprotocol/sdk`、`zod`）
- 百炼 API key（需开通对应视频生成模型）
