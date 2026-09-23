# Node.js / TypeScript 插件 SDK

`icy-qqbot/sdk` 是 ICY 官方的**插件侧协议实现**。它只封装 JSON-RPC 2.0 / NDJSON、生命周期、请求关联与 host 调用，不提供命令系统、session、storage、scheduler、AI 等业务层能力。

换句话说：SDK 让插件作者不必重复写 IPC 样板，但不会把 ICY 变成应用框架。底层契约仍以 [`plugin.md`](plugin.md) 为准。

## 使用前提

先构建 ICY：

```bash
npm run build
```

SDK 的运行时代码位于 `dist/sdk/index.js`，包内插件可以直接通过 package self-reference 导入：

```ts
import { createPlugin } from 'icy-qqbot/sdk';
```

TypeScript 插件仍按 [`plugin.md`](plugin.md) §1.1 的规则运行：Node 22.6–23.5 使用 `--experimental-strip-types`，Node 23.6+ 可直接执行可擦除语法的 `.ts` 文件。

## 最小插件

```ts
import { createPlugin } from 'icy-qqbot/sdk';

const plugin = createPlugin({
  name: 'hello',
  version: '0.1.0',

  onEvent({ event }) {
    if (event.kind !== 'group' && event.kind !== 'c2c') return null;
    return {
      scope: event.kind,
      body: { kind: 'text', text: `hello: ${event.content ?? ''}` },
    };
  },
});

plugin.run();
```

SDK 自动处理：

- `lifecycle/init`
- `plugin/ready`
- `ping`
- `lifecycle/shutdown`
- stdin 的 NDJSON 拆帧与 JSON-RPC 校验
- plugin → host 请求 id、pending map 与超时
- host 返回 JSON-RPC error 时的 Promise reject

插件仍然负责自己的业务状态与异常处理。

## 配置类型

`plugin.json` 的 `config` 会在初始化时原样下发，可以给 `createPlugin` 指定泛型：

```ts
interface Config {
  prefix?: string;
  endpoint?: string;
}

const plugin = createPlugin<Config>({
  name: 'example',
  version: '0.1.0',

  onInit({ config, bot, host }) {
    host.log('info', 'initialized', { bot: bot.id, prefix: config.prefix });
  },

  onEvent({ event, config }) {
    // config 在 onInit / onEvent / onShutdown 中都是同一份插件私有配置。
    return null;
  },
});
```

SDK 只做类型提示，不替插件验证自己的 config schema；业务配置校验仍由插件负责。

## 被动回复

最推荐的路径仍然是从 `onEvent` **同步返回**：

```ts
onEvent({ event }) {
  if (event.kind !== 'group' && event.kind !== 'c2c') return null;
  return {
    scope: event.kind,
    body: { kind: 'text', text: '收到' },
  };
}
```

需要异步回复时使用 `host.reply`。SDK 接受整个 ReplyHandle，也接受 `handleId` 字符串：

```ts
async onEvent({ reply, host }) {
  if (reply === null) return null;

  setTimeout(() => {
    void host.reply(reply, { kind: 'text', text: '异步处理完成' });
  }, 1000);

  return null;
}
```

`msg_id`、`msg_seq`、5 分钟窗口与次数限制仍全部由内核持有，SDK 不复制这些规则。`reply.acceptBefore` 是内核的最晚提交时间，异步工作应把它作为回复截止时间的一部分。

## 主动消息

```ts
import { targetOf } from 'icy-qqbot/sdk';

async onEvent({ event, host }) {
  const target = targetOf(event);
  if (target === null) return null;

  const result = await host.send(target, {
    kind: 'text',
    text: '这是一条主动消息',
  });

  return null;
}
```

`targetOf(event)` 只把已经归一化的 group / c2c 事件转换为主动消息目标；生命周期或缺定位字段的事件返回 `null`。

`host.send` 仍需要 manifest 声明 `message.send`，媒体消息还需要叠加 `message.media`。

## 撤回

```ts
const sent = await host.send(target, { kind: 'text', text: '稍后撤回' });
if (sent.ok && sent.messageId) {
  await host.recall(target, sent.messageId);
}
```

需要 `message.recall` capability。平台的 2 分钟限制与权限规则仍由内核翻译成稳定失败结果。

## 日志

推荐：

```ts
host.log('info', 'task completed', { taskId: '42' });
```

或者直接写 `stderr` / `console.error`。

**不要使用 `console.log`。** SDK 启动以后 stdout 是 JSON-RPC 协议流，任何普通文本都会污染协议并导致插件被内核杀掉。

## 错误模型

有两层失败，语义不同：

1. `host.reply` / `host.send` / `host.recall` 正常调用完成，但平台或窗口拒绝：Promise 正常 resolve，检查 `{ ok: false, ... }`。
2. JSON-RPC 层失败（参数非法、capability 未声明等）：Promise reject 为 `RpcRemoteError`，可以读取 `code` 与 `data`。

插件侧本地等待 host 响应默认超时为 **60 秒**。可以在 `createPlugin({ requestTimeoutMs })` 设置默认值，或在单次 `host.reply/send/recall` 的最后一个参数覆盖。大型本地媒体上传应显式给更长超时。

## 协议版本

SDK 与当前 ICY IPC 协议一起版本化。当前协议为 v3，新增 `PublicReplyHandle.acceptBefore`；`lifecycle/init.protocolVersion` 与 SDK 的 `IPC_PROTOCOL_VERSION` 不一致时，SDK 会拒绝初始化，而不是带着错误 ABI 继续运行。

如果你需要研究或实现其他语言 SDK，直接按照 [`plugin.md`](plugin.md) 的原始 JSON-RPC 契约实现即可；Node.js SDK 不是新的协议层。
