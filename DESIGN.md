# QQ Bot 极简内核 — 设计文档

> 最后更新：2026-09-22
> 协议依据：QQ 机器人官方文档 API v2（wiki 全站抓取，本地副本在 `%TEMP%\qbot2\`）

---

## 1. 定位

内核只做三件事：

1. **协议接入** — token 获取与刷新、Gateway 连接与恢复、REST 发送原语
2. **事件归一化** — 原始 payload → 统一 `InboundEvent`
3. **插件宿主** — 发现、启动、路由、隔离、崩溃恢复、资源回收

内核**不认识**「命令」「AI 回复」「菜单」「定时任务」「审核」这些概念。内核源码里不应该出现这些词。

---

## 2. 已锁定的决策

| # | 项 | 决定 |
|---|---|---|
| 1 | 语言 | TypeScript + Node.js |
| 2 | 插件形态 | 独立子进程，JSON-RPC over stdio |
| 3 | 核心边界 | 不内置 LLM/Agent 链路，不内置会话存储 |
| 4 | 协议层 | 自研 |
| 5 | MVP | 群 @ 消息 → 文本回复 |

---

## 3. 「零运行时依赖」的边界

| 层 | 现状 | 结论 |
|---|---|---|
| HTTP | Node 18+ 全局 `fetch` 已稳定 | 零依赖成立，用全局 `fetch` |
| WebSocket | Node 20.18 是否内置全局 `WebSocket` **待实测**（之前的探测被中断，尚未验证） | **唯一缺口** |

WebSocket 三选项：

- **(a) Node ≥ 22 用内置 `WebSocket`** — 保住零依赖。具体哪个子版本免 flag 需要在升级后实测，不凭记忆断言。
- **(b) 留在 Node 20 + `ws`** — 引入唯一运行时依赖。
- **(c) 自研最小 RFC6455 客户端** — 帧解析、掩码、分片、continuation frame、ping/pong，估 400~600 行，且有互操作风险。

**选择：把 WebSocket 关在 `WsTransport` 接口后面，先写 (a)/(b) 都能接的实现。** 启动时探测 `typeof globalThis.WebSocket`，有就用内置，没有则报错提示升级或装 `ws`。这个决定不影响任何上层代码，所以不阻塞其他工作。

---

## 4. 目录结构

```
icy/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── DESIGN.md
├── src/
│   ├── main.ts                 入口：读配置 → 聚合 intents → 启动 host        ~80 行
│   ├── config.ts               环境变量解析与校验（缺 AppID 直接退出）         ~70 行
│   ├── core/
│   │   ├── token.ts            TokenManager：缓存 + 单飞刷新 + 失效重取        ~90 行
│   │   ├── api.ts              QQApiClient：统一 request + 错误分类            ~110 行
│   │   ├── routes.ts           端点 builder（集中所有 path，不散落字符串）      ~40 行
│   │   ├── events.ts           opcode / intents / 事件名 / 关闭码常量           ~80 行
│   │   ├── transport.ts        WsTransport 接口 + 内置实现探测                ~60 行
│   │   ├── gateway.ts          WebSocket 状态机：Hello/Identify/心跳/Resume/退避 ~250 行
│   │   ├── normalize.ts        原始 payload → InboundEvent                    ~120 行
│   │   ├── dedupe.ts           msg_id/messageId 短期去重（TTL 缓存）            ~50 行
│   │   ├── pending.ts          被动回复窗口预登记（见 §7.4）                    ~90 行
│   │   ├── dispatch.ts         会话串行 + fanout 顺序 + 背压                   ~130 行
│   │   └── errors.ts           错误分类：token code / err_code / close code    ~70 行
│   ├── host/
│   │   ├── types.ts            插件契约类型定义（唯一对插件公开的 API 面）        ~120 行
│   │   ├── manifest.ts         plugin.json 解析与校验 + intents 聚合            ~90 行
│   │   ├── ipc.ts              JSON-RPC 2.0 over stdio，NDJSON 编解码          ~110 行
│   │   ├── supervisor.ts       子进程生命周期、超时、重启、quarantine          ~200 行
│   │   └── registry.ts         插件发现与能力索引                              ~80 行
│   └── types/
│       └── qq.ts               QQ 原始 payload 类型（只描述不加工）             ~150 行
├── plugins/
│   └── echo/                   示例插件（不属于内核）
│       ├── plugin.json
│       └── index.js
└── scripts/                    自检脚本（不属于内核，不参与构建）
    ├── smoke.mjs               进程内冒烟：直接 import dist，断言单元行为
    ├── e2e.mjs                 端到端：spawn dist/main.js 跑真实进程全链路
    ├── e2e/mock-qq.mjs         QQ 后端替身（HTTP + 手写 RFC6455 服务端）
    └── fixtures/               测试夹具
        ├── crasher/            握手后必崩，验证 restart / quarantine
        └── zombie/             握手后失联，验证健康检查
