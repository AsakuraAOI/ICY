#!/usr/bin/env node
/**
 * 内核冒烟自检。
 *
 * 不连网络、不需要 QQ 凭证：只验证「插件发现 → intents 聚合 → 子进程 IPC →
 * 事件投递 → 被动回复窗口 → 关停」这条链路真的能跑通。
 * 需要先构建（npm run build），因为它 import 的是 dist/。
 *
 * 用法：node scripts/smoke.mjs
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Dispatcher } from '../dist/core/dispatch.js';
import { Deduper, dedupeKey } from '../dist/core/dedupe.js';
import { DEFAULT_CONCURRENCY } from '../dist/core/dispatch.js';
import { closeAction } from '../dist/core/events.js';
import { conversationKey, normalize, parseSceneExt } from '../dist/core/normalize.js';
import { ReplyRegistry } from '../dist/core/pending.js';
import { QQApiClient } from '../dist/core/api.js';
import {
  CHUNKED_UPLOAD_THRESHOLD_BYTES,
  MAX_CONCURRENT_PARTS,
  MediaFileType,
  getPartRange,
  validateParts,
} from '../dist/core/media.js';
import { outboundScopeProblem, parseOutboundMessage, sendOutbound } from '../dist/core/outbound.js';
import {
  getApiBase,
  mediaUploadPath,
  messagePath,
  recallPath,
  setApiBase,
  uploadPartFinishPath,
  uploadPreparePath,
} from '../dist/core/routes.js';
import { ApiError, MediaUploadError, describeRecallFailure, describeSendFailure } from '../dist/core/errors.js';
import { Gateway } from '../dist/core/gateway.js';
import { DEFAULT_THROTTLE_LIMITS, SendThrottle } from '../dist/core/throttle.js';
import { ConfigError, loadConfig } from '../dist/config.js';
import { TokenManager } from '../dist/core/token.js';
import { aggregateIntents } from '../dist/host/manifest.js';
import { discoverPlugins, PluginCatalog } from '../dist/host/registry.js';
import { Supervisor } from '../dist/host/supervisor.js';

import { startMockQq } from './e2e/mock-qq.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..', 'plugins');

let failures = 0;
const logs = [];

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  const suffix = detail === '' ? '' : ` — ${detail}`;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}\n`);
}

/** 出站消息模型的正文，仅用于断言。 */
function textOf(message) {
  if (message === null || typeof message !== 'object') return null;
  if (message.kind === 'text') return message.text;
  if (message.kind === 'markdown') return message.markdown;
  if (message.kind === 'media') return message.text ?? null;
  return message.kind;
}

function groupEvent(patch = {}) {
  return {
    kind: 'group',
    eventType: 'GROUP_AT_MESSAGE_CREATE',
    eventId: 'smoke-evt-1',
    seq: 1,
    messageId: 'smoke-msg-1',
    groupOpenid: 'smoke-group',
    senderId: 'smoke-user',
    content: 'hello',
    raw: {},
    ...patch,
  };
}

