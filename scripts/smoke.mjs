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

import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Dispatcher } from '../dist/core/dispatch.js';
import { Deduper, dedupeKey } from '../dist/core/dedupe.js';
import { closeAction } from '../dist/core/events.js';
import { conversationKey, normalize, parseSceneExt } from '../dist/core/normalize.js';
import { ReplyRegistry } from '../dist/core/pending.js';
import { aggregateIntents } from '../dist/host/manifest.js';
import { discoverPlugins, PluginCatalog } from '../dist/host/registry.js';
import { Supervisor } from '../dist/host/supervisor.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..', 'plugins');

let failures = 0;
const logs = [];

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  const suffix = detail === '' ? '' : ` — ${detail}`;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}\n`);
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
  const catalog = new PluginCatalog(manifests);
  const replies = new ReplyRegistry();
  const delivered = [];
  let hostReplyCalls = 0;

  const supervisor = new Supervisor(catalog, {
    catalog,
    bot: { id: 'smoke-app-id' },
    log: (level, message) => logs.push(`${level} ${message}`),
    onReply: async (_pluginName, params) => {
      const resolution = replies.resolve(params.handleId, params.text);
      if (!resolution.ok) {
        return { ok: false, reason: resolution.error.reason, detail: resolution.error.detail };
      }
      hostReplyCalls += 1;
      delivered.push(resolution.instruction.content);
      return { ok: true, messageId: 'smoke-async', msgSeq: resolution.instruction.msgSeq };
    },
    onSend: async () => ({ ok: false, detail: '冒烟自检不使用主动消息' }),
  });

  await supervisor.startAll();
  check('echo 进入 running', supervisor.stateOf('echo') === 'running', `state=${supervisor.stateOf('echo')}`);
  check('没有插件被隔离', supervisor.quarantined.length === 0, supervisor.quarantined.join(', '));

  // ------------------------------------------------------- 事件投递与回复
  const dispatcher = new Dispatcher({
    plugins: supervisor.endpoints(),
    replies,
    log: (level, message) => logs.push(`${level} ${message}`),
    send: async (instruction) => {
      delivered.push(instruction.content);
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

  check('非群消息不产生被动窗口', replies.register({ kind: 'c2c', eventId: 'x', eventType: 'C2C_MESSAGE_CREATE', seq: 1, raw: {} }) === null);

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

  // ------------------------------------------- 崩溃重启与 quarantine（P6 加固）
  const crashManifests = await discoverPlugins(resolve(here, 'fixtures'));
  check(
    '发现 crasher 夹具',
    crashManifests.length === 1 && crashManifests[0].name === 'crasher',
    crashManifests.map((m) => m.name).join(', ') || '（空）',
  );

  const crashCatalog = new PluginCatalog(crashManifests);
  const crashSupervisor = new Supervisor(crashCatalog, {
    catalog: crashCatalog,
    bot: { id: 'smoke-app-id' },
    log: (level, message) => logs.push(`[crasher] ${level} ${message}`),
    onReply: async () => ({ ok: false, reason: 'unused', detail: '夹具不回消息' }),
    onSend: async () => ({ ok: false, detail: '夹具不用主动消息' }),
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

  // ------------------------------------------------------------------ 关停
  await supervisor.stopAll();
  check('echo 已停止', supervisor.stateOf('echo') === 'stopped', `state=${supervisor.stateOf('echo')}`);
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
process.exit(failures === 0 ? 0 : 1);