```

自检分两层，互不替代：`smoke.mjs` 覆盖单元语义（去重、窗口、归一化、关闭码映射），
`e2e.mjs` 覆盖只有真实进程才暴露的东西（token 单飞、WS 握手与心跳、事件下行、
被动回复上行、优雅关停顺序、致命关闭码退出）。两者都通过才算验证。

内核约 **1800 行**，其中真正的协议实现（`core/`）约 1200 行，插件宿主（`host/`）约 600 行。

---

## 5. 核心接口

### 5.1 TokenManager

```ts
interface TokenManager {
  /** 返回可用 token，内部负责缓存与刷新。并发调用只触发一次刷新。 */
  get(): Promise<string>;
  /** 收到 401 / 11241 / 11243 时调用，丢弃缓存并在下次 get() 重新获取。 */
  invalidate(): void;
}
```

要点：

- 官方文档：有效期内重复获取**返回同一个值**；在过期前 **60 秒**内获取会返回新值，且旧值这 60 秒内仍有效。
- 因此本地缓存到 `expires_at - 300s` 即可，重试窗口很宽裕。
- **失败时 HTTP 仍是 200**，成功与否看 body 的 `code`。
- token 永不外泄到插件进程 —— 插件只能通过 `host/*` 方法间接触发请求。

### 5.2 QQApiClient

```ts
interface QQApiClient {
  /** 发送群文本。 */
  sendGroupText(params: {
    groupOpenid: string;
    content: string;
    msgId?: string;    // 被动回复
    msgSeq?: number;   // 不传默认 1（不是 0）
  }): Promise<SendResult>;

  /**
   * 发送单聊文本。
   *
   * 与群聊共用 SendMessageBody，被动窗口约束也是同一套（5 分钟 / 最多 5 次），
   * 区别只在端点与定位字段：群聊用 groupOpenid，单聊用 userOpenid。
   * 这两个端点在平台侧完全隔离，文件与消息都不能跨场景使用。
   */
  sendC2CText(params: {
    userOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<SendResult>;

  /** 原始逃生舱，仅内核内部与受信任插件使用。 */
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
}
```

### 5.3 WsTransport

```ts
interface WsTransport {
  connect(url: string): Promise<void>;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
}
```

### 5.4 Gateway 状态机

```
idle → connecting → hello → identifying → ready → running
                        ↓                    ↓
                     closing ←──────── resuming
```

- 收到 `op=10 Hello` 拿 `heartbeat_interval`（实测值 45000ms）。
- `op=2 Identify`：`token: "QQBot {AccessToken}"`、`intents`（聚合自所有插件）、`shard: [0, 1]`（MVP 不分片）。
- 心跳 `op=1` 携带最新 `s`；首次为 `null`。
- 断线优先 `op=6 Resume`（带 `session_id` + 最新 `s`），补发完收到 `t="RESUMED"`。
- **退避：`[1000, 2000, 5000, 10000, 30000, 60000]` + jitter，最大 10 次。** 不要无延迟 `while(true)`。

关闭码处理表：

| 码 | 含义 | 处理 |
|---|---|---|
| 4001 / 4002 / 4010 / 4012 / 4013 / 4014 | 无效 opcode / payload / shard / version / intent / intent 无权限 | **不重连**，记致命错误退出 |
| 4006 | 无效 session | 丢弃 session，重新 Identify |
| 4007 | seq 错误 | 丢弃 seq，重新 Identify |
| 4008 | 发送过快 | 退避后重连 |
| 4009 | 连接过期 | 重新 Resume |
| 4900~4913 | 内部错误 | 重新 Identify |
| 4914 | 机器人已下架，只允许沙箱 | **不重连**，配置问题 |
| 4915 | 机器人已封禁 | **不重连**，需申诉 |

### 5.5 归一化

```ts
interface InboundEvent {
  kind: 'group' | 'c2c' | 'lifecycle' | 'unknown';
  eventType: string;          // 原始 t，例如 GROUP_AT_MESSAGE_CREATE
  eventId: string;            // payload 最外层 id
  seq: number;                // payload s

  messageId?: string;         // d.id，被动回复与撤回用
  senderId?: string;          // group 用 author.member_openid，c2c 用 author.user_openid
  senderName?: string;
  senderRole?: 'member' | 'admin' | 'owner';
  groupOpenid?: string;
  userOpenid?: string;
  content?: string;           // 群 @ 事件的 content 已自动去掉 @机器人前缀
  contentType?: number;       // message_type
  timestamp?: string;
  msgIdx?: string;            // 从 message_scene.ext 的 "msg_idx=" 解出
  refMsgIdx?: string;
  attachments?: Attachment[];

  raw: unknown;               // 永远保留
}
```

`message_scene.ext` 是 **`key=value` 格式的字符串数组**（不是对象），归一化时解析成 map。

**不要用 `content.startsWith("@bot")` 判事件类型** —— 群 @ 事件的 content 已经去掉前缀了。

---

## 6. 插件契约

### 6.1 manifest（`plugins/<name>/plugin.json`）

```json
{
  "name": "echo",
  "version": "0.1.0",
  "entry": "index.js",
  "intents": ["GROUP_AND_C2C_EVENT"],
  "events": ["GROUP_AT_MESSAGE_CREATE"],
  "capabilities": ["message.reply"],
  "priority": 100
}
```

要点：

- **`intents` 必须声明式** —— intents 是连接级参数（Identify 时一次性打包），而且传了无权限的 intents 会导致 Identify 后直接被关连接。所以核心启动时必须先扫完所有 manifest、聚合 intents、再建连。运行中**不能**动态加 intents（要重连）。
- `events` 用于路由，只有声明了才会收到该事件的 dispatch。
- `capabilities` 是最小权限模型的起点 —— 例如没声明 `message.reply` 的插件调用 `host/reply` 会被核心拒绝，而不是让它打到 OpenAPI 拿 `11253`。

### 6.2 IPC 帧格式

**JSON-RPC 2.0，NDJSON over stdio**（每行一个完整 JSON）。

硬约束：**插件的 stdout 只能出现协议帧**，任何日志必须走 stderr，否则污染协议流。核心在 supervisor 里对 stdout 做逐行解析，解析失败即判定插件异常。

**host → plugin**

| 方法 | 类型 | 参数 | 返回 |
|---|---|---|---|
| `lifecycle/init` | request | `{ config, bot: { id, username } }` | `{ ok: true }` |
| `lifecycle/shutdown` | request | `{ reason }` | `{ ok: true }` |
| `event/dispatch` | request | `{ event: InboundEvent, reply: ReplyHandle }` | `ReplyInstruction \| null` |
| `ping` | request | `{}` | `{ ok: true }` |

**plugin → host**

| 方法 | 类型 | 参数 | 说明 |
|---|---|---|---|
| `host/reply` | request | `{ handleId, text }` | 用预登记句柄回复，核心校验窗口与次数 |
| `host/send` | request | `{ target, text }` | 主动消息，需 `message.send` 能力且受频控 |
| `host/log` | notification | `{ level, message, fields? }` | 日志（也允许直接写 stderr） |
| `plugin/ready` | notification | `{ name, version }` | 就绪信号 |

### 6.3 生命周期

```
discovering → spawning → initializing → ready → running
                  ↑                        │
               restarting ←──── crashed ←──┘
                                            │
                                        stopping → stopped
```

| 阶段 | 超时 | 失败策略 |
|---|---|---|
| spawning | 5s | 标记 quarantined，不再重试 |
| initializing（等 `plugin/ready`） | 10s | SIGTERM → 5s → SIGKILL，重启一次 |
| 单事件 dispatch | 4.5min | 见 §7 被动窗口 |
| 健康检查（`ping`） | 15s | 判定无响应，SIGKILL 后按崩溃策略处理 |
| shutdown | 5s | SIGKILL |

**健康检查覆盖的是「进程活着但已经不能干活」这一种失败。** 插件退出有 exit 事件兜底，事件循环被卡死的插件却不会退出，只会安静地吞掉所有事件，从外面看状态一直是 `running`。

两个必须遵守的细节：

- **在途事件非 0 时跳过本次 ping。** 插件是单线程的，处理一条长事件时事件循环整个被占住，ping 必然超时 —— 那时掐进程是误杀，而且往往正好落在被动回复窗口里。
- **失败走与崩溃同一条路径**（kill → exit → 重启 / quarantine），不另立一套策略，否则两处决策会打架。

崩溃重启：指数退避；**60 秒内崩 3 次则 quarantine**，不再自动拉起，只在日志里报。

### 6.4 插件如何回消息（关键设计）

两条路：

1. **同步返回**（推荐）：`event/dispatch` 的返回值就是 `ReplyInstruction`，核心收到后立刻发。
2. **异步调用**：插件返回 `null`，稍后用 `host/reply` + `handleId` 回。

**被动回复窗口是真实风险**：群聊只有 **5 分钟、最多 5 次**，超了就是 `40034005` / `40034128`。AI 插件很可能处理很久，如果让插件自己拿着 `msg_id` 硬发，很容易撞墙。

**方案：核心在收到事件时立刻预登记 `ReplyHandle`。**

```ts
interface ReplyHandle {
  id: string;              // 内核内部 id，不是 msg_id
  target: { scope: 'group'; groupOpenid: string };
  msgId: string;           // 真正的 msg_id，只存在内核里
  expiresAt: number;       // now + 5min - 30s buffer
  remaining: number;       // 初始 5
  nextSeq: number;         // 递增，避免 40054005「消息被去重」
}
```

- 核心把 `ReplyHandle` 随 dispatch 一起给插件（只给 `id` 和 `expiresAt`，**不给 msg_id**）。
- 插件用 `host/reply` 时，核心校验 `expiresAt` 和 `remaining`，并且**由核心分配 `msg_seq`**。
- 窗口剩余不足 60s 时核心主动拒绝并返回结构化错误，而不是让请求打到 OpenAPI 拿 `40034005`。
- 事件处理完成后核心回收 handle。

这样插件的异步自由度和被动窗口的硬约束就解耦了。

**群聊与单聊共用同一套句柄机制**，区别只在目标定位字段：句柄内部持有 `{ scope: 'group', groupOpenid }` 或 `{ scope: 'c2c', userOpenid }`，发送时分流到 `/v2/groups/{gid}/messages` 与 `/v2/users/{uid}/messages`。插件只知道 `handleId`，不知道目标是什么，也改不了它 —— 插件自报的 `scope` 只用于拦截明显非法的取值。

**单聊的被动窗口约束与群聊一致**（同样是 5 分钟 / 最多 5 次），因此 `msg_id` 与 `msg_seq` 的维护逻辑不需要两套。

### 6.5 背压

- 每个插件一个有界队列（默认 64）。满了**丢弃最旧**并记日志，不阻塞其他插件。
- 同一插件的事件并发度默认 1（保序），manifest 可声明 `concurrency` 提升。
- 慢插件不会拖慢其他插件 —— fanout 是并发投递。

---

## 7. 事件路由与并发

### 7.1 去重

键：`${eventType}:${messageId}`，TTL 60s。

注意官方文档把 `msg_seq` 也列进去重考量（「相同 msg_id 可能多次推送，需结合 msg_seq 做去重」），但它同时又是**回复**的序号 —— 两者语义不同，不要混用同一个字段。核心的去重键用 `eventType + messageId`，回复的 `msg_seq` 由 §6.4 的 handle 单独维护。

### 7.2 会话串行

```ts
function conversationKey(e: InboundEvent): string {
  switch (e.kind) {
    case 'group': return `qq:group:${e.groupOpenid}`;
    case 'c2c':   return `qq:c2c:${e.userOpenid}`;
    default:      return `qq:event:${e.eventId}`;
  }
}
```

同一会话内的事件**串行**处理，不同会话并行。否则两个用户的消息可能同时改写同一个流式消息或打乱上下文顺序。

### 7.3 fanout

多插件订阅同一事件时：按 `priority` 升序（数值小者先）调用。MVP 只做「第一个返回非 null 的插件胜出」（`ReplyInstruction` 只有一个，不能让两个插件都回）。**这个语义要在文档里写清楚**，否则插件作者会困惑。

---

## 8. 错误模型与可观测性

三层错误，**绝不能混**：

| 层 | 判定依据 | 陷阱 |
|---|---|---|
| Token 接口 | HTTP 200 + body `code` | 失败时 HTTP 仍是 200 |
| OpenAPI | HTTP 状态码 + body `err_code`（成功为 0） | `message` 文案会变，**不能用来判错** |
| WebSocket | 关闭码 | 见 §5.4 |

- **`trace_id` 必须透传**：OpenAPI 响应 body 有 `trace_id`，响应头有 `X-Tps-trace-ID`。核心记录到日志并按事件维度归因，插件里的报错能追回原始事件。
- 日志分级 + stdout/stderr 分离：内核自身日志走 stderr；插件日志带 `plugin=<name>` 前缀。
- AppSecret、access_token **永不进日志**（config 层做一次性脱敏封装）。

---

## 9. 配置

```bash
QQ_APP_ID=          # 必填
QQ_APP_SECRET=      # 必填
LOG_LEVEL=info
PLUGIN_DIR=./plugins
```

- `.env` 进 `.gitignore`；提供 `.env.example` 作为模板。
- 生产环境用真实环境变量覆盖，不读 `.env`。
- 启动时校验：缺 `QQ_APP_ID` 直接退出并打印明确信息。

---

## 10. 分阶段实施

| 阶段 | 目标 | 验证手段 |
|---|---|---|
| **P0** | 工程骨架 | `npx tsc --noEmit` 通过 |
| **P1** | 拿 token | `GET /users/@me` 返回机器人自己的 id |
| **P2** | 连上 Gateway | 日志出现 `READY` 与 `session_id` |
| **P3** | 收到群 @ 消息 | 在群里 @ 机器人，日志打印归一化后的 `InboundEvent` |
| **P4** | 发出第一条被动回复 | 群里 @ 机器人，收到文本回复 |
| **P5** | 插件宿主 | echo 插件跑通，且杀掉插件进程后能看到自动重启 |
| **P6** | 加固 | 断网重连、重复事件去重、关闭码分支、崩溃 quarantine |

**注意**：P3 之前必须先在 QQ 开放平台申请 `GROUP_AND_C2C_EVENT (1<<25)` 权限，否则 Identify 后会被直接关连接（`4014`）。

---

## 11. 待拍板

1. ~~**Node 版本 / WebSocket 方案**~~ —— **已收口**：Node v24.21.0 实测 `typeof globalThis.WebSocket === 'function'`，方案 (a) 成立，「零运行时依赖」保持。`core/transport.ts` 启动即探测，缺失直接退出，不做静默降级。
2. **插件语言** —— 目前按「子进程 + stdio」，理论上可以多语言。是否**允许 C++/多语言插件**？如果只允许 JS，supervisor 可以少一层适配；如果允许多语言，IPC 就必须严格语言无关（当前设计已经是）。
3. **插件沙箱** —— 子进程隔离了崩溃，但**没有隔离权限**（插件仍能读文件、发网络请求）。要不要做真沙箱（Node 权限模型 / 容器）？我倾向 MVP 不做，但要在文档里明说。
4. **fanout 语义** —— 是「第一个返回非 null 的胜出」，还是「所有插件都能发消息」？我按前者设计（更符合「被动回复只有一条」的现实）。

---

## 12. 协议事实备忘（已核实）

```text
token     POST https://api.bot.qq.com/app/getAppAccessToken   body {appId, clientSecret}
          成功 {access_token, expires_in:"7200"}；失败 HTTP 200 + body.code
gateway   GET  /gateway          → wss://api.bot.qq.com/websocket/
鉴权头     Authorization: QQBot {ACCESS_TOKEN}
发群消息   POST /v2/groups/{group_openid}/messages
发单聊消息 POST /v2/users/{user_openid}/messages
被动回复   群聊与单聊同为 5 分钟 / 最多 5 次；msg_seq 不填默认 1
```

域名已在 20260810 统一为 `api.bot.qq.com`。
