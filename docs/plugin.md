# 插件作者指南

内核与插件之间**只有 IPC**：JSON-RPC 2.0，NDJSON over stdio。插件进程不认识内核的任何类型，也不该 `import` 内核代码。本文是插件作者需要的全部契约；设计依据见 `DESIGN.md` §6。

## 1. 目录与 manifest

```
plugins/<name>/
├── plugin.json
└── index.js        入口文件名由 entry 指定（.ts 或别的语言都行，见 §1.1）
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
| `capabilities` | 否 | 能力白名单，取值 `message.reply` / `message.send` / `message.media` / `message.recall`；未声明的调用会被内核拒绝 |
| `config` | 否 | 插件私有配置，经 `lifecycle/init` 原样下发 |
| `priority` | 否 | 数值小者先被调用，默认 100 |
| `concurrency` | 否 | 同时处理几条事件，默认 8 |
| `queueLimit` | 否 | 队列上限，满了丢最旧，默认 64 |
| `runtime` | 否 | 多语言启动方式 `{ command, args? }`；缺省用内核自带的 Node 直接跑 `entry`，见 §1.1 |

`intents` 是连接级参数：内核在 Identify 时一次性打包，运行中改不了。传了无权限的 intent 会让连接在 Identify 后立刻被关闭（关闭码 4014）。**写错的 manifest 会让内核直接启动失败，不会静默跳过你的插件** —— 一个错误的 intent 影响的是整条连接，跳过只会让问题更难定位。

### 1.1 运行方式：多语言与 TypeScript

内核不关心插件用什么语言写。它只做一件事：`spawn(command, [...args, entry])`。缺省 `command` 是内核自己的 Node（`process.execPath`），所以纯 JS 插件零配置。要换运行时就在 manifest 里写 `runtime`：

```json
{
  "name": "ts-echo",
  "entry": "index.ts",
  "runtime": { "command": "node", "args": ["--experimental-strip-types"] }
}
```

`command` 可以是裸命令名（走 `PATH`）或绝对路径。**不要自己把 entry 写进 `args`** —— 内核已经把它接在参数列表最后，重复写会变成两个入口参数。

**TypeScript**：Node 自带类型擦除，不需要任何构建步骤，`.ts` 直接跑。

| Node | 写法 |
|---|---|
| ≥ 23.6（含 24） | 不写 `runtime`，`"entry": "index.ts"` 即可（类型擦除已默认开启） |
| 22.6 – 23.5 | `"runtime": { "command": "node", "args": ["--experimental-strip-types"] }` |

显式写这个 flag 在两端都能跑 —— 已默认开启的版本照常接受它。所以想省事就直接在 manifest 里写死，不必探测 Node 版本。

三个坑：

- 只能用**可擦除语法**：类型注解、`interface`、`type`、`as`、`import type` 都可以；`enum`、`namespace`、构造函数参数属性（`constructor(public x: number)`）不行 —— 要么改写，要么加 `--experimental-transform-types`（那个会真正生成代码）。踩中时报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
- 相对导入必须写**真实扩展名**：`import { x } from './util.ts'`。写 `./util.js` 或 `./util` 都解析不到 —— 类型擦除只删类型，不做路径重写。
- 因此如果你给自己的插件配了 `tsconfig.json` 做检查，需要开 `allowImportingTsExtensions`（它要求同时 `noEmit`）。否则 tsc 会拒绝 `./util.ts` 这种写法，而运行时的 Node 恰恰要求它 —— 两边不一致时以 Node 为准。

其他语言同理：

```json
{ "entry": "main.py", "runtime": { "command": "python", "args": ["-u"] } }
```

（`-u` 让 Python 不缓冲 stdout，否则协议帧会攒在缓冲区里，握手直接超时。）

`command` 找不到或起不来时，在 spawn 阶段失败，按 §10 的「spawn 失败」处理：**隔离，不重试**。

### 1.2 权限：没有沙箱

内核**不做沙箱**。插件进程与内核同权限：能读任意文件、发起任意网络请求。`runtime` 不是安全边界 —— 换成别的运行时也一样。需要隔离请自己在 `command` 外面套一层（容器、独立用户等），内核不内置，目前也没有规划。

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
{"jsonrpc":"2.0","method":"plugin/ready","params":{"name":"echo","version":"0.1.0","protocolVersion":2}}
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

**插件拿不到 `msg_id`，也决定不了 `msg_seq`。** 被动回复有平台硬约束（群聊与单聊同为 5 分钟 / 最多 5 次），让插件拿着 `msg_id` 硬发很容易撞墙。内核在收到事件时立刻预登记句柄；窗口剩余不足 60 秒时提前拒绝并返回结构化错误，而不是让请求打到平台拿 `40034005`。

两条回复路径：

1. **同步返回**（推荐）：`event/dispatch` 直接返回 `{ scope, body }`，内核立刻发。
2. **异步调用**：返回 `null`，稍后用 `host/reply` + `handleId` 回。

```json
{"jsonrpc":"2.0","id":3,"method":"host/reply","params":{"handleId":"h1","body":{"kind":"text","text":"处理完了"}}}
```

`scope` 必须与事件场景一致（群事件 `group`，单聊事件 `c2c`）。但**它只是自述**：真正的目标由内核持有的句柄决定，插件改不了。

### 4.1 发送意图：`body`

`body` 是**插件能表达的全部发送内容**，与 QQ 的协议字段解耦。插件永远看不到 `msg_type`、openid URL、`upload_id`、`presigned_url`、`file_info`：

```ts
type OutboundMessage =
  | { kind: 'text';     text: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'ark';      ark: { template_id: number; kv?: ArkKV[] } }    // 见 §5.7
  | { kind: 'embed';    embed: { title?: string; prompt?: string;
                                 thumbnail?: { url: string };
                                 fields?: { name: string }[] } }         // 见 §5.7
  | { kind: 'media';    fileType: 1|2|3|4; url?: string; data?: string;
                        localPath?: string; fileName?: string; text?: string }  // 见 §5.6
  | { kind: 'typing';   inputSecond?: number };  // 仅单聊，见 §5.7
