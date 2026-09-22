# 插件作者指南

内核与插件之间**只有 IPC**：JSON-RPC 2.0，NDJSON over stdio。插件进程不认识内核的任何类型，也不该 `import` 内核代码。本文是插件作者需要的全部契约；设计依据见 `DESIGN.md` §6。

## 1. 目录与 manifest

```
plugins/<name>/
├── plugin.json
└── index.js        入口文件名由 entry 指定
```

```json
{
  "name": "echo",
  "version": "0.1.0",
  "entry": "index.js",
  "intents": ["GROUP_AND_C2C_EVENT"],
  "events": ["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"],
  "capabilities": ["message.reply"],
  "config": { "prefix": "echo" },
  "priority": 100
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 字母数字与 `_ - .`，全局唯一 |
| `version` | 是 | 只用于日志与就绪比对 |
| `entry` | 是 | 必须位于插件目录内；`..` 与绝对路径会被拒绝 |
| `intents` | 是 | **连接级参数**，见下 |
| `events` | 否 | 订阅的事件名；不在已声明 intents 覆盖范围内的会被启动校验拒绝 |
| `capabilities` | 否 | 能力白名单；未声明的调用会被内核拒绝 |
| `config` | 否 | 插件私有配置，经 `lifecycle/init` 原样下发 |
| `priority` | 否 | 数值小者先被调用，默认 100 |
| `concurrency` | 否 | 同时处理几条事件，默认 8 |
| `queueLimit` | 否 | 队列上限，满了丢最旧，默认 64 |

`intents` 是连接级参数：内核在 Identify 时一次性打包，运行中改不了。传了无权限的 intent 会让连接在 Identify 后立刻被关闭（关闭码 4014）。**写错的 manifest 会让内核直接启动失败，不会静默跳过你的插件** —— 一个错误的 intent 影响的是整条连接，跳过只会让问题更难定位。

## 2. 进程约束

- **stdout 只能出现协议帧。** 日志、调试输出、第三方库 banner 一律走 stderr。内核逐行解析 stdout，遇到非 JSON 行即判定协议污染，立刻 SIGKILL 并按崩溃处理。
- 单行帧上限 8 MB，超长同样判定污染。

## 3. 生命周期

内核调用（host → plugin）：

| 方法 | 参数 | 返回 | 超时 |
|---|---|---|---|
| `lifecycle/init` | `{ protocolVersion, config, bot: { id, username? } }` | `{ ok: true, version? }` | 与 ready 合计 10s |
| `lifecycle/shutdown` | `{ reason }` | `{ ok: true }` | 5s |
| `event/dispatch` | `{ event, reply }` | `ReplyInstruction \| null` | 4.5min |
| `ping` | `{}` | `{ ok: true }` | 15s |

`init` 回 `ok: true` 之后，插件必须主动发一行通知：

```json
{"jsonrpc":"2.0","method":"plugin/ready","params":{"name":"echo","version":"0.1.0","protocolVersion":1}}
```

`protocolVersion` 与内核不一致时，内核只记警告，不拒绝加载。

`ping` 是健康检查，默认 30 秒一次。**它不能用来判断「插件忙」**：处理事件时事件循环会被占住，内核在途事件非 0 时会跳过该次检查，所以正常的长任务不会被误杀；但事件循环被彻底卡死（同步死循环、阻塞 IO）会被判为无响应并 SIGKILL，随后按崩溃处理。

## 4. 事件与回复

```ts
interface DispatchParams {
  event: InboundEvent;            // 见 DESIGN.md §5.5
  reply: PublicReplyHandle | null; // null 表示本事件没有被动回复窗口
}