try {
  // ---------------------------------------------------------- 发现与聚合（建连之前）
  const manifests = await discoverPlugins(pluginDir);
  check(
    '发现 echo 插件',
    manifests.length === 1 && manifests[0].name === 'echo',
    manifests.map((m) => m.name).join(', ') || '（空）',
  );

  const intents = aggregateIntents(manifests);
  check(
    'intents 聚合为 GROUP_AND_C2C_EVENT',
    intents.length === 1 && intents[0] === 'GROUP_AND_C2C_EVENT',
    intents.join('/') || '（空）',
  );

  // ---------------------------------------------------------- 插件宿主
  check(
    'manifest 的 config 被解析（插件私有配置的唯一入口）',
    manifests[0].config.prefix === 'echo',
    JSON.stringify(manifests[0].config),
  );

  const catalog = new PluginCatalog(manifests);
  const replies = new ReplyRegistry();
  const delivered = [];
  let hostReplyCalls = 0;

  const supervisor = new Supervisor(catalog, {
    catalog,
    bot: { id: 'smoke-app-id' },
    log: (level, message) => logs.push(`${level} ${message}`),
    onReply: async (_pluginName, params) => {
      const resolution = replies.resolve(params.handleId, params.body);
      if (!resolution.ok) {
        return { ok: false, reason: resolution.error.reason, detail: resolution.error.detail };
      }
      hostReplyCalls += 1;
      delivered.push(textOf(resolution.instruction.message));
      return { ok: true, messageId: 'smoke-async', msgSeq: resolution.instruction.msgSeq };
    },
    onSend: async () => ({ ok: false, detail: '冒烟自检不使用主动消息' }),
    onRecall: async () => ({ ok: false, reason: 'unused', detail: '冒烟自检不使用撤回' }),
  });

  await supervisor.startAll();
  check('echo 进入 running', supervisor.stateOf('echo') === 'running', `state=${supervisor.stateOf('echo')}`);
  check('没有插件被隔离', supervisor.quarantined.length === 0, supervisor.quarantined.join(', '));

  // manifest 的默认值会覆盖 Dispatcher 的默认值：两处若不一致，dispatch.ts 里那个默认
  // 对真实插件永远不生效（曾经是 8 与 1 的分歧，真实插件全部退化成串行）。
  const echoEndpoint = supervisor.endpoints().find((endpoint) => endpoint.name === 'echo');
  check(
    '真实插件沿用统一的默认并发度',
    echoEndpoint?.concurrency === DEFAULT_CONCURRENCY,
    `concurrency=${String(echoEndpoint?.concurrency)}`,
  );

  // ------------------------------------------------------- 事件投递与回复
  const dispatcher = new Dispatcher({
    plugins: supervisor.endpoints(),
    replies,
    log: (level, message) => logs.push(`${level} ${message}`),
    send: async (instruction) => {
      delivered.push(textOf(instruction.message));
    },
  });

  dispatcher.submit(groupEvent());
  await dispatcher.drain();
  check('同步回复已发出', delivered.length === 1 && delivered[0] === 'echo: hello', JSON.stringify(delivered));

  // 异步路径：插件先返回 null，稍后用 host/reply + handleId 回。
  dispatcher.submit(groupEvent({ eventId: 'smoke-evt-2', messageId: 'smoke-msg-2', content: 'async' }));
  await dispatcher.drain();
  await delay(800);
  check('异步 host/reply 到达内核', hostReplyCalls === 1, `calls=${hostReplyCalls}`);
  check('异步回复内容正确', delivered.includes('这是异步回复（host/reply）'), JSON.stringify(delivered));

  // 未订阅的事件不应被投递。
  const before = delivered.length;
  dispatcher.submit(groupEvent({ eventId: 'smoke-evt-3', eventType: 'GROUP_ADD_ROBOT' }));
  await dispatcher.drain();
  check('未订阅事件不产生回复', delivered.length === before);

  // 没有订阅者的消息类事件不该占用被动窗口句柄。句柄有上限（默认 5000），堆满后会淘汰
  // 最旧的 —— 被淘汰的可能正是别的会话里仍在等待 host/reply 的句柄，插件拿到
  // unknown_handle，原因却和自己的行为无关。echo 只订阅了 GROUP_AT_MESSAGE_CREATE，
  // 所以 GROUP_MESSAGE_CREATE（全量模式）正好是「有窗口但没人处理」的那种事件。
  const handlesBefore = replies.size;
  dispatcher.submit(
    groupEvent({
      eventId: 'smoke-evt-4',
      messageId: 'smoke-msg-4',
      eventType: 'GROUP_MESSAGE_CREATE',
    }),
  );
  await dispatcher.drain();
  check(
    '无订阅者的消息事件不登记被动窗口',
    replies.size === handlesBefore,
    `size=${replies.size}`,
  );

  // ----------------------------------------------------------------- 去重
  const deduper = new Deduper();
  const duplicate = groupEvent({ eventId: 'smoke-evt-dup', messageId: 'smoke-msg-dup' });
  check('去重键首次接受', deduper.accept(dedupeKey(duplicate)) === true);
  check('去重键二次拒绝', deduper.accept(dedupeKey(duplicate)) === false);

  // ------------------------------------------------------- 被动回复窗口约束
  const closing = new ReplyRegistry({ minRemainingMs: 400_000 });
  const closingHandle = closing.register(groupEvent());
  const closingResult =
    closingHandle === null ? null : closing.resolve(closingHandle.handleId, 'x');
  check(
    '窗口所剩无几时内核提前拒绝',
    closingResult !== null && closingResult.ok === false && closingResult.error.reason === 'window_closing',
    closingResult === null ? 'handle 为 null' : String(closingResult.ok ? 'ok' : closingResult.error.reason),
  );

  const limited = new ReplyRegistry({ maxReplies: 1 });
  const limitedHandle = limited.register(groupEvent());
  const firstReply =
    limitedHandle === null ? null : limited.resolve(limitedHandle.handleId, 'a');
  const secondReply =
    limitedHandle === null ? null : limited.resolve(limitedHandle.handleId, 'b');
  check(
    '被动回复次数用尽后拒绝',
    firstReply !== null &&
      firstReply.ok === true &&
      secondReply !== null &&
      secondReply.ok === false &&
      secondReply.error.reason === 'exhausted',
  );

  const seqRegistry = new ReplyRegistry();
  const seqHandle = seqRegistry.register(groupEvent());
  const seqFirst = seqHandle === null ? null : seqRegistry.resolve(seqHandle.handleId, 'a');
  const seqSecond = seqHandle === null ? null : seqRegistry.resolve(seqHandle.handleId, 'b');
  check(
    'msg_seq 递增避免去重',
    seqFirst !== null &&
      seqFirst.ok === true &&
      seqSecond !== null &&
      seqSecond.ok === true &&
      seqFirst.instruction.msgSeq === 1 &&
      seqSecond.instruction.msgSeq === 2,
  );

  const c2cHandle = replies.register({
    kind: 'c2c',
    eventId: 'smoke-c2c-evt',
    eventType: 'C2C_MESSAGE_CREATE',
    seq: 2,
    messageId: 'smoke-c2c-msg',
    userOpenid: 'smoke-user',
    raw: {},
  });
  const c2cResolution = c2cHandle === null ? null : replies.resolve(c2cHandle.handleId, 'hi');
  check(
    '单聊消息也产生被动窗口，并按 user_openid 定位',
    c2cResolution !== null &&
      c2cResolution.ok === true &&
      c2cResolution.instruction.scope === 'c2c' &&
      c2cResolution.instruction.userOpenid === 'smoke-user' &&
      c2cResolution.instruction.msgSeq === 1,
    c2cResolution === null ? 'handle 为 null' : JSON.stringify(c2cResolution),
  );

  check(
    '生命周期事件不产生被动窗口',
    replies.register({ kind: 'lifecycle', eventId: 'x', eventType: 'GROUP_ADD_ROBOT', seq: 1, raw: {} }) === null,
  );

  // ------------------------------------------------------- 归一化与协议常量
  const sceneExt = parseSceneExt(['msg_idx=REFIDX_abc==', 'auth_token=v=1', 'novalue']);
  check(
    'message_scene.ext 解析成 map',
    sceneExt.get('msg_idx') === 'REFIDX_abc==' &&
      sceneExt.get('auth_token') === 'v=1' &&
      sceneExt.size === 2,
    `size=${sceneExt.size}`,
  );

  const groupRaw = normalize({
    id: 'evt-group',
    op: 0,
    s: 7,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'msg-group',
      content: 'ping',
      group_openid: 'group-1',
      timestamp: '2026-09-22T10:00:00+08:00',
      message_type: 0,
      author: { id: 'uid-1', member_openid: 'member-1', username: 'tester', member_role: 'admin' },
      message_scene: { source: 'default', ext: ['msg_idx=REFIDX_1==', 'ref_msg_idx=REFIDX_0=='] },
    },
  });
  check(
    '群 @ 消息归一化',
    groupRaw !== null &&
      groupRaw.kind === 'group' &&
      groupRaw.messageId === 'msg-group' &&
      groupRaw.senderId === 'member-1' &&
      groupRaw.senderRole === 'admin' &&
      groupRaw.groupOpenid === 'group-1' &&
      groupRaw.msgIdx === 'REFIDX_1==' &&
      groupRaw.refMsgIdx === 'REFIDX_0==',
    JSON.stringify(groupRaw),
  );
  // 引用消息 / 卡片 / @ 列表必须落在契约字段上，否则插件只能去翻 raw —— raw 是
  // 逃生舱，不该成为唯一拿到这些内容的途径。
  const richRaw = normalize({
    id: 'evt-rich',
    op: 0,
    s: 8,
    t: 'GROUP_MESSAGE_CREATE',
    d: {
      id: 'msg-rich',
      content: 'look',
      group_openid: 'group-1',
      message_type: 103,
      author: { id: 'uid-1', member_openid: 'member-1' },
      mentions: [{ id: 'uid-9', member_openid: 'member-9', username: 'other' }],
      ark_data: { prompt: 'p', ark_type: 't', fields: { a: 1 } },
      msg_elements: [{ message_type: 0, content: 'quoted' }],
    },
  });
  check(
    '被引用消息、卡片与 @ 列表都归一化到契约字段',
    richRaw !== null &&
      richRaw.contentType === 103 &&
      richRaw.mentions?.[0]?.member_openid === 'member-9' &&
      richRaw.arkData?.prompt === 'p' &&
      richRaw.msgElements?.[0]?.content === 'quoted',
    JSON.stringify({
      mentions: richRaw?.mentions,
      ark: richRaw?.arkData,
      elements: richRaw?.msgElements,
    }),
  );

  check(
    '群会话键按群隔离',
    groupRaw !== null && conversationKey(groupRaw) === 'qq:group:group-1',
    groupRaw === null ? 'null' : conversationKey(groupRaw),
  );

  const c2cRaw = normalize({
    id: 'evt-c2c',
    op: 0,
    s: 8,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'msg-c2c', content: 'hi', author: { id: 'uid-2', user_openid: 'user-2' } },
  });
  check(
    '单聊消息取 user_openid',
    c2cRaw !== null &&
      c2cRaw.kind === 'c2c' &&
      c2cRaw.senderId === 'user-2' &&
      c2cRaw.userOpenid === 'user-2',
    JSON.stringify(c2cRaw),
  );
  check(
    '单聊会话键按用户隔离',
    c2cRaw !== null && conversationKey(c2cRaw) === 'qq:c2c:user-2',
    c2cRaw === null ? 'null' : conversationKey(c2cRaw),
  );

  check(
    'op 非 0 与 READY/RESUMED 不进入归一化',
    normalize({ op: 1, d: null }) === null &&
      normalize({ op: 0, t: 'READY', d: { session_id: 's' } }) === null &&
      normalize({ op: 0, t: 'RESUMED', d: {} }) === null,
  );

  const lifecycleRaw = normalize({ id: 'evt-friend', op: 0, s: 9, t: 'FRIEND_ADD', d: {} });
  check(
    '未逐字核实的事件归一为 lifecycle 并保留 raw',
    lifecycleRaw !== null && lifecycleRaw.kind === 'lifecycle' && lifecycleRaw.raw !== undefined,
    lifecycleRaw === null ? 'null' : lifecycleRaw.kind,
  );

  // 平台可能送来 d 缺失或畸形的帧。这类输入绝不能让内核抛异常 —— 异常会顺着
  // WebSocket 的 message 监听冒出去，直接终结进程。
  let malformedThrew = null;
  const malformedKinds = [];
  try {
    for (const shape of [null, [], 'text', 42]) {
      const broken = normalize({
        id: 'evt-broken',
        op: 0,
        s: 10,
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: shape,
      });
      malformedKinds.push(broken === null ? 'null' : broken.kind);
    }
  } catch (error) {
    malformedThrew = error;
  }
  check(
    '消息事件的 d 畸形时降级为 unknown，不抛异常',
    malformedThrew === null && malformedKinds.every((kind) => kind === 'unknown'),
    malformedThrew === null ? malformedKinds.join(',') : `threw ${String(malformedThrew)}`,
  );

  const malformedLifecycle = normalize({
    id: 'evt-broken-lifecycle',
    op: 0,
    s: 11,
    t: 'FRIEND_ADD',
    d: null,
  });
  check(
    '非消息事件的分类不因 payload 形状而改变',
    malformedLifecycle !== null && malformedLifecycle.kind === 'lifecycle',
    malformedLifecycle === null ? 'null' : malformedLifecycle.kind,
  );

  check(
    '关闭码分支与 DESIGN.md §5.4 一致',
    closeAction(4006) === 'identify' &&
      closeAction(4007) === 'identify' &&
      closeAction(4008) === 'resume' &&
      closeAction(4009) === 'resume' &&
      closeAction(4014) === 'fatal' &&
      closeAction(4914) === 'fatal' &&
      closeAction(4915) === 'fatal' &&
      closeAction(4900) === 'identify',
  );

  // -------------------------------------------- 对外请求必须有超时（防静默挂死）
  // 本地起一个只接受连接、永不回包的 server，把 token 接口指过去。没有超时的
  // fetch 会在这里永久挂住 —— 启动流程静默卡死，没有任何日志。这是比失败更糟
  // 的失败方式，所以必须由测试钉住。
  const savedApiBase = getApiBase();
  const hangServer = createServer(() => {});
  await new Promise((ready) => hangServer.listen(0, '127.0.0.1', ready));
  const hangAddress = hangServer.address();
  const hangPort = hangAddress === null || typeof hangAddress === 'string' ? 0 : hangAddress.port;

  setApiBase(`http://127.0.0.1:${hangPort}`);
  const hangingTokens = new TokenManager({
    appId: 'x',
    clientSecret: 'y',
    timeoutMs: 400,
  });
  const hangStartedAt = Date.now();
  let hangError = null;
  try {
    await hangingTokens.get();
  } catch (error) {
    hangError = error;
  }
  const hangElapsed = Date.now() - hangStartedAt;
  setApiBase(savedApiBase);
  if (typeof hangServer.closeAllConnections === 'function') hangServer.closeAllConnections();
  hangServer.close();

  check(
    'token 请求超时后抛错，而不是永久挂死',
    hangError !== null && hangElapsed < 5000,
    `elapsed=${hangElapsed}ms error=${hangError === null ? 'null' : hangError.name}`,
  );

  // ------------------------------------------- 发送失败 → 插件可见的稳定 reason
  // 插件不该解析 err_code（平台私有字段），但必须能区分「重试无用」与「值得退避重试」。
  const apiError = (errCode, httpStatus = 200) =>
    new ApiError({
      httpStatus,
      path: '/v2/groups/g/messages',
      errCode,
      traceId: 'trace-x',
      body: {},
      detail: 'mock',
    });
  check(
    '被动窗口过期被翻译成 window_expired',
    describeSendFailure(apiError(40034005)) === 'window_expired' &&
      describeSendFailure(apiError(40034128)) === 'window_expired' &&
      describeSendFailure(apiError(304103)) === 'window_expired',
  );
  check(
    'msg_seq 重复与权限类失败各有稳定 reason',
    describeSendFailure(apiError(40054005)) === 'duplicate_msg_seq' &&
      describeSendFailure(apiError(40054003)) === 'not_group_member' &&
      describeSendFailure(apiError(40054002)) === 'muted' &&
      describeSendFailure(apiError(11241)) === 'auth_failed',
  );
  check(
    '未知 err_code 与非 API 错误都不会误判',
    describeSendFailure(apiError(999999)) === 'unknown' &&
      describeSendFailure(new Error('boom')) === 'unknown',
  );
  check(
    'ApiError 的 message 带上 trace_id（追回平台侧的唯一依据）',
    apiError(40034005).message.includes('trace_id=trace-x'),
    apiError(40034005).message,
  );

  // 撤回窗口只有 2 分钟，比被动回复的 5 分钟更紧；权限还分两档（群管理员 / 普通成员）。
  // 「过期了」和「没权限」必须分开：前者重试无用，后者说明用法错了。
  check(
    '撤回失败各有稳定 reason（过期与无权限不混为一谈）',
    describeRecallFailure(apiError(40064004)) === 'recall_expired' &&
      describeRecallFailure(apiError(40062003)) === 'no_permission' &&
      describeRecallFailure(apiError(40061001)) === 'invalid_message_id' &&
      describeRecallFailure(apiError(40061002)) === 'invalid_message_id' &&
      describeRecallFailure(apiError(306009)) === 'invalid_message_id' &&
      describeRecallFailure(apiError(50065001)) === 'retryable' &&
      describeRecallFailure(apiError(11241)) === 'auth_failed' &&
      describeRecallFailure(apiError(999999)) === 'unknown' &&
      describeRecallFailure(new Error('boom')) === 'unknown',
    `expired=${describeRecallFailure(apiError(40064004))} noPerm=${describeRecallFailure(apiError(40062003))}`,
  );

  // ---------------------------------------------------------- 主动消息频控
  // 主动消息没有平台被动窗口兜底，闸门必须在内核里。时间戳全部注入，不依赖真实时钟。
  // 额度必须能配置，且非法值直接拒绝 —— 静默降级会让人以为限流生效了，实际没有。
  const parsedLimits = loadConfig({
    QQ_APP_ID: 'x',
    QQ_APP_SECRET: 'y',
    QQ_SEND_PER_CONVERSATION: '9',
    QQ_SEND_GLOBAL: '99',
    QQ_SEND_WINDOW_MS: '30000',
  }).sendLimits;
  check(
    '频控额度来自环境变量',
    parsedLimits.perConversation === 9 &&
      parsedLimits.global === 99 &&
      parsedLimits.windowMs === 30000,
    JSON.stringify(parsedLimits),
  );
  check(
    '未设置时沿用 throttle.ts 的默认值（单一来源）',
    loadConfig({ QQ_APP_ID: 'x', QQ_APP_SECRET: 'y' }).sendLimits.perConversation ===
      DEFAULT_THROTTLE_LIMITS.perConversation,
  );
  let limitError = null;
  try {
    loadConfig({ QQ_APP_ID: 'x', QQ_APP_SECRET: 'y', QQ_SEND_GLOBAL: '0' });
  } catch (error) {
    limitError = error;
  }
  check(
    '非法频控额度直接报错，不静默降级',
    limitError instanceof ConfigError,
    limitError === null ? 'null' : limitError.name,
  );

  const throttle = new SendThrottle({ perConversation: 2, global: 3, windowMs: 1000 });
  const t0 = 1_000_000;
  const t1 = throttle.take('group:a', t0);
  const t2 = throttle.take('group:a', t0 + 10);
  const t3 = throttle.take('group:a', t0 + 20);
  check(
    '同一会话超限后被拒绝并给出重试间隔',
    t1.ok === true &&
      t2.ok === true &&
      t3.ok === false &&
      t3.reason === 'conversation_limit' &&
      t3.retryAfterMs > 0,
    JSON.stringify(t3),
  );

  const t4 = throttle.take('group:b', t0 + 30);
  const t5 = throttle.take('group:c', t0 + 40);
  check(
    '换会话仍受全局上限约束',
    t4.ok === true && t5.ok === false && t5.reason === 'global_limit',
    JSON.stringify(t5),
  );

  const t6 = throttle.take('group:c', t0 + 1100);
  check('窗口滑过后重新放行', t6.ok === true, JSON.stringify(t6));
  check('滑过窗口的会话记录被回收', throttle.conversations <= 2, `conversations=${throttle.conversations}`);

  // ----------------------------------- 路由：会话串行 / 并行（DESIGN §7.2）
  // 这两条是硬规则，此前一条都没有被测试钉住。全部用假插件，不启子进程。

  const serialLog = [];
  let releaseSerial = () => {};
  const serialDispatcher = new Dispatcher({
    plugins: [
      {
        name: 'serial',
        priority: 100,
        events: ['GROUP_AT_MESSAGE_CREATE'],
        dispatch: async (event) => {
          serialLog.push(`start:${event.content}`);
          if (event.content === 'first') {
            await new Promise((resolve) => {
              releaseSerial = resolve;
            });
          }
          serialLog.push(`end:${event.content}`);
          return null;
        },
      },
    ],
    replies: new ReplyRegistry(),
    send: async () => {},
  });
  serialDispatcher.submit(
    groupEvent({
      eventId: 'route-serial-1',
      messageId: 'route-serial-1',
      content: 'first',
      groupOpenid: 'g-serial',
    }),
  );
  serialDispatcher.submit(
    groupEvent({
      eventId: 'route-serial-2',
      messageId: 'route-serial-2',
      content: 'second',
      groupOpenid: 'g-serial',
    }),
  );
  await delay(80);
  const serialBeforeRelease = [...serialLog];
  releaseSerial();
  await serialDispatcher.drain();
  check(
    '同一会话内事件串行：前一条未结束，后一条不开始',
    serialBeforeRelease.join('|') === 'start:first' &&
      serialLog.join('|') === 'start:first|end:first|start:second|end:second',
    serialLog.join('|'),
  );

  const parallelLog = [];
  const parallelResolvers = [];
  const parallelDispatcher = new Dispatcher({
    plugins: [
      {
        name: 'parallel',
        priority: 100,
        events: ['GROUP_AT_MESSAGE_CREATE'],
        dispatch: async (event) => {
          parallelLog.push(`start:${event.groupOpenid}`);
          await new Promise((resolve) => parallelResolvers.push(resolve));
          return null;
        },
      },
    ],
    replies: new ReplyRegistry(),
    send: async () => {},
  });
  parallelDispatcher.submit(
    groupEvent({ eventId: 'route-parallel-1', messageId: 'route-parallel-1', groupOpenid: 'g-a' }),
  );
  parallelDispatcher.submit(
    groupEvent({ eventId: 'route-parallel-2', messageId: 'route-parallel-2', groupOpenid: 'g-b' }),
  );
  await delay(80);
  check(
    '不同会话并行：两个会话都已开工，互不等待',
    parallelLog.join('|') === 'start:g-a|start:g-b',
    parallelLog.join('|'),
  );
  // 逐个放行：不同会话各自开工与结束的时刻并不相同，一次性放行会漏掉之后才开工的
  // 那一条，它的 promise 永远不会被 resolve，drain() 就会一直等下去。
  for (let i = 0; i < 25; i += 1) {
    for (const resolve of parallelResolvers.splice(0, parallelResolvers.length)) resolve();
    await delay(20);
  }
  await parallelDispatcher.drain();

  // ------------------------------------------- fanout 顺序与胜出规则（DESIGN §7.3）
  const fanoutCalls = [];
  const fanoutSent = [];
  let earlyReplies = false;
  const fanoutDispatcher = new Dispatcher({
    plugins: [
      {
        name: 'late',
        priority: 200,
        events: ['GROUP_AT_MESSAGE_CREATE'],
        dispatch: async () => {
          fanoutCalls.push('late');
          return { scope: 'group', message: { kind: 'text', text: 'from-late' } };
        },
      },
      {
        name: 'early',
        priority: 10,
        events: ['GROUP_AT_MESSAGE_CREATE'],
        dispatch: async () => {
          fanoutCalls.push('early');
          return earlyReplies ? { scope: 'group', message: { kind: 'text', text: 'from-early' } } : null;
        },
      },
    ],
    replies: new ReplyRegistry(),
    send: async (instruction) => {
      fanoutSent.push(textOf(instruction.message));
    },
  });

  fanoutDispatcher.submit(
    groupEvent({ eventId: 'route-fanout-1', messageId: 'route-fanout-1', groupOpenid: 'g-fanout' }),
  );
  await fanoutDispatcher.drain();
  check(
    'fanout 按 priority 升序调用，前一个返回 null 时继续下一个',
    fanoutCalls.join('|') === 'early|late' && fanoutSent.join('|') === 'from-late',
    `calls=${fanoutCalls.join('|')} sent=${fanoutSent.join('|')}`,
  );

  fanoutCalls.length = 0;
  fanoutSent.length = 0;
  earlyReplies = true;
  fanoutDispatcher.submit(
    groupEvent({ eventId: 'route-fanout-2', messageId: 'route-fanout-2', groupOpenid: 'g-fanout' }),
  );
  await fanoutDispatcher.drain();
  check(
    '第一个返回非 null 的插件胜出，后面的插件根本不被调用',
    fanoutCalls.join('|') === 'early' && fanoutSent.join('|') === 'from-early',
    `calls=${fanoutCalls.join('|')} sent=${fanoutSent.join('|')}`,
  );

  // ----------------------------------------------- 单插件队列背压（DESIGN §6.5）
  // queueLimit=2，投 5 条不同会话的事件：q1 立刻开工，q4、q5 入队时各挤掉最旧的一条。
  const queueDrops = [];
  const queueStarted = [];
  const busyDispatcher = new Dispatcher({
    plugins: [
      {
        name: 'busy',
        priority: 100,
        events: ['GROUP_AT_MESSAGE_CREATE'],
        // 并发度固定为 1，队列才真的会积压 —— 否则 5 条事件会一起开工，队列上限无从触发。
        concurrency: 1,
        queueLimit: 2,
        dispatch: async (event) => {
          queueStarted.push(event.content);
          await delay(200);
          return null;
        },
      },
    ],
    replies: new ReplyRegistry(),
    log: (_level, message) => queueDrops.push(message),
    send: async () => {},
  });
  for (const name of ['q1', 'q2', 'q3', 'q4', 'q5']) {
    busyDispatcher.submit(
      groupEvent({
        eventId: `route-queue-${name}`,
        messageId: `route-queue-${name}`,
        content: name,
        groupOpenid: `g-${name}`,
      }),
    );
  }
  await delay(80);
  const dropCount = queueDrops.filter((line) => line.includes('队列已满')).length;
  check(
    '队列满时丢弃最旧事件（q1 在跑，q2/q3 被挤掉）',
    queueStarted.join('|') === 'q1' && dropCount === 2,
    `started=${queueStarted.join('|')} drops=${dropCount}`,
  );
  await busyDispatcher.drain();
  check(
    '被丢弃的事件不影响后续事件继续处理',
    queueStarted.join('|') === 'q1|q4|q5',
    queueStarted.join('|'),
  );

  // ------------------------------------------- 崩溃重启与 quarantine（P6 加固）
  const fixtureManifests = await discoverPlugins(resolve(here, 'fixtures'));
  const fixtureNames = fixtureManifests.map((m) => m.name).sort();
  check(
    '发现 crasher / ts-plugin / zombie 三个夹具',
    fixtureNames.join('|') === 'crasher|ts-plugin|zombie',
    fixtureNames.join(', ') || '（空）',
  );

  // ------------------------------- 多语言插件：manifest.runtime 决定用什么跑起来
  // ts-plugin 的入口是 .ts，靠 Node 原生类型擦除直接执行、不经任何构建。它能走到
  // running 就证明 #spawn 用的是 runtime.command + runtime.args，而不是硬编码的
  // process.execPath。它同时钉住 manifest 里的 runtime 被原样解析出来。
  const tsManifests = fixtureManifests.filter((m) => m.name === 'ts-plugin');
  const tsCatalog = new PluginCatalog(tsManifests);
  const tsSupervisor = new Supervisor(tsCatalog, {
    catalog: tsCatalog,
    bot: { id: 'smoke-app-id' },
    log: (level, message) => logs.push(`[ts-plugin] ${level} ${message}`),
    onReply: async () => ({ ok: false, reason: 'unused', detail: '夹具不回消息' }),
    onSend: async () => ({ ok: false, detail: '夹具不用主动消息' }),
    onRecall: async () => ({ ok: false, reason: 'unused', detail: '夹具不撤回消息' }),
  });

  check(
    'manifest.runtime 被解析出来',
    tsManifests[0]?.runtime?.command === 'node' && tsManifests[0].runtime.args.length === 1,
    JSON.stringify(tsManifests[0]?.runtime ?? null),
  );

  await tsSupervisor.startAll();
  check(
    'TypeScript 入口直接跑起来并完成握手（无需构建）',
    tsSupervisor.stateOf('ts-plugin') === 'running',
    `state=${tsSupervisor.stateOf('ts-plugin')}`,
  );

  const tsReply = await tsSupervisor.endpoints()[0].dispatch(
    groupEvent({ content: '从 ts 来' }),
    null,
  );
  check(
    'TS 插件能处理事件并返回回复',
    tsReply?.message?.text === 'ts: 从 ts 来',
    JSON.stringify(tsReply ?? null),
  );

  await tsSupervisor.stopAll();
  check(
    'TS 插件已停止',
    tsSupervisor.stateOf('ts-plugin') === 'stopped',
    `state=${tsSupervisor.stateOf('ts-plugin')}`,
  );

  const crashManifests = fixtureManifests.filter((m) => m.name === 'crasher');
  const crashCatalog = new PluginCatalog(crashManifests);
  const crashSupervisor = new Supervisor(crashCatalog, {
    catalog: crashCatalog,
    bot: { id: 'smoke-app-id' },
    log: (level, message) => logs.push(`[crasher] ${level} ${message}`),
    onReply: async () => ({ ok: false, reason: 'unused', detail: '夹具不回消息' }),
    onSend: async () => ({ ok: false, detail: '夹具不用主动消息' }),
    onRecall: async () => ({ ok: false, reason: 'unused', detail: '夹具不撤回消息' }),
  });

  await crashSupervisor.startAll();
  check(
    'crasher 首次进入 running',
    crashSupervisor.stateOf('crasher') === 'running',
    `state=${crashSupervisor.stateOf('crasher')}`,
  );

  // 每次握手约 150ms，退避 500ms + 1000ms，三次崩溃合计约 2 秒。
  await delay(6000);
  const crashState = crashSupervisor.stateOf('crasher');
  check('60 秒内崩 3 次后 quarantine', crashState === 'quarantined', `state=${crashState}`);
  check(
    'quarantine 名单上报',
    crashSupervisor.quarantined.includes('crasher'),
    crashSupervisor.quarantined.join(', ') || '（空）',
  );
  await crashSupervisor.stopAll();

  // ------------------------------- 健康检查：进程活着但已经不能干活（P6 加固）
  // zombie 正确握手后不再回任何请求 —— 它不会 exit，从外面看状态一直是 running，
  // 所以只有主动 ping 才能发现它已经不能干活。这正是退出事件覆盖不到的那类失败。
  const zombieManifests = fixtureManifests.filter((m) => m.name === 'zombie');
  const zombieCatalog = new PluginCatalog(zombieManifests);
  const zombieSupervisor = new Supervisor(zombieCatalog, {
    catalog: zombieCatalog,
    bot: { id: 'smoke-app-id' },
    log: (level, message) => logs.push(`[zombie] ${level} ${message}`),
    onReply: async () => ({ ok: false, reason: 'unused', detail: '夹具不回消息' }),
    onSend: async () => ({ ok: false, detail: '夹具不用主动消息' }),
    onRecall: async () => ({ ok: false, reason: 'unused', detail: '夹具不撤回消息' }),
    // 压缩时间窗：默认 30s 间隔 / 15s 超时，跑一次要一分钟以上。
    timeouts: { healthCheckMs: 300, callMs: 800, terminateGraceMs: 500, shutdownMs: 500 },
  });

  await zombieSupervisor.startAll();
  check(
    'zombie 首次进入 running（进程还活着）',
    zombieSupervisor.stateOf('zombie') === 'running',
    `state=${zombieSupervisor.stateOf('zombie')}`,
  );

  // 每轮：300ms 后 ping → 800ms 超时 → SIGKILL → 退避 500ms 重启，约 1.6 秒一轮。
  await delay(9000);
  const zombieState = zombieSupervisor.stateOf('zombie');
  check('健康检查发现无响应并最终隔离', zombieState === 'quarantined', `state=${zombieState}`);
  check(
    '健康检查失败走了与崩溃同一条路径（有日志）',
    logs.some((line) => line.includes('健康检查失败')),
  );
  await zombieSupervisor.stopAll();

  // ------------------------------------------------------------------ 关停
  await supervisor.stopAll();
  check('echo 已停止', supervisor.stateOf('echo') === 'stopped', `state=${supervisor.stateOf('echo')}`);

  // --------------------------------- 重连打满上限必须致命上报，而不是让进程悬挂
  // 打满上限时连接已经没了、插件还在跑：进程既不收事件也不退出，从外面看像正常。
  // 用假 transport 驱动状态机，不需要真连 WebSocket；maxReconnects=0 表示第一次
  // 断开就判定打满，测试不必等真实的退避阶梯（1s 起步，跑满要几分钟）。
  const apiBaseBeforeGateway = getApiBase();
  const reconnectMock = await startMockQq({});
  setApiBase(reconnectMock.baseUrl);

  const fakeTransport = {
    closeHandlers: [],
    connect: async () => {},
    send: () => {},
    close: () => {},
    onMessage: () => {},
    onClose(handler) {
      this.closeHandlers.push(handler);
    },
  };

  const fatalErrors = [];
  const reconnectGateway = new Gateway(fakeTransport, {
    tokenManager: new TokenManager({ appId: 'x', clientSecret: 'y' }),
    intents: ['GROUP_AND_C2C_EVENT'],
    maxReconnects: 0,
    onDispatch: () => {},
    onFatal: (error) => fatalErrors.push(error),
  });
  await reconnectGateway.start();
  // 4008「发送过快」的策略是退避重连，但上限为 0，必须立刻转成致命错误。
  for (const handler of fakeTransport.closeHandlers) handler(4008, 'mock close');
  await delay(50);

  check(
    '重连打满上限时上报致命错误（否则进程既不收事件也不退出）',
    fatalErrors.length === 1 && fatalErrors[0].name === 'FatalError',
    `errors=${fatalErrors.map((error) => error.name).join(',') || '（空）'}`,
  );

  reconnectGateway.stop();
  setApiBase(apiBaseBeforeGateway);
  reconnectMock.close();
} catch (error) {
  failures += 1;
  process.stderr.write(`\nSMOKE 抛异常：${error && error.stack ? error.stack : String(error)}\n`);
}