```

其中任何一个都可以再带上两个附加字段：

| 附加字段 | 作用 |
|---|---|
| `keyboard` | 内嵌键盘，与消息**一起**提交。它不是独立接口 |
| `referenceMessageId` | 引用回复，填被引用消息的 id。同样只是 body 字段 |

`msg_type`、`msg_seq`、`msg_id` 全部由内核填。同一个模型能表达各种消息：

```ts
{ kind: 'text', text: '你好' }
{ kind: 'markdown', markdown: '**加粗**' }
{ kind: 'text', text: '请选择', keyboard: { content: { rows: [ /* ... */ ] } } }
{ kind: 'media', fileType: 1, url: 'https://example.com/a.png' }
```

形状不合法（`kind` 未知、`text` 全空白、`media` 既无 `url` 又无 `data`、`fileType=4` 缺 `fileName`）会在**发送之前**被内核挡掉，见 §9。

## 5. 主动消息

```ts
callHost('host/send', { scope: 'group', groupOpenid: '...', body: { kind: 'text', text: '...' } });
callHost('host/send', { scope: 'c2c', userOpenid: '...', body: { kind: 'markdown', markdown: '**...**' } });
```

`body` 与被动回复是**同一个模型**（见 §4.1），所以主动消息同样能发 Markdown / ARK / 键盘 / 富媒体。

需要声明 `message.send`。主动消息受**内核侧滑动窗口频控**（默认单会话 4 条 / 全局 20 条 / 每 60 秒，可用 `QQ_SEND_PER_CONVERSATION` / `QQ_SEND_GLOBAL` / `QQ_SEND_WINDOW_MS` 调整），超限时返回 `{ ok: false, detail: "rate_limited:..." }`。

被动回复有平台窗口兜底，主动消息没有 —— 一个写错的插件可以在几秒内把机器人打到限流甚至封禁。所以这个闸门在内核里，插件绕不过去，也别指望在插件侧自己限流。

## 5.5 撤回消息

```ts
callHost('host/recall', { scope: 'group', groupOpenid: '...', messageId: '...' });
callHost('host/recall', { scope: 'c2c', userOpenid: '...', messageId: '...' });
```

需要声明 `message.recall`。`messageId` 取自 `host/reply` / `host/send` 的成功返回 —— 插件本来就持有它，所以这里不再包一层句柄。**这也意味着插件只能撤回自己发过的消息**：别人的消息 ID 它本来就拿不到，除非是群管理员要撤回成员消息（那种场景下 ID 来自群事件的 `d.id`）。

两道硬约束：

- **发送超过 2 分钟不可撤回**，比被动回复窗口（5 分钟）更紧配额。
- **权限分两档**：机器人是群管理员时可撤回自己的消息与普通成员的消息；普通成员身份下只能撤回自己发送的。越权会被平台拒绝（`no_permission`），内核不替插件预判这一档。

成功时平台返回 HTTP 200 且**无响应体**，所以结果里没有 `messageId` 回执。失败与 `host/reply` 一样是结构化结果。

## 5.6 富媒体：图片 / 语音 / 视频 / 文件

**没有四套独立的发送协议** —— 图片 / 语音 / 视频 / 文件在发送侧完全是同一条链路。但**有两条不同的上传协议**，这一点必须分清：

### 模式一：URL（平台自己去下载）

```ts
{ kind: 'media', fileType: 1, url: 'https://example.com/a.png' }
```

Bot 只提交一个公网地址，平台自己拉取。**Bot 进程完全不碰文件内容**：不下载、不持有、不算分片哈希。所以这条路径与「大文件」无关，也没有 `size` 之类的参数。

### 模式二：本地（Bot 侧上传）

```ts
// base64。内容本来就在内存里
{ kind: 'media', fileType: 1, data: 'iVBORw0KGgo...' }

