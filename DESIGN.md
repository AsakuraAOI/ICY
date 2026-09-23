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
| WebSocket | Node v24.21.0 实测 `typeof globalThis.WebSocket === 'function'`（见 §11.1） | 零依赖成立，用内置实现 |

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

上面树里的行数标注（`~80 行` 等）是设计初期的估计，已全面过时（`src/main.ts` 实际 381 行，`src/host/supervisor.ts` 实际 827 行），只保留模块划分示意，不要当作工作量参考。

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
- **重试范围收窄**：只有平台明确标注的限流码（`100001`）与网络层失败才重试（默认最多 3 次，退避 `[500, 1500]`ms）。配置类错误码（`100007` appid invalid / `100016` invalid appid or secret / `10004` 机器人不存在）**立即失败**，并把处置建议拼进错误消息 —— 否则日志里只剩一串 code，使用者唯一能做的事就是反复重启，而配置写错重启一万次也还是错。

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

  /**
   * 撤回群消息。发送超过 2 分钟不可撤回。
   *
   * 成功返回 HTTP 200 且**无响应体**，所以返回 void —— 调用方不能假设拿得到回执。
   * 权限分两档：机器人是群管理员时可撤回自己的消息与普通成员的消息；普通成员身份下
   * 只能撤回自己发送的。内核不替插件判断这一档，越权会被平台拒绝（40062003）。
   */
  recallGroupMessage(params: { groupOpenid: string; messageId: string }): Promise<void>;

  /** 撤回单聊消息。只能撤回机器人自己发出的，同样受 2 分钟限制。 */
  recallC2CMessage(params: { userOpenid: string; messageId: string }): Promise<void>;

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
- **重连打满上限是致命错误，不是「安静地停下」。** 此时连接没了、插件还在跑，进程既不收事件也不退出，从外面看像正常运行 —— 比直接崩溃更难发现。必须走致命路径（`onFatal`），由 `main.ts` 决定退出码并回收插件进程。

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
  mentions?: QQUser[];        // 消息里 @ 的其他用户，不含机器人自身（仅群消息）
  arkData?: ARKData;          // message_type=3 结构化卡片
  msgElements?: MsgElement[]; // message_type=103（引用消息）的嵌套内容

  raw: unknown;               // 永远保留
}
```

`message_scene.ext` 是 **`key=value` 格式的字符串数组**（不是对象），归一化时解析成 map。

`mentions` / `arkData` / `msgElements` 与 `attachments` 一样属于**契约字段**：插件直接从 `InboundEvent` 读到，不需要去翻 `raw`。`raw` 的角色是逃生舱，只用于平台新增、尚未纳入契约的字段 —— **它不该成为获取已知内容的唯一途径**。

**`d` 不保证是对象。** payload 来自网络，协议演进、灰度、内部错误都可能让它变成 `null`、数组或标量。归一化对这种输入只做一件事：**降级为不透明事件并保留 `raw`**，绝不对它取属性 —— 那会抛 `TypeError`，而异常会顺着 WebSocket 的 `message` 监听冒出去，直接终结整个进程。消息类事件降级后 `kind` 为 `unknown`，因此没有被动回复窗口（本来也没有 `msg_id` 可回）；非消息事件保持原有分类，不把「事件分类」和「payload 形状」两件事混在一起。

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
- `capabilities` 是最小权限模型的起点 —— 例如没声明 `message.reply` 的插件调用 `host/reply` 会被核心拒绝，而不是让它打到 OpenAPI 拿 `11253`。取值 `message.reply` / `message.send` / `message.media` / `message.recall`；其中 `message.media` 是**叠加**的：发富媒体既要有 reply/send，也要单独声明它，因为那会让内核替插件去下载任意 URL、并向第三方预签名地址发 PUT（见 §6.6）。
- **多语言插件**（§11 已拍板）—— manifest 增加可选 `runtime: { command, args? }`，内核只做 `spawn(command, [...args, entry])`：`command` 走 PATH 或绝对路径，`args` 接在 entry 之前。缺省仍是 `process.execPath`，纯 JS 插件零配置不变。IPC 本就语言无关（JSON-RPC 2.0 / NDJSON over stdio），所以多语言的代价只在启动方式，不在协议。TypeScript 用 Node 原生类型擦除，`"entry": "index.ts"` 即可（Node ≥ 22.6 需 `--experimental-strip-types`，Node ≥ 24 默认开启）。
- **不做沙箱**（§11 已拍板，当前无规划）—— `runtime` 不是安全边界：插件进程与内核同权限，能读写文件、发起网络请求。需要隔离请自己在 `command` 外面套一层（容器、独立用户），内核不内置。文档必须明写这一点，否则作者会误以为有沙箱。
- **`config` 是插件私有配置的唯一入口** —— 内核只校验它是 JSON 对象，不解释内容（schema 归插件自己管），并在 `lifecycle/init` 时原样下发。反向红线不变：**内核配置永不下发**，`AppSecret` 与 `access_token` 只存在于内核进程内。

### 6.2 IPC 帧格式

**JSON-RPC 2.0，NDJSON over stdio**（每行一个完整 JSON）。

硬约束：**插件的 stdout 只能出现协议帧**，任何日志必须走 stderr，否则污染协议流。核心在 supervisor 里对 stdout 做逐行解析，解析失败即判定插件异常。

**`host/send`（主动消息）必须在内核侧频控**：被动回复有平台窗口兜底，超了只是那一条失败；主动消息没有这层保护，一个写错的插件可以在几秒内把机器人打到限流甚至封禁。策略是滑动窗口（默认单会话 4 条 / 全局 20 条 / 每 60 秒），拒绝时返回结构化结果 `{ ok: false, detail: 'rate_limited:...' }`，插件可以据此排队重试。**闸门必须在请求发出之前**，否则限流错误已经打到平台了。

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
| `host/reply` | request | `{ handleId, body: OutboundMessage }` | 用预登记句柄回复，核心校验窗口与次数 |
| `host/send` | request | `{ scope: 'group', groupOpenid, body }` 或 `{ scope: 'c2c', userOpenid, body }` | 主动消息，需 `message.send` 能力；**由内核侧频控**，被拒时返回 `rate_limited:*` |
| `host/recall` | request | `{ scope: 'group', groupOpenid, messageId }` 或 `{ scope: 'c2c', userOpenid, messageId }` | 撤回消息，需 `message.recall` 能力；`messageId` 来自 `host/reply` / `host/send` 的成功返回 |
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

1. **同步返回**（推荐）：`event/dispatch` 的返回值就是 `{ scope, body }`（`body` 见 §6.6），核心收到后立刻发。
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
- **handle 活到窗口关闭，不在单次事件处理结束时回收。** 异步回复路径（`dispatch` 返回 `null`，稍后用 `host/reply`）依赖它，提前回收会把这条自由度掐死。回收统一交给 `sweep()`。
- **只为有订阅者的事件登记 handle。** 没有插件订阅的消息事件若照样登记，句柄会一直堆到窗口关闭；句柄上限（默认 5000）一到就淘汰最旧的，而被淘汰的可能正是别的会话里仍在等待 `host/reply` 的句柄 —— 插件拿到 `unknown_handle`，原因却和它自己的行为无关。

这样插件的异步自由度和被动窗口的硬约束就解耦了。

**群聊与单聊共用同一套句柄机制**，区别只在目标定位字段：句柄内部持有 `{ scope: 'group', groupOpenid }` 或 `{ scope: 'c2c', userOpenid }`，发送时分流到 `/v2/groups/{gid}/messages` 与 `/v2/users/{uid}/messages`。插件只知道 `handleId`，不知道目标是什么，也改不了它 —— 插件自报的 `scope` 只用于拦截明显非法的取值。

**单聊的被动窗口约束与群聊一致**（同样是 5 分钟 / 最多 5 次），因此 `msg_id` 与 `msg_seq` 的维护逻辑不需要两套。

### 6.5 背压

- 每个插件一个有界队列（默认 64）。满了**丢弃最旧**并记日志，不阻塞其他插件。
- **排序由会话链负责，不由并发度负责。** 同一会话的事件由 `dispatch.ts` 的会话链串行化（见 §7.2），`concurrency` 只是「一个插件同时处理几条事件」的上限（默认 8）。把它设成 1 会让所有会话被串成一条线，一个慢群卡住全部 —— 这正是 §7.2 要避免的。
- 默认值**只在 `core/dispatch.ts` 定义一份**（`DEFAULT_CONCURRENCY` / `DEFAULT_QUEUE_LIMIT`），manifest 只做透传。两侧各写一份默认值曾经造成分歧：Dispatcher 的 8 被 manifest 的 1 静默覆盖，真实插件全部退化成串行，而单测因为直接构造端点根本发现不了。
- 慢插件不会拖慢其他插件 —— fanout 是并发投递。

### 6.6 出站消息模型（为什么不是「一段文本」）

最初的发送原语只有 `sendGroupText` / `sendC2CText`，插件能表达的只有纯文本。补全发送能力时没有走「再加十几个 `sendXxx` 方法」的老路，而是分了三层，理由是**平台本来就只有一条发送链路**：

```text
插件层       OutboundMessage（kind: text/markdown/ark/embed/media/typing）
                  ↓  host/reply · host/send · event/dispatch 同步返回