interface PublicReplyHandle {
  handleId: string;   // 内核内部 id，不是 msg_id
  expiresAt: number;  // 窗口关闭时刻（毫秒），已减去 buffer
  remaining: number;  // 还允许回几次，仅供参考
}
```

**插件拿不到 `msg_id`，也决定不了 `msg_seq`。** 被动回复有平台硬约束（群聊与单聊同为 5 分钟 / 最多 5 次），让插件拿着 `msg_id` 硬发很容易撞墙 Put。内核在收到事件时立刻预登记句柄；窗口剩余不足 60 秒时提前拒绝并返回结构化错误，而不是让请求打到平台拿 `40034005`。

两条回复路径：

1. **同步返回**（推荐）：`event/dispatch` 直接返回 `{ scope, content }`，内核立刻发。
2. **异步调用**：返回 `null`，稍后用 `host/reply` + `handleId` 回。

```json
{"jsonrpc":"2.0","id":3,"method":"host/reply","params":{"handleId":"h1","text":"处理完了"}}
```

`scope` 必须与事件场景一致（群事件 `group`，单聊事件 `c2c`）。但**它只是自述**：真正的目标由内核持有的句柄决定，插件改不了。

## 5. 主动消息

```ts
callHost('host/send', { scope: 'group', groupOpenid: '...', text: '...' });
callHost('host/send', { scope: 'c2c', userOpenid: '...', text: '...' });
```

需要声明 `message.send`。主动消息受**内核侧滑动窗口频控**（默认单会话 4 条 / 全局 20 条 / 每 60 秒，可用 `QQ_SEND_PER_CONVERSATION` / `QQ_SEND_GLOBAL` / `QQ_SEND_WINDOW_MS` 调整），超限时返回 `{ ok: false, detail: "rate_limited:..." }`。

被动回复有平台窗口兜底，主动消息没有 —— 一个写错的插件可以在几秒内把机器人打到限流甚至封禁。所以这个闸门在内核里，插件绕不过去，也别指望在插件侧自己限流。

## 6. 能力

| 能力 | 允许的调用 |
|---|---|
| `message.reply` | `host/reply` |
| `message.send` | `host/send` |

未声明的能力会被内核以 JSON-RPC error `-32000`（`HOST_REJECTED`）拒绝，不会打到 OpenAPI。

## 7. fanout 语义（重要）

多个插件订阅同一事件时：**按 `priority` 升序（数值小者先）依次调用，第一个返回非 `null` 的插件胜出，其后的插件根本不会被调用。**

被动回复只有一条，不能让两个插件都回。若你的插件需要「无论别人回没回都要做点什么」，应该走 `host/send`（主动消息），而不是依赖返回值。

## 8. 并发与顺序

- **同一会话内串行**：前一条处理完（`dispatch` 返回）之前，后一条不会开始。会话键是 `qq:group:{group_openid}` 或 `qq:c2c:{user_openid}`。
- **不同会话并行**，默认单插件同时最多处理 8 条事件。所以**不要假设「同一时刻只有一条事件在跑」** —— 模块级可变状态会暴露竞态。
- 队列满（默认 64）时**丢弃最旧**的事件并记日志，不阻塞其他插件。
- 慢插件不会拖慢其他插件：fanout 是并发投递。

## 9. 失败原因（稳定枚举）

`host/reply` / `host/send` 的失败是结构化结果，不是 JSON-RPC error。`reason` 是稳定枚举：

| `reason` | 含义 | 建议 |
|---|---|---|
| `unknown_handle` | 句柄未知或已回收 | 放弃 |
| `expired` | 窗口已关闭 | 放弃 |
| `window_closing` | 剩余不足 60 秒，内核提前拒绝 | 放弃 |
| `exhausted` | 5 次额度用尽 | 放弃 |
| `empty_text` | 内容为空 | 修正后重试 |
| `window_expired` | 平台判定窗口过期 | 放弃 |
| `duplicate_msg_seq` | `msg_seq` 重复（内核已维护，正常不出现） | 放弃 |
| `not_group_member` / `muted` | 机器人不在群 / 被禁言 | 放弃 |
| `auth_failed` | 凭证失效（内核会自动重取一次） | 可重试 |
| `network` | 网络或超时 | 可退避重试 |
| `unknown` | 未分类 | 记日志 |

**不要解析平台的 `err_code`，也不要依赖 `message` 文案** —— 两者都可能随时变。按上表的 `reason` 分支即可。

## 10. 崩溃与隔离

| 场景 | 处理 |
|---|---|
| spawn 失败 | 隔离，不重试 |
| 初始化（`init` + `ready`）失败 | SIGTERM → 5s → SIGKILL，重启一次；再失败即隔离 |
| running 期崩溃 | 指数退避重启；**60 秒内崩 3 次即隔离** |
| 协议流污染（stdout 出现非 JSON 行） | 立刻 SIGKILL，按崩溃处理 |
| `ping` 无响应 | 同上 |

被隔离的插件**不再自动拉起**，只在日志里报。写插件时请把崩溃当成必须避免的事故，而不是依赖内核反复重启。

## 11. 参考实现

`plugins/echo/index.js` 是完整可跑的最小示例，覆盖握手、`plugin/ready`、同步回复、异步 `host/reply`、主动 `host/send`、stdout/stderr 分离。从它改名开始写最省事。