// 本地文件路径：内核流式扫描算摘要，分片时按 offset 随机读取
{ kind: 'media', fileType: 4, localPath: '/srv/reports/report.pdf', fileName: 'report.pdf' }

// 媒体可以附带一段说明文字
{ kind: 'media', fileType: 2, localPath: '/srv/v.mp4', text: '看这个' }
```

三个来源**只能给一个**：`url` / `data` / `localPath`。`fileType`：`1` 图片 / `2` 视频 / `3` 语音 / `4` 文件（`4` 必须给 `fileName`）。

本地模式按内容大小自动分流（**5 MiB**，与官方 SDK 一致），这个判断不下放给插件：

| 情况 | 内核行为 |
|---|---|
| 内容 < 5 MiB | 整文件上传，`file_data` 交给平台 |
| 内容 ≥ 5 MiB | 分片上传 |

分片的 `upload_prepare` / `presigned_url` / `upload_part_finish` / `upload_id` 全在内核内部完成，插件一个都看不到。分片并发度取 `upload_prepare` 返回的 `concurrency`，本地上限 10（不无限信任服务端返回值）。

富媒体需要**额外声明 `message.media` 能力**（见 §6）：内核会去访问你给的 URL 或本地路径、并向第三方预签名地址发起 PUT，是实实在在的新出网 / 新 IO 行为，所以单独授权。

### 内存行为（选来源就看这条）

| 来源 | 内存占用 |
|---|---|
| `url` | **零** —— Bot 不持有任何文件内容 |
| `localPath` | 只有分片缓冲区。摘要走一次流式扫描，分片按 `offset/length` 随机读取，**不整体加载** |
| `data`（base64） | 整个文件常驻内存，解码前还有一份 base64 字符串 —— 这是这种来源的固有性质 |

所以：**文件已经在 QQ 服务端能访问的公网 HTTPS 地址上时用 `url`**，Bot 连下载都不必做；文件在本地时用 `localPath`，不要为了省事把大文件读成 base64 再传。

## 5.7 ARK / Embed / 键盘 / 引用回复 / 输入状态

这五样**都不是独立接口**，只是同一份消息 body 上的字段。内核把它们归一到同一个发送端点，插件侧只是换一个 `kind`：

```ts
// ARK 卡片（msg_type=3）。template_id 由平台侧配置；kv 是模板变量，
// key 是模板里的占位符，value 与 obj 二选一（obj 用于列表类变量）
{ kind: 'ark', ark: {
  template_id: 23,
  kv: [
    { key: '#DESC#', value: '描述' },
    { key: '#LIST#', obj: [{ obj_kv: [{ key: 'desc', value: 'item' }] }] },
  ],
} }

// Embed（msg_type=4）
{ kind: 'embed', embed: {
  title: '标题',
  prompt: '通知栏提示',
  thumbnail: { url: 'https://example.com/i.png' },
  fields: [{ name: '字段一' }, { name: '字段二' }],
} }