出站编排     core/outbound.ts —— 唯一的 msg_type 拼装点；富媒体在这里「先上传再发」
                  ↓
协议层       core/api.ts（两个通用原语）+ core/media.ts（上传）+ core/routes.ts（路径）
```

- **协议层只剩两个通用原语**：`sendGroupMessage` / `sendC2CMessage`，接受任意 `SendMessageBody`。文本、Markdown、ARK、Embed、输入状态、富媒体全部经由它们出去，区别只在 `msg_type`。`sendGroupText` 之类只是便捷写法，底层不再有第二套实现。
- **`msg_type` 不出现在插件契约里。** 插件说 `{ kind: 'markdown' }`，内核填 `msg_type: 2`。这既让插件不必跟着平台字段走，也让「没有 `/ark` 端点」这件事在内核里只表达一次。
- **富媒体的两条协议收在一个地方**：`kind: 'media'` 由 `core/outbound.ts` 翻译成「上传 → `file_info` → `msg_type: 7`」。URL 模式只是把地址交给平台；本地模式（`data` / `localPath`）才走 `upload_prepare` + 分片，整传与分片的 5 MiB 边界、`upload_id`、`presigned_url`、`file_info` 全部不下放 —— 插件只交出一个来源。
- **ARK / Embed 按确定的形状建模**，不用 `[key: string]: unknown` 假装「支持完整协议」。ARK 是 `template_id` + `kv[] → { key, value?, obj[] → { obj_kv[] } }`，Embed 是 `title / prompt / thumbnail / fields`。平台将来新增字段时走 `request` 逃生舱或按真实协议扩类型，而不是先把类型松开。
- **本地上传失败有自己的错误分类**：`MediaUploadError` 带 `stage`（source / decode / hash / prepare / part_upload / part_finish / complete），`describeSendFailure` 把它翻译成 `media_upload`。但**平台错误原样抛 `ApiError`** —— 把它包成 MediaUploadError 会让 `window_expired` / `auth_failed` 这类分类整个失效。
- **能力单独一档**：`message.media` 与 `message.reply` 分开，因为 media 会让内核去下载插件给的任意 URL、并向第三方预签名地址发 PUT。同步返回路径与 `host/reply` 走同一套检查，不能靠「直接返回」绕过。
- **形状校验前移**：`kind` 未知、`media` 既无 `url` 又无 `data`、`fileType=4` 缺 `fileName` 都在发送之前挡掉，而不是等平台回一个没有语义的错误码。
- **`typing` 的会话限制在内核判定**：`msg_type: 6` 只有单聊有，而判定它是「哪个会话」需要内核手里的 handle —— 所以这个检查放在 `pending.ts` 的 `resolve()` 里，插件自报的 `scope` 不作数。

`IPC_PROTOCOL_VERSION` 当时从 1 升到 2：`{ text }` → `{ body }` 是破坏性变更，一个按 v1 写的插件会以为自己发的文本仍然有效。当前 v3 在公开回复句柄中增加 `acceptBefore`，让异步处理方使用内核实际执行的提前拒绝时刻。

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
- **不可信输入不得逃逸出处理边界**：事件回调（归一化 → 去重 → 路由）与 READY 解析都在 Gateway 侧被 `try/catch` 兜住，失败按「记日志 + 丢弃该条」处理。理由是同一条异常链路 —— 事件源是外部输入，一条坏帧不能带走整条连接，更不能带走进程；而进程一旦退出，插件子进程会变成孤儿。
- **进程生命周期要有兜底**：`uncaughtException` / `unhandledRejection` 走关停而不是带崩退出；关停本身带看门狗（20s），到点强制退出。插件是子进程，内核消失不会带走它们 —— 唯一的可靠性来自「退出前一定回收」和「卡住时一定放弃」。启动后期失败（如换取 Gateway 接入点返回 500）同样必须先 `stopAll()` 再退出，否则留下一批没有父进程、也没人会去杀的孤儿。
- **所有对外请求都必须带超时**（token / Gateway 接入点 / OpenAPI）。没有超时的 `fetch` 在网络卡住时会静默挂死整个启动流程 —— 没有日志、没有错误、没有任何可观测信号，比直接失败更难排查。

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
2. ~~**插件语言**~~ —— **已拍板：允许多语言，尤其是 TypeScript**。manifest 增加可选 `runtime: { command, args? }`，内核只做 `spawn(command, [...args, entry])`；缺省仍是 `process.execPath`，即纯 JS 插件零配置不变。IPC 契约本就语言无关（JSON-RPC 2.0 / NDJSON over stdio），所以多语言的代价只在启动方式与文档，不在协议。
3. ~~**插件沙箱**~~ —— **已拍板：不做**（当前无规划）。子进程只隔离崩溃，**不隔离权限**：插件仍能读写文件、发起网络请求，文档必须明写这一点，避免作者误以为有沙箱。若将来需要，以插件形式实现，内核不内置。
4. ~~**fanout 语义**~~ —— **已收口**：按 `priority` 升序调用，第一个返回非 `null` 的胜出。§7.3 与 `docs/plugin.md` §7 已把它写成契约，`core/dispatch.ts` 已实现。

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
撤回群消息 DELETE /v2/groups/{group_openid}/messages/{message_id}
撤回单聊   DELETE /v2/users/{user_openid}/messages/{message_id}
撤回窗口   发送超过 2 分钟不可撤回；成功 HTTP 200 且无响应体
```

