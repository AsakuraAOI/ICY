# icy

极简 QQ 官方机器人内核：只做**协议接入**、**事件归一化**、**插件宿主**三件事。

内核里没有「命令」「AI 回复」「菜单」「定时任务」「审核」—— 那些都是插件的事。这条边界不是口号而是约束：源码里出现这些概念，说明分层已经塌了。

- **零运行时依赖。** `dependencies` 是空的，只用 Node 内置能力（`fetch`、内置 `WebSocket`、`node:crypto`）。
- **插件语言无关。** 内核只做 `spawn(command, [...args, entry])`，IPC 是 JSON-RPC 2.0 / NDJSON over stdio。TypeScript 插件不需要构建步骤。
- **失败一律翻译成稳定枚举。** 插件不解析平台 `err_code`，也不依赖 `message` 文案。
- **入站与出站不是镜像。** 事件的形状 ≠ 发送参数的形状，内核不提供把收到的 `msg_elements` 原样提交回去的接口。

## 要求

Node ≥ 22（见 `engines`）。开发只需 `npm install` —— 只有 `typescript` 与 `@types/node` 两个 devDependency。

## 快速开始

```bash
cp .env.example .env      # 填 QQ_APP_ID / QQ_APP_SECRET
npm install
npm run build
npm start
```

`.env` 只是本地开发的便利：真实环境变量优先，只补环境里缺的键。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `QQ_APP_ID` / `QQ_APP_SECRET` | 必填 | 开放平台凭证 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PLUGIN_DIR` | `./plugins` | 插件目录 |
| `QQ_API_BASE` | `https://api.bot.qq.com` | 基址覆盖，留给代理 / 沙箱 |
| `QQ_SEND_PER_CONVERSATION` | `4` | 主动消息：单会话每窗口条数 |
| `QQ_SEND_GLOBAL` | `20` | 主动消息：全局每窗口条数 |
| `QQ_SEND_WINDOW_MS` | `60000` | 主动消息：窗口长度 |

**intents 是连接级参数**：Identify 时一次性打包，运行中改不了，写错会让连接立刻被关（4014）。P3 之前必须先申请 `GROUP_AND_C2C_EVENT`（`1 << 25`）。启动时会把需要申请的 intent 打进日志。

## 自检

```bash
npm run verify   # typecheck → build → smoke → e2e
```

`smoke` 不连网络：插件发现、事件投递与 fanout、被动窗口、去重、频控、分片上传、ARK/Embed 校验、错误分类。`e2e` 拉起真实的 `dist/main.js` 子进程，配一个手写的 QQ 替身后端，覆盖只有真实进程才暴露的东西 —— Resume 复用 `session_id`、致命关闭码退出、插件进程回收、关停 exit code。

## 写插件

```
plugins/<name>/
├── plugin.json
└── index.js
```

```json
{
  "name": "echo",
  "version": "0.1.0",
  "entry": "index.js",
  "intents": ["GROUP_AND_C2C_EVENT"],
  "events": ["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"],
  "capabilities": ["message.reply"],
  "priority": 100
}
```

Node.js / TypeScript 插件优先使用内置 SDK，生命周期、`plugin/ready`、JSON-RPC pending map 与 NDJSON 拆帧都由 SDK 处理：

```ts
import { createPlugin } from 'icy-qqbot/sdk';

createPlugin({
  name: 'hello',
  version: '0.1.0',
  onEvent({ event }) {
    if (event.kind !== 'group' && event.kind !== 'c2c') return null;
    return { scope: event.kind, body: { kind: 'text', text: '你好' } };
  },
}).run();
```

底层仍是同一套 IPC 契约；其他语言可以直接实现 JSON-RPC 协议。SDK 启动后 `stdout` 仍只能出现协议帧，日志使用 `host.log`、`stderr` 或 `console.error`。

回复只需要表达**意图** —— `msg_type`、`msg_id`、`msg_seq` 与整个上传流程都由内核负责。

`kind` 取值：`text` / `markdown` / `ark` / `embed` / `media`（图片、语音、视频、文件；给 `url`、`data` 或 `localPath`）/ `typing`（仅单聊）。`keyboard` 与 `referenceMessageId` 可以与任意一种共存。

能力（`capabilities`）没声明就会被内核拒绝，不会打到平台：`message.reply` / `message.send` / `message.media`（叠加项，发富媒体时额外需要）/ `message.recall`。

SDK 用法见 [`docs/sdk.md`](docs/sdk.md)，完整底层契约见 [`docs/plugin.md`](docs/plugin.md)。可跑的协议示例仍保留在 [`plugins/echo/index.js`](plugins/echo/index.js)。

## 目录

```
src/core/     协议层 token / api / routes / events / transport
              语义层 normalize / dedupe / pending / dispatch / throttle
              出站层 outbound（意图 → 协议） / media（上传） / errors（唯一分类点）
src/host/     manifest / supervisor（进程监督）/ ipc（JSON-RPC）/ registry
src/sdk/      Node.js / TypeScript 插件 SDK（插件侧协议实现）
src/types/    qq.ts —— 平台 payload 类型，只描述字段、不加工
plugins/echo/ 示例插件
scripts/      smoke.mjs、e2e.mjs、e2e/mock-qq.mjs（替身后端）
docs/         plugin.md —— 底层插件契约；sdk.md —— Node.js / TS SDK
```

## 设计文档

[`DESIGN.md`](DESIGN.md) 是设计依据：不变式、协议事实备忘、失效模式与每处「为什么这么选」。改动之前先看它。