// 键盘：不是 kind，而是挂在任意消息上的字段
{ kind: 'text', text: '请选择', keyboard: { content: { rows: [ /* ... */ ] } } }

// 引用回复：同样是字段
{ kind: 'text', text: '这是引用回复', referenceMessageId: 'MESSAGE_ID' }

// 输入状态（msg_type=6）：只有单聊有
{ kind: 'typing', inputSecond: 30 }
```

两点容易搞错：

- **`msg_type: 6` 是「正在输入」，不是图片 / 语音那类媒体。** 媒体是 `msg_type: 7`，而且必须先上传。
- **输入状态只有单聊支持。** 群聊里发会在发送前被内核拒绝（`unsupported_scope`），不会打到平台。

### 入站与出站不是镜像

收到的 `msg_elements` / `mentions` / `ark_data` 是**事件**的形状，不等于可以直接提交回去的发送参数 —— 官方发送 API 并不接受把入站字段原样反向提交。所以内核不提供 `sendMsgElements()` 这类接口：要发 ARK 就按上面的 `{ kind: 'ark' }` 构造，要 @ 某人就在 `text` 里自己组织。

## 6. 能力

| 能力 | 允许的调用 |
|---|---|
| `message.reply` | `host/reply`，或 `event/dispatch` 同步返回 |
| `message.send` | `host/send` |
| `message.media` | 发送 `kind: 'media'` 时的**额外**要求 |
| `message.recall` | `host/recall` |

`message.media` 是叠加的：发富媒体既要有 `message.reply`（或 `message.send`），也要有 `message.media`。同步返回路径与 `host/reply` 走同一套检查，绕不过去。

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
| `empty_message` | 正文为空（`text` / `markdown` 全空白） | 修正后重试 |
| `unsupported_scope` | 这条消息在该会话不可用（例如群聊里发输入状态） | 放弃 |
| `window_expired` | 平台判定窗口过期 | 放弃 |
| `duplicate_msg_seq` | `msg_seq` 重复（内核已维护，正常不出现） | 放弃 |
| `not_group_member` / `muted` | 机器人不在群 / 被禁言 | 放弃 |
| `auth_failed` | 凭证失效（内核会自动重取一次） | 可重试 |
| `network` | 网络或超时 | 可退避重试 |
| `media_upload` | 本地上传链路失败：取源 / 解码 / 摘要 / 分片编排（具体阶段在 `detail` 的 `stage=` 前缀里） | 修正后重试 |
| `recall_expired` | 撤回超时（发送超过 2 分钟） | 放弃 |
| `no_permission` | 无权撤回该消息 | 用法错误，检查机器人是否群管理员 |
| `invalid_message_id` | 消息 ID 或 openid 无效 | 检查参数 |
| `retryable` | 平台建议稍后重试（撤回） | 稍后重试 |
| `unknown` | 未分类 | 记日志 |

**不要解析平台的 `err_code`，也不要依赖 `message` 文案** —— 两者都可能随时变。按上表的 `reason` 分支即可。

发送意图形状本身不合法（未知 `kind`、`media` 既无 `url` 又无 `data`、`fileType=4` 缺 `fileName`）不属于上表：它会在**发送之前**被挡下，以 JSON-RPC error `-32602`（`INVALID_PARAMS`）返回。在同步返回路径上，同样的错误会让内核记一条 warn 并丢弃这条回复 —— 所以写错了不会打到平台，但也别指望平台给你报错。

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

`plugins/echo/index.js` 是完整可跑的最小示例，覆盖握手、`plugin/ready`、同步回复、异步 `host/reply`、主动 `host/send`、撤回 `host/recall`、Markdown、ARK、内嵌键盘、富媒体、输入状态，以及 stdout/stderr 分离。从它改名开始写最省事 —— 除了普通文本，发别的类型给它一条对应关键字的消息就能看到完整链路（`markdown` / `ark` / `keyboard` / `image` / `typing` / `send` / `recall` / `async`）。

`scripts/fixtures/ts-plugin/index.ts` 是 TypeScript 版本的最小示例（同样走完整握手与同步回复，入口是 `.ts`、无构建步骤），冒烟自检每次都会真的把它跑起来。要写 TS 插件就照它改。