### 12.1 消息类型与载荷字段（官方 Node SDK 当前实现）

**所有会话消息都归一到 `POST .../messages`**，区分只在 body 的 `msg_type`。**不存在** `/ark`、`/embed`、`/keyboard` 这类独立端点：

```text
msg_type = 0 → content          文本
msg_type = 2 → markdown         内置 Markdown
msg_type = 3 → ark              ARK 卡片（template_id + kv[] → key / value / obj[] → obj_kv[]）
msg_type = 4 → embed            Embed（title / prompt / thumbnail / fields）
msg_type = 6 → input_notify     C2C 输入状态（不是媒体！只有单聊有）
msg_type = 7 → media            富媒体（必须先上传拿 file_info）
```

`keyboard` 与 `message_reference` 不是接口，只是同一份 body 上的字段，可与任意消息类型共存。

### 12.2 富媒体上传链路

**两条上传协议，不要混：**

```text
A. URL 模式（服务端拉取）
   POST /v2/{users|groups}/{id}/files   body { file_type, url, srv_send_msg: false }
   → 平台自己下载那个公网地址。Bot 不碰文件内容，因此这条路径与「大文件分片」无关。

B. 本地模式（Bot 侧上传）
   小内容：POST /v2/{users|groups}/{id}/files   body { file_type, file_data, [file_name] }
   大内容：POST /v2/{users|groups}/{id}/upload_prepare
             body { file_type, file_name, file_size, md5, sha1, md5_10m }
             ↓ { upload_id, block_size, parts:[{index, presigned_url}], concurrency?, retry_timeout? }
           PUT {presigned_url}   原始二进制；**不能带 QQ Bot Authorization**（COS 预签名自带签名）
           POST /v2/{users|groups}/{id}/upload_part_finish
             body { upload_id, part_index, block_size, md5 }
             最后一片的 block_size 必须是实际上传长度
             ↓ 全部分片传完
           POST /v2/{users|groups}/{id}/files   body { upload_id }   ← 没有独立的 /complete_upload
             ↓ { file_uuid, file_info, ttl }
           POST .../messages   body { msg_type: 7, media: { file_info } }
```