// 失败时把内核日志整体打出来：插件是子进程，它为什么起不来只能从
// stderr 转发与 supervisor 的日志里看，冒烟脚本必须自己做这个证据留存。
if (failures > 0) {
  process.stdout.write('\n---- 内核日志 ----\n');
  for (const line of logs) process.stdout.write(`${line}\n`);
}

process.stdout.write(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED（${failures} 项）`}\n`);
// -------------------------------------------- token 错误分类与重试（DESIGN §5.1）
// 限流该重试、配置错误绝不重试。这两者写反了在日志里几乎看不出来：都是「启动失败」，
// 只有请求打了几次、消息里说了什么能区分。所以必须由断言钉住。
try {
  let tokenScript = [];
  let tokenHits = 0;
  const tokenServer = createServer((req, res) => {
    tokenHits += 1;
    req.resume();
    // 多项脚本逐条消费；单项脚本粘住，用来模拟持续失败。
    const next = tokenScript.length > 1 ? tokenScript.shift() : tokenScript[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(next ?? { access_token: 'tk', expires_in: '7200' }));
  });
  await new Promise((ready) => tokenServer.listen(0, '127.0.0.1', ready));
  const tokenAddress = tokenServer.address();
  const tokenPort =
    tokenAddress === null || typeof tokenAddress === 'string' ? 0 : tokenAddress.port;
  const apiBaseBeforeTokenRetry = getApiBase();
  setApiBase(`http://127.0.0.1:${tokenPort}`);

  tokenScript = [
    { code: 100001, message: 'too many requests' },
    { access_token: 'tk-retry', expires_in: '7200' },
  ];
  tokenHits = 0;
  let retryToken = null;
  let retryTokenError = null;
  try {
    retryToken = await new TokenManager({ appId: 'x', clientSecret: 'y' }).get();
  } catch (error) {
    retryTokenError = error;
  }
  check(
    '限流码 100001 自动重试并最终成功',
    retryToken === 'tk-retry' && tokenHits === 2,
    `token=${String(retryToken)} hits=${tokenHits} err=${retryTokenError === null ? 'null' : retryTokenError.name}`,
  );

  tokenScript = [{ code: 100007, message: 'appid invalid' }];
  tokenHits = 0;
  let fatalTokenError = null;
  try {
    await new TokenManager({ appId: 'x', clientSecret: 'y' }).get();
  } catch (error) {
    fatalTokenError = error;
  }
  check(
    '配置类错误码不重试，且消息里带上处置建议',
    fatalTokenError !== null &&
      fatalTokenError.name === 'TokenError' &&
      tokenHits === 1 &&
      fatalTokenError.message.includes('配置问题'),
    `hits=${tokenHits} msg=${String(fatalTokenError?.message)}`,
  );

  tokenScript = [{ code: 100001, message: 'too many requests' }];
  tokenHits = 0;
  let exhaustedError = null;
  try {
    await new TokenManager({ appId: 'x', clientSecret: 'y', maxAttempts: 2 }).get();
  } catch (error) {
    exhaustedError = error;
  }
  check(
    '限流持续时重试到上限即失败，不会无限重试',
    exhaustedError !== null && exhaustedError.name === 'TokenError' && tokenHits === 2,
    `hits=${tokenHits} err=${exhaustedError === null ? 'null' : exhaustedError.name}`,
  );

  setApiBase(apiBaseBeforeTokenRetry);
  if (typeof tokenServer.closeAllConnections === 'function') tokenServer.closeAllConnections();
  tokenServer.close();
} catch (error) {
  failures += 1;
  process.stderr.write(
    `token 重试自检抛异常：${error && error.stack ? error.stack : String(error)}\n`,
  );
}

