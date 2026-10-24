# dsh-out-video

DeepSeek Harness（DSH）视频生成插件：把百炼（dashscope）wan 系列异步视频生成接入 agent 工具面板，agent 可直接调用生成视频并自动下载到本地。

## 工具

- **generate_video** — 提交视频生成任务并等待完成。成功返回视频直链 + 本地 mp4 路径；超过约 8.5 分钟未完成时返回 `task_id`，可稍后用 `check_video_task` 收尾。
  - `prompt`（必填）：视频内容描述，中英文皆可
  - `model`：默认 `wan3.0-video`（文生视频/图生视频）
  - `img_url`：图生视频首帧图片直链（需公网可访问），配合 `wan2.5-i2v-preview` 等
  - `first_frame_url` / `last_frame_url`：首尾帧生视频，配合 `wanx2.1-kf2v-plus`
  - `duration`：时长（秒）；`size`：分辨率（如 `1280*720`）
  - `parameters`：其余透传给 dashscope `parameters` 的参数
- **check_video_task** — 查询任务状态；已成功且本地文件缺失时补下载。

视频生成通常 1-5 分钟（480p/5s 实测约 2 分钟）。文件名用 task_id，重复下载幂等。

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

未设置环境变量时，自动读取 DSH 托管的 `~/.dsh/.credentials.yaml` 中 `refs.QWEN_TOKEN_PLAN_CN_API_KEY`（即 Models 页写入的那把 key）。key 只发往 `dashscope.aliyuncs.com`，不写日志、不进返回结果。

## 依赖

- DSH（MCP 客户端通过 stdio 启动本插件的 server）
- Node.js ≥ 18（`@modelcontextprotocol/sdk`、`zod`）
- 百炼 API key（需开通视频生成，如 wan3.0-video）