- `file_type`：1 图片 / 2 视频 / 3 语音 / 4 文件；`4` 需要 `file_name`。
- 官方 SDK 以 **5 MiB** 为本地模式整传与分片的边界；这个判断收在 `core/media.ts`，不下放插件。
- **分片字节范围由 `part.index` 决定**：`offset = (index - 1) * block_size`。不按 `parts` 数组位置推断，也不靠排序 —— 服务器乱序返回也必须切对。上传前用 `validateParts()` 校验（index 为正整数、不重复、offset 不越界、不缺片）：错误的 offset 会**静默上传错误的字节**，比直接失败糟糕得多。
- **并发度**取 `upload_prepare` 的 `concurrency`，本地上限 `MAX_CONCURRENT_PARTS = 10` —— 不无限信任服务端返回值（一个错误的 concurrency 会瞬间打出上百个并发 PUT）。
- **内存行为随来源不同**：base64 / Buffer 必然常驻内存；`localPath` 用 `createReadStream` 流式扫描算摘要、分片按 `offset/length` 随机读取，全程不整体加载；`url` 完全不持有内容。
- 单聊与群聊的上传接口**不互通**：同一个 `file_info` 不能跨场景使用。

### 12.3 入站与出站不是镜像

`msg_elements` / `mentions` / `ark_data` 是**入站事件**的形状，不能原样提交回发送接口 —— 官方发送 API 并不接受这种反向复用。因此内核不提供 `sendMsgElements()`：`InboundEvent.arkData` 与 outbound 的 `ark` 只存在语义对应，**不共用 raw 类型**。

域名已在 20260810 统一为 `api.bot.qq.com`。