// ------------------------------------------------- 发送能力：出站模型、路由与富媒体上传
try {
  // 1) 出站模型的校验：形状不对在这里就给出稳定 reason，不拖到平台报错。
  const rejected = [
    [{ kind: 'text', text: '   ' }, 'empty_message'],
    [{ kind: 'media', fileType: 9, url: 'https://example.com/a.png' }, 'invalid_media'],
    [{ kind: 'media', fileType: 1 }, 'invalid_media'],
    [{ kind: 'media', fileType: MediaFileType.FILE, url: 'https://example.com/a.bin' }, 'invalid_media'],
    [{ kind: 'nope' }, 'invalid_kind'],
    ['not-an-object', 'invalid_body'],
  ];
  for (const [body, expected] of rejected) {
    const parsed = parseOutboundMessage(body);
    check(
      `非法发送意图被拒（${expected}）`,
      parsed.ok === false && parsed.reason === expected,
      parsed.ok === true ? 'ok=true' : `reason=${parsed.reason}`,
    );
  }
  const okText = parseOutboundMessage({ kind: 'text', text: 'hi', keyboard: { id: 'k1' } });
  check(
    '合法发送意图带着键盘一起解析',
    okText.ok === true && okText.message.keyboard?.id === 'k1',
    JSON.stringify(okText.ok === true ? okText.message : null),
  );
  check(
    '输入状态在群聊里发送前就被挡掉（只有单聊有）',
    outboundScopeProblem({ kind: 'typing' }, 'group') !== null &&
      outboundScopeProblem({ kind: 'typing' }, 'c2c') === null,
    '',
  );

  // 1b) ARK / Embed 的完整模型：不再靠索引签名假装支持，形状不对就拒。
  const goodArk = parseOutboundMessage({
    kind: 'ark',
    ark: {
      template_id: 23,
      kv: [
        { key: '#DESC#', value: '描述' },
        { key: '#LIST#', obj: [{ obj_kv: [{ key: 'desc', value: 'item' }] }] },
      ],
    },
  });
  check(
    'ARK 的 kv → obj → obj_kv 全链路可表达',
    goodArk.ok === true &&
      goodArk.message.ark.template_id === 23 &&
      goodArk.message.ark.kv?.[0]?.value === '描述' &&
      goodArk.message.ark.kv?.[1]?.obj?.[0]?.obj_kv?.[0]?.value === 'item',
    JSON.stringify(goodArk.ok === true ? goodArk.message.ark : null),
  );

  const badArks = [
    [{ kind: 'ark', ark: { kv: [] } }, 'invalid_ark'],
    [{ kind: 'ark', ark: { template_id: 0 } }, 'invalid_ark'],
    [{ kind: 'ark', ark: { template_id: 1, kv: [{ value: 'x' }] } }, 'invalid_ark'],
    [{ kind: 'ark', ark: { template_id: 1, kv: [{ key: '#A#', obj: [{}] }] } }, 'invalid_ark'],
    [
      {
        kind: 'ark',
        ark: { template_id: 1, kv: [{ key: '#A#', obj: [{ obj_kv: [{ key: 'k' }] }] }] },
      },
      'invalid_ark',
    ],
  ];
  for (const [body, expected] of badArks) {
    const parsed = parseOutboundMessage(body);
    check(
      `非法 ARK 被拒（${expected}）`,
      parsed.ok === false && parsed.reason === expected,
      parsed.ok === true ? 'ok=true' : `reason=${parsed.reason}`,
    );
  }

  const goodEmbed = parseOutboundMessage({
    kind: 'embed',
    embed: {
      title: '标题',
      prompt: '提示',
      thumbnail: { url: 'https://example.com/i.png' },
      fields: [{ name: '字段一' }],
    },
  });
  check(
    'Embed 的 title / prompt / thumbnail / fields 都能表达',
    goodEmbed.ok === true &&
      goodEmbed.message.embed.thumbnail?.url === 'https://example.com/i.png' &&
      goodEmbed.message.embed.fields?.[0]?.name === '字段一',
    JSON.stringify(goodEmbed.ok === true ? goodEmbed.message.embed : null),
  );
  for (const [body, expected] of [
    [{ kind: 'embed', embed: { thumbnail: {} } }, 'invalid_embed'],
    [{ kind: 'embed', embed: { fields: [{ value: 'x' }] } }, 'invalid_embed'],
    [{ kind: 'embed', embed: { title: 1 } }, 'invalid_embed'],
  ]) {
    const parsed = parseOutboundMessage(body);
    check(
      `非法 Embed 被拒（${expected}）`,
      parsed.ok === false && parsed.reason === expected,
      parsed.ok === true ? 'ok=true' : `reason=${parsed.reason}`,
    );
  }

  // 1c) 分片的协议防御。offset 完全依赖 (index - 1) * block_size，index 一错就会静默
  // 上传错误的字节范围 —— 那比直接失败糟糕得多，所以宁可拒绝整个上传。
  const badPartSets = [
    [[], 4, 8, '没有任何 parts'],
    [[{ index: 0, presigned_url: 'u' }], 4, 8, 'index 必须为正整数'],
    [[{ index: -1, presigned_url: 'u' }], 4, 8, 'index 必须为正整数'],
    [[{ index: 1, presigned_url: 'u' }, { index: 1, presigned_url: 'v' }], 4, 8, 'index 重复'],
    [[{ index: 1, presigned_url: '' }], 4, 8, '缺少 presigned_url'],
    [[{ index: 3, presigned_url: 'u' }], 4, 8, 'offset 超出文件大小'],
    [[{ index: 1, presigned_url: 'u' }], 4, 8, '分片不完整'],
  ];
  for (const [parts, block, size, label] of badPartSets) {
    let thrown = null;
    try {
      validateParts(parts, block, size);
    } catch (error) {
      thrown = error;
    }
    check(
      `非法分片集合被拒（${label}）`,
      thrown !== null && thrown.name === 'MediaUploadError',
      thrown === null ? '没有抛错' : `${thrown.name}: ${thrown.message}`,
    );
  }
  let validPartsThrew = false;
  try {
    validateParts([{ index: 2, presigned_url: 'v' }, { index: 1, presigned_url: 'u' }], 4, 8);
  } catch {
    validPartsThrew = true;
  }
  check('乱序但完整的 parts 通过校验（不靠数组顺序）', validPartsThrew === false, '');
  check(
    'offset 由 (index - 1) * block_size 计算，最后一片取剩余长度',
    getPartRange({ index: 1 }, 100, 250).offset === 0 &&
      getPartRange({ index: 2 }, 100, 250).length === 100 &&
      getPartRange({ index: 3 }, 100, 250).offset === 200 &&
      getPartRange({ index: 3 }, 100, 250).length === 50,
    JSON.stringify(getPartRange({ index: 3 }, 100, 250)),
  );

  // 1d) 错误分类：本地上传失败必须有自己的 reason，而不是统统 unknown。
  const uploadError = new MediaUploadError('分片上传被拒绝：HTTP 403', 'part_upload');
  check(
    'MediaUploadError 归到 media_upload，并且带上 stage',
    describeSendFailure(uploadError) === 'media_upload' &&
      uploadError.message.includes('stage=part_upload'),
    `${describeSendFailure(uploadError)} / ${uploadError.message}`,
  );
  check(
    '平台错误没有被上传链路吞掉：ApiError 的分类照旧',
    describeSendFailure(
      new ApiError({
        httpStatus: 200,
        path: '/x',
        errCode: 40034005,
        traceId: null,
        body: null,
        detail: '',
      }),
    ) === 'window_expired',
    '',
  );

  // 2) 出站模型 → 协议字段的映射。用假 sender 截住真正会发出去的 body。
  const recorded = [];
  const fakeSender = {
    sendGroupMessage: async (id, body) => {
      recorded.push({ scope: 'group', id, body });
      return { messageId: 'm1', timestamp: 't' };
    },
    sendC2CMessage: async (id, body) => {
      recorded.push({ scope: 'c2c', id, body });
      return { messageId: 'm2', timestamp: 't' };
    },
    uploadGroupMedia: async (params) => {
      recorded.push({ upload: params });
      return { file_info: 'fake-info' };
    },
    uploadC2CMedia: async (params) => {
      recorded.push({ upload: params });
      return { file_info: 'fake-info' };
    },
  };

  await sendOutbound(fakeSender, 'group', 'g1', { kind: 'markdown', markdown: '**x**' }, { msgId: 'e1', msgSeq: 2 });
  const markdown = recorded[0]?.body;
  check(
    'markdown → msg_type=2，并带上内核补的 msg_id / msg_seq',
    markdown?.msg_type === 2 &&
      markdown?.markdown?.content === '**x**' &&
      markdown?.msg_id === 'e1' &&
      markdown?.msg_seq === 2,
    JSON.stringify(markdown ?? null),
  );
  await sendOutbound(fakeSender, 'group', 'g1', { kind: 'text', text: 'hi', referenceMessageId: 'r1' });
  check(
    '引用回复是 body 字段，不是独立接口；msg_seq 缺省为 1',
    recorded[1]?.body?.message_reference?.message_id === 'r1' && recorded[1]?.body?.msg_seq === 1,
    JSON.stringify(recorded[1]?.body ?? null),
  );
  await sendOutbound(fakeSender, 'c2c', 'u1', { kind: 'media', fileType: MediaFileType.VOICE, data: 'QUFB' });
  check(
    '富媒体走「先上传拿 file_info 再发 msg_type=7」，不把二进制塞进 /messages',
    recorded[2]?.upload?.fileType === 3 &&
      recorded[3]?.body?.msg_type === 7 &&
      recorded[3]?.body?.media?.file_info === 'fake-info',
    JSON.stringify(recorded[3]?.body ?? null),
  );

  // 3) 真链路：路由形状 + 整文件上传 + 自动分片上传（都打到替身后端）。
  const mediaMock = await startMockQq({
    // 乱序返回 parts，并让每个 COS PUT 停 150ms —— 前者验证「字节范围只看 part.index」，
    // 后者验证「分片真的在并发上传」。
    shuffleParts: true,
    partConcurrency: 3,
    cosPutDelayMs: 150,
  });
  const mediaBaseBefore = getApiBase();
  setApiBase(mediaMock.baseUrl);
  try {
    check(
      '所有会话消息归一到 /messages',
      messagePath('group', 'g1') === `${mediaMock.baseUrl}/v2/groups/g1/messages` &&
        messagePath('c2c', 'u1') === `${mediaMock.baseUrl}/v2/users/u1/messages`,
      messagePath('group', 'g1'),
    );
    check(
      '上传与分片端点按会话对称，完成接口复用 /files',
      mediaUploadPath('group', 'g1').endsWith('/v2/groups/g1/files') &&
        uploadPreparePath('c2c', 'u1').endsWith('/v2/users/u1/upload_prepare') &&
        uploadPartFinishPath('group', 'g1').endsWith('/v2/groups/g1/upload_part_finish'),
      '',
    );
    check(
      '撤回复用同一路径 + messageId',
      recallPath('group', 'g1', 'm1').endsWith('/v2/groups/g1/messages/m1'),
      recallPath('group', 'g1', 'm1'),
    );

    const api = new QQApiClient({ tokenManager: new TokenManager({ appId: 'x', clientSecret: 'y' }) });
    await api.sendGroupArk({ groupOpenid: 'g1', ark: { template_id: 7 } });
    await api.sendGroupEmbed({ groupOpenid: 'g1', embed: { title: 'T' } });
    await api.sendGroupKeyboard({ groupOpenid: 'g1', content: '请选择', keyboard: { id: 'k1' } });
    const kinds = mediaMock.state.sends.map((s) => s.body?.msg_type);
    check(
      'ARK / Embed / Keyboard 都走同一个发送端点，只有 msg_type 不同',
      kinds.join(',') === '3,4,0',
      kinds.join(','),
    );
    check(
      'keyboard 是 body 字段而不是独立接口',
      mediaMock.state.sends[2]?.body?.keyboard?.id === 'k1',
      JSON.stringify(mediaMock.state.sends[2]?.body ?? null),
    );

    await api.sendC2CInputNotify({ userOpenid: 'u1', inputSecond: 30 });
    const typing = mediaMock.state.c2cSends[0]?.body;
    check(
      '输入状态是 msg_type=6，不是媒体消息',
      typing?.msg_type === 6 && typing?.input_notify?.input_second === 30,
      JSON.stringify(typing ?? null),
    );

    // 小文件：整文件上传，URL 交给平台自己下载。
    await api.sendGroupImage({ groupOpenid: 'g1', url: 'https://example.com/a.png' });
    const simpleUpload = mediaMock.state.uploads[0];
    check(
      'URL 模式完全不碰本地内容：不发 upload_prepare，也没有任何分片请求',
      simpleUpload?.body?.url === 'https://example.com/a.png' &&
        simpleUpload?.body?.srv_send_msg === false &&
        mediaMock.state.prepares.length === 0 &&
        mediaMock.state.cosPuts.length === 0,
      JSON.stringify(simpleUpload?.body ?? null),
    );
    check(
      '上传完拿 file_info 发 msg_type=7',
      mediaMock.state.sends.at(-1)?.body?.media?.file_info === 'mock-file-info',
      JSON.stringify(mediaMock.state.sends.at(-1)?.body ?? null),
    );

    // 本地模式 ≥5 MiB 自动分片。用 localPath 验证「流式摘要 + 分片随机读取」：
    // 6 MiB 的文件全程不整体驻留内存，分片才按 offset 读。
    const bigSize = CHUNKED_UPLOAD_THRESHOLD_BYTES + 1024 * 1024;
    const bigBytes = Buffer.allocUnsafe(bigSize);
    for (let i = 0; i < bigSize; i += 1) bigBytes[i] = i % 251;
    const tempDir = mkdtempSync(join(tmpdir(), 'icy-smoke-'));
    const bigPath = join(tempDir, 'report.pdf');
    writeFileSync(bigPath, bigBytes);

    const blockSize = 4 * 1024 * 1024;
    const md5Of = (bytes) => createHash('md5').update(bytes).digest('hex');

    try {
      await api.sendGroupFile({ groupOpenid: 'g1', localPath: bigPath, fileName: 'report.pdf' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const prepare = mediaMock.state.prepares[0]?.body;
    check(
      'localPath 分片：prepare 带上整个文件的 md5 / sha1 / md5_10m（流式扫描得到）',
      prepare?.file_size === bigSize &&
        prepare?.md5 === md5Of(bigBytes) &&
        prepare?.sha1 === createHash('sha1').update(bigBytes).digest('hex') &&
        prepare?.md5_10m === prepare?.md5,
      JSON.stringify(prepare ?? null),
    );

    const putsByPath = new Map(mediaMock.state.cosPuts.map((put) => [put.path, put]));
    check(
      '分片字节范围由 part.index 决定，与 parts 数组顺序无关（此处故意乱序返回）',
      putsByPath.get('/mock-cos/1')?.md5 === md5Of(bigBytes.subarray(0, blockSize)) &&
        putsByPath.get('/mock-cos/2')?.md5 === md5Of(bigBytes.subarray(blockSize)),
      `paths=${[...putsByPath.keys()].join(',')}`,
    );
    check(
      '分片 PUT 不带 QQ Bot 鉴权头（否则 COS 判签名不匹配）',
      mediaMock.state.cosPuts.length === 2 &&
        mediaMock.state.cosPuts.every((put) => put.authorization === null),
      JSON.stringify(mediaMock.state.cosPuts.map((put) => put.authorization)),
    );

    const arrivalTimes = mediaMock.state.cosPuts.map((put) => put.at).sort((a, b) => a - b);
    check(
      '分片按 prepare 的 concurrency 并发上传（串行的话第二个会晚 150ms 以上）',
      mediaMock.state.cosPuts.length === 2 && arrivalTimes[1] - arrivalTimes[0] < 100,
      `间隔=${arrivalTimes[1] - arrivalTimes[0]}ms`,
    );

    const finishes = [...mediaMock.state.partFinishes].sort(
      (a, b) => a.body.part_index - b.body.part_index,
    );
    check(
      'part_finish 按 part.index 上报，最后一片用实际上传长度',
      finishes.length === 2 &&
        finishes[0]?.body?.part_index === 1 &&
        finishes[0]?.body?.block_size === blockSize &&
        finishes[1]?.body?.part_index === 2 &&
        finishes[1]?.body?.block_size === bigSize - blockSize &&
        finishes[1]?.body?.md5 === md5Of(bigBytes.subarray(blockSize)),
      JSON.stringify(finishes.map((p) => p.body)),
    );
    check(
      '分片传完后重新 POST /files 带 upload_id（没有独立的 complete 接口）',
      mediaMock.state.completions.length === 1 &&
        mediaMock.state.completions[0]?.uploadId === 'mock-upload-1',
      JSON.stringify(mediaMock.state.completions),
    );
    check(
      '分片链路最终同样落到 msg_type=7，且全程走群聊端点',
      mediaMock.state.sends.at(-1)?.body?.msg_type === 7 &&
        mediaMock.state.prepares[0]?.scope === 'group',
      JSON.stringify(mediaMock.state.sends.at(-1)?.body ?? null),
    );

    // 并发度上限：服务端给 999 时，本地也必须夹在 MAX_CONCURRENT_PARTS。
    // 11 × 4 MiB = 44 MiB，刚好够看出峰值是 10 而不是 11。
    const clampMock = await startMockQq({ partConcurrency: 999, cosPutDelayMs: 300 });
    const clampBaseBefore = getApiBase();
    const clampDir = mkdtempSync(join(tmpdir(), 'icy-clamp-'));
    const clampPath = join(clampDir, 'big.bin');
    writeFileSync(clampPath, Buffer.alloc(11 * 4 * 1024 * 1024, 0x43));
    setApiBase(clampMock.baseUrl);
    try {
      await api.sendGroupFile({ groupOpenid: 'g9', localPath: clampPath, fileName: 'big.bin' });
    } finally {
      rmSync(clampDir, { recursive: true, force: true });
      setApiBase(clampBaseBefore);
      clampMock.close();
    }
    check(
      `服务端建议 999 并发时本地仍夹在 ${MAX_CONCURRENT_PARTS}`,
      MAX_CONCURRENT_PARTS === 10 &&
        clampMock.state.cosPuts.length === 11 &&
        // 11 个分片：不夹的话峰值会是 11；夹住之后不可能超过 10。
        clampMock.state.cosPeakInFlight <= MAX_CONCURRENT_PARTS &&
        clampMock.state.cosPeakInFlight >= 2,
      `peak=${clampMock.state.cosPeakInFlight} puts=${clampMock.state.cosPuts.length}`,
    );
  } finally {
    setApiBase(mediaBaseBefore);
    mediaMock.close();
  }
} catch (error) {
  failures += 1;
  process.stderr.write(
    `发送能力自检抛异常：${error && error.stack ? error.stack : String(error)}\n`,
  );
}

process.exit(failures === 0 ? 0 : 1);