#!/usr/bin/env node
/**
 * App Runtime v0 自检。
 *
 * 两层验证，两个都不能省：
 *
 * 1. **单元级**：直接驱动 Application / DependencyGraph / ServiceRegistry /
 *    EventBus / MessagePipeline。这一层能精确构造失败场景（环、缺依赖、重复
 *    service、start 失败、stop 失败、double next），是端到端测不出来的。
 * 2. **端到端**：真的把 app-runtime 当 ICY 插件跑起来，走
 *    Supervisor → SDK → 插件 onInit/onEvent → Application → MessagePipeline →
 *    模块 → PluginReplyInstruction → Supervisor 这条完整链路。
 *    只单测 Application 类是自欺：它证明不了插件把宿主接对了。
 *
 * 与 smoke.mjs 一样，这里 import 的是 dist/，所以必须先构建。
 *
 * 用法：node scripts/app-smoke.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Application,
  ApplicationError,
  ApplicationStartError,
  ApplicationStopError,
  buildDependencyGraph,
  createCoreModule,
  createEventBus,
  createMessagePipeline,
  defineEvent,
  defineModule,
  defineService,
  DependencyError,
  Events,
  Messages,
  MiddlewareError,
  PipelineReentryError,
  ServiceError,
  ServiceRegistry,
} from '../dist/app/index.js';
import { discoverPlugins, PluginCatalog } from '../dist/host/registry.js';
import { Supervisor } from '../dist/host/supervisor.js';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  const suffix = detail === '' ? '' : ` — ${detail}`;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}\n`);
}

function groupEvent(patch = {}) {
  return {
    kind: 'group',
    eventType: 'GROUP_AT_MESSAGE_CREATE',
    eventId: 'app-smoke-evt-1',
    seq: 1,
    messageId: 'app-smoke-msg-1',
    groupOpenid: 'app-smoke-group',
    senderId: 'app-smoke-user',
    content: 'ping',
    raw: {},
    ...patch,
  };
}

/** 造一个只记录生命周期调用序列的模块。 */
function probeModule(name, options = {}) {
  return defineModule({
    name,
    version: '1.0.0',
    requires: options.requires,
    optional: options.optional,
    setup(ctx) {
      options.trace?.push(`setup:${name}`);
      options.setup?.(ctx);
    },
    start(ctx) {
      options.trace?.push(`start:${name}`);
      options.start?.(ctx);
    },
    stop(ctx) {
      options.trace?.push(`stop:${name}`);
      options.stop?.(ctx);
    },
  });
}

// ------------------------------------------------------------------ 依赖图
{
  const graph = buildDependencyGraph([
    { name: 'c', requires: ['b'], optional: [] },
    { name: 'a', requires: [], optional: [] },
    { name: 'b', requires: ['a'], optional: [] },
  ]);
  check('拓扑排序：依赖在前', graph.order.join('|') === 'a|b|c', graph.order.join('|'));

  const reverse = buildDependencyGraph([
    { name: 'a', requires: [], optional: [] },
    { name: 'b', requires: ['a'], optional: [] },
  ]);
  check('拓扑排序：注册顺序不影响结果', reverse.order.join('|') === 'a|b', reverse.order.join('|'));

  try {
    buildDependencyGraph([{ name: 'reminder', requires: ['scheduler'], optional: [] }]);
    check('缺失依赖被拒绝', false, '没有抛错');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      '缺失依赖报出 module / dependency 名字',
      error instanceof DependencyError &&
        error.code === 'missing_dependency' &&
        message.includes('module "reminder" requires missing module "scheduler"'),
      message.split('\n')[0],
    );
  }

  try {
    buildDependencyGraph([
      { name: 'a', requires: ['b'], optional: [] },
      { name: 'b', requires: ['c'], optional: [] },
      { name: 'c', requires: ['a'], optional: [] },
    ]);
    check('依赖环被拒绝', false, '没有抛错');
  } catch (error) {
    check(
      '依赖环报出可读路径',
      error instanceof DependencyError &&
        error.code === 'cycle' &&
        error.cyclePath.length === 4 &&
        error.cyclePath[0] === error.cyclePath[error.cyclePath.length - 1],
      error instanceof DependencyError ? error.cyclePath.join(' → ') : String(error),
    );
  }

  const withOptional = buildDependencyGraph([
    { name: 'a', requires: [], optional: [] },
    { name: 'b', requires: [], optional: ['a', 'ghost'] },
  ]);
  check(
    'optional 只保留实际存在的依赖',
    withOptional.order.join('|') === 'a|b' &&
    (withOptional.optionalDependencies.get('b') ?? []).join('|') === 'a',
    withOptional.order.join('|'),
  );

  const missingOptional = buildDependencyGraph([
    { name: 'a', requires: [], optional: ['ghost'] },
  ]);
  check('optional 缺失不影响构建', missingOptional.order.join('|') === 'a');
}

// ------------------------------------------------------------- 生命周期顺序
{
  const trace = [];
  const app = new Application();
  app.add(probeModule('b', { requires: ['a'], trace }));
  app.add(probeModule('a', { trace }));
  app.add(probeModule('c', { requires: ['b'], trace }));

  await app.start();
  // Runtime 是「先全员 setup，再全员 start」（setup 阶段才允许注册 service，
  // 全员的 service 都注册完才能冻结）。所以 trace 一定是两段，
  // 而不是逐模块 setup→start 交错。
  check(
    'setup 与 start 各自按依赖顺序执行',
    trace.join('|') === 'setup:a|setup:b|setup:c|start:a|start:b|start:c',
    trace.join('|'),
  );
  check('Application 状态为 started', app.state === 'started', app.state);
  check('拓扑序已记录', app.dependencyOrder.join('|') === 'a|b|c', app.dependencyOrder.join('|'));

  try {
    await app.start();
    check('重复 start 被拒绝', false, '没有抛错');
  } catch (error) {
    check(
      '重复 start 被拒绝',
      error instanceof ApplicationError,
      error instanceof Error ? error.message : String(error),
    );
  }

  trace.length = 0;
  await app.stop();
  check(
    'stop 严格逆序',
    trace.join('|') === 'stop:c|stop:b|stop:a',
    trace.join('|'),
  );
  check('停止后状态为 stopped', app.state === 'stopped', app.state);

  try {
    await app.stop();
    check('重复 stop 被拒绝', false, '没有抛错');
  } catch (error) {
    check(
      '重复 stop 被拒绝',
      error instanceof ApplicationError,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// --------------------------------------------------- start 失败必须回滚
{
  const trace = [];
  const app = new Application();
  app.add(probeModule('a', { trace }));
  app.add(probeModule('b', { trace }));
  app.add(
    probeModule('c', {
      trace,
      start() {
        throw new Error('c 起不来');
      },
    }),
  );

  let caught = null;
  try {
    await app.start();
  } catch (error) {
    caught = error;
  }

  check('start 失败会抛出', caught instanceof ApplicationStartError);
  check(
    'start 失败报出模块与阶段',
    caught?.failure?.moduleName === 'c' && caught?.failure?.phase === 'start',
    caught instanceof Error ? caught.message : String(caught),
  );
  check(
    '已启动的模块被逆序回滚',
    // start:c 也在 trace 里：钩子被调用了才失败，所以「尝试过 c」必须可见，
    // 否则这条断言会把「c 根本没被 start」也放过去。
    trace.join('|') === 'setup:a|setup:b|setup:c|start:a|start:b|start:c|stop:b|stop:a',
    trace.join('|'),
  );
  check('失败后状态为 failed', app.state === 'failed', app.state);
  check(
    '失败后的模块状态不再有 started',
    app.modules.every((module) => module.status !== 'started'),
    app.modules.map((module) => `${module.name}:${module.status}`).join(', '),
  );

  // 回滚过之后 stop() 只改状态，不重跑 stop 钩子：否则模块会经历第二次停止。
  trace.length = 0;
  await app.stop();
  check('失败回滚后 stop 不重跑钩子', trace.length === 0, trace.join('|'));
  check('失败回滚后状态为 stopped', app.state === 'stopped', app.state);
}

// --------------------------------------------- 回滚中 stop 失败不中断清理
{
  const trace = [];
  const app = new Application();
  app.add(probeModule('a', { trace }));
  app.add(
    probeModule('b', {
      trace,
      stop() {
        throw new Error('b 清理失败');
      },
    }),
  );
  app.add(
    probeModule('c', {
      trace,
      start() {
        throw new Error('c 起不来');
      },
    }),
  );

  let caught = null;
  try {
    await app.start();
  } catch (error) {
    caught = error;
  }

  check('回滚期间的 stop 失败被聚合', caught instanceof ApplicationStartError && caught.rollbackFailures.length === 1);
  check(
    'b 的 stop 失败不影响 a 被停止',
    trace.includes('stop:a') && trace.includes('stop:b'),
    trace.join('|'),
  );
  check(
    'stop 失败的模块标记为 failed',
    app.modules.find((module) => module.name === 'b')?.status === 'failed',
    app.modules.find((module) => module.name === 'b')?.status ?? '缺失',
  );
}

// ------------------------------------------------------ ServiceRegistry 语义
{
  const registry = new ServiceRegistry();
  const token = defineService('demo.storage');
  const other = defineService('demo.other');

  registry.provide(token, { ok: true }, 'provider');
  check('provide / require 打通', registry.require(token, 'consumer').ok === true);
  check('owner 归属被记录', registry.ownerOf(token) === 'provider', String(registry.ownerOf(token)));
  check('has 反映存在性', registry.has(token) === true && registry.has(other) === false);

  check('get 缺失时返回 undefined', registry.get(other) === undefined);

  try {
    registry.require(other, 'consumer');
    check('require 缺失时抛错', false, '没有抛错');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      'require 缺失时报出 module 与 token',
      error instanceof ServiceError && message.includes('consumer') && message.includes('demo.other'),
      message,
    );
  }

  try {
    registry.provide(token, { ok: false }, 'intruder');
    check('重复 provide 被拒绝', false, '没有抛错');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      '重复 provide 报出两个 provider',
      error instanceof ServiceError && message.includes('provider') && message.includes('intruder'),
      message,
    );
  }

  registry.freeze();
  try {
    registry.provide(other, {}, 'late');
    check('冻结后 provide 被拒绝', false, '没有抛错');
  } catch (error) {
    check('冻结后 provide 被拒绝', error instanceof ServiceError, String(error));
  }
}

// -------------------------------------------------------------- EventBus
{
  const bus = createEventBus();
  const Seen = defineEvent('smoke.seen');
  const seen = [];

  const first = bus.on(Seen, (payload) => {
    seen.push(`first:${payload.value}`);
  });
  bus.on(
    Seen,
    () => {
      throw new Error('这个 listener 故意失败');
    },
    { id: 'boom', resources: { owner: 'angry', signal: new AbortController().signal } },
  );
  bus.on(Seen, async (payload) => {
    seen.push(`async:${payload.value}`);
  });

  const result = await bus.emit(Seen, { value: 1 });
  check('多 listener 都收到事件', result.delivered === 2, `delivered=${result.delivered}`);
  check('一个 listener 失败不影响其他', seen.join('|') === 'first:1|async:1', seen.join('|'));
  check(
    'emit 聚合失败并带 owner',
    result.failed.length === 1 && result.failed[0].owner === 'angry',
    result.failed.map((failure) => `${failure.owner}:${failure.error.message}`).join(', '),
  );

  const before = bus.size;
  first.dispose();
  check('unsubscribe 后 listener 减少', bus.size === before - 1, `size=${bus.size}`);

  // 模块停止时按 signal 自动摘除。
  const controller = new AbortController();
  bus.on(Seen, () => {}, { resources: { owner: 'module', signal: controller.signal } });
  const withModule = bus.size;
  controller.abort();
  check('signal abort 自动摘除 listener', bus.size === withModule - 1, `size=${bus.size}`);

  let rejected = false;
  try {
    bus.on(Seen, () => {}, {
      resources: { owner: 'late', signal: controller.signal },
    });
  } catch {
    rejected = true;
  }
  check('已停止模块不能再注册 listener', rejected);
}

// ---------------------------------------------------------- MessagePipeline
{
  const pipeline = createMessagePipeline();
  const order = [];
  const ctx = { host: {}, event: groupEvent(), reply: null, signal: new AbortController().signal };

  pipeline.use(async (context, next) => {
    order.push('late');
    return next();
  }, { priority: 5, id: 'late' });
  pipeline.use(async (context, next) => {
    order.push('early');
    return next();
  }, { priority: -5, id: 'early' });
  pipeline.use(async (context, next) => {
    order.push('same-1');
    return next();
  }, { priority: 0, id: 'same-1' });
  const sameTwo = pipeline.use(async (context, next) => {
    order.push('same-2');
    return next();
  }, { priority: 0, id: 'same-2' });

  check(
    'priority 顺序且同值稳定',
    pipeline.describe().join('|') === 'anonymous:early|anonymous:same-1|anonymous:same-2|anonymous:late',
    pipeline.describe().join('|'),
  );

  const result = await pipeline.dispatch(ctx);
  check('priority 决定执行顺序', order.join('|') === 'early|same-1|same-2|late', order.join('|'));
  check('无人消费时返回 null', result === null, JSON.stringify(result));

  sameTwo.dispose();
  check('middleware 可被释放', pipeline.size === 3, `size=${pipeline.size}`);

  // 消费语义：先到的直接返回，后面的 middleware 不再执行。
  const consume = createMessagePipeline();
  const visited = [];
  consume.use(async () => {
    visited.push('consumer');
    return { scope: 'group', body: { kind: 'text', text: 'pong' } };
  }, { priority: -10 });
  consume.use(async (context, next) => {
    visited.push('never');
    return next();
  });
  const consumed = await consume.dispatch(ctx);
  check('消费后不再往下走', visited.join('|') === 'consumer', visited.join('|'));
  check('返回的就是 ReplyInstruction', consumed?.body?.text === 'pong', JSON.stringify(consumed));

  // 出错必须带 owner / id。
  const boom = createMessagePipeline();
  boom.use(async () => {
    throw new Error('pipeline 内部炸了');
  }, { id: 'explode', resources: { owner: 'troublemaker', signal: new AbortController().signal } });
  let middlewareError = null;
  try {
    await boom.dispatch(ctx);
  } catch (error) {
    middlewareError = error;
  }
  check(
    'middleware 异常带 owner 与 id',
    middlewareError instanceof MiddlewareError &&
      middlewareError.owner === 'troublemaker' &&
      middlewareError.middlewareId === 'explode',
    middlewareError instanceof Error ? middlewareError.message : String(middlewareError),
  );

  // 同一个 middleware 调两次 next() 必须报错，而不是让下游跑两遍。
  const reentry = createMessagePipeline();
  let downstream = 0;
  reentry.use(async (context, next) => {
    await next();
    await next();
    return null;
  }, { id: 'twice', resources: { owner: 'greedy', signal: new AbortController().signal } });
  reentry.use(async (context, next) => {
    downstream += 1;
    return next();
  });
  let reentryError = null;
  try {
    await reentry.dispatch(ctx);
  } catch (error) {
    reentryError = error;
  }
  check('double next 被拒绝', reentryError instanceof PipelineReentryError, reentryError instanceof Error ? reentryError.message : String(reentryError));
  check('下游只跑一次', downstream === 1, `downstream=${downstream}`);
}

// ------------------------------------- 模块资源随 Application 停止自动释放
{
  const app = new Application();
  app.add(createCoreModule());
  // 本块自带的 event token：不能借用前面 EventBus 块里的 Seen —— 那个绑定在别的
  // 花括号作用域里，这里引用不到（这正是之前漏掉的地方）。
  const resourceSeen = defineEvent('smoke.resource.seen');
  let serviceToken = null;
  app.add(
    defineModule({
      name: 'resource-owner',
      version: '1.0.0',
      requires: ['core'],
      setup(ctx) {
        serviceToken = defineService('smoke.resource');
        ctx.provide(serviceToken, { ok: true });
        const events = ctx.services.require(Events);
        const messages = ctx.services.require(Messages);
        // resources: ctx.resources 是这条断言的全部意义所在：listener 挂在模块的
        // AbortController 上，模块停止时自动摘掉，模块自己不写清理代码。
        events.on(resourceSeen, () => {}, { id: 'resource', resources: ctx.resources });
        messages.use(async (context, next) => next(), { id: 'resource', resources: ctx.resources });
      },
    }),
  );
  app.add(
    defineModule({
      name: 'resource-user',
      version: '1.0.0',
      requires: ['resource-owner'],
      setup(ctx) {
        ctx.services.require(serviceToken);
      },
    }),
  );

  await app.start();
  const events = app.services.require(Events, 'probe');
  const messages = app.services.require(Messages, 'probe');
  check('模块注册的 listener 生效', events.size === 1, `size=${events.size}`);
  check('模块注册的 middleware 生效', messages.size === 1, `size=${messages.size}`);

  await app.stop();
  check('停止后 listener 被自动摘掉', events.size === 0, `size=${events.size}`);
  check('停止后 middleware 被自动摘掉', messages.size === 0, `size=${messages.size}`);
}

// ----------------------------------------- 端到端：Supervisor → app-runtime 插件
{
  const manifests = await discoverPlugins(resolve(here, '..', 'plugins'));
  const runtimeManifests = manifests.filter((manifest) => manifest.name === 'app-runtime');
  check(
    '发现 app-runtime 插件',
    runtimeManifests.length === 1,
    manifests.map((manifest) => manifest.name).join(', ') || '（空）',
  );

  const catalog = new PluginCatalog(runtimeManifests);
  const logs = [];
  const supervisor = new Supervisor(catalog, {
    catalog,
    bot: { id: 'app-smoke-app-id' },
    log: (level, message) => logs.push(`${level} ${message}`),
    onReply: async () => ({ ok: false, reason: 'unused', detail: '本自检只用同步回复' }),
    onSend: async () => ({ ok: false, detail: '本自检不用主动消息' }),
    onRecall: async () => ({ ok: false, reason: 'unused', detail: '本自检不用撤回' }),
  });

  await supervisor.startAll();
  check(
    'app-runtime 插件进入 running',
    supervisor.stateOf('app-runtime') === 'running',
    `state=${supervisor.stateOf('app-runtime')}`,
  );

  const endpoint = supervisor.endpoints()[0];
  check('拿到了 app-runtime 端点', endpoint?.name === 'app-runtime', String(endpoint?.name));

  const pong = await endpoint.dispatch(groupEvent({ content: 'ping' }), null);
  check(
    'ping → pong 走通整条链路',
    pong?.scope === 'group' && pong.message.text === 'pong',
    JSON.stringify(pong ?? null),
  );

  const count1 = await endpoint.dispatch(
    groupEvent({ eventId: 'app-smoke-evt-2', messageId: 'app-smoke-msg-2', content: 'count' }),
    null,
  );
  const count2 = await endpoint.dispatch(
    groupEvent({ eventId: 'app-smoke-evt-3', messageId: 'app-smoke-msg-3', content: 'count' }),
    null,
  );
  check(
    'Service 状态跨事件保留（count:1 → count:2）',
    count1?.message?.text === 'count:1' && count2?.message?.text === 'count:2',
    `${JSON.stringify(count1?.message ?? null)} / ${JSON.stringify(count2?.message ?? null)}`,
  );

  const ignored = await endpoint.dispatch(
    groupEvent({ eventId: 'app-smoke-evt-4', messageId: 'app-smoke-msg-4', content: 'nothing' }),
    null,
  );
  check('无人消费时插件返回 null', ignored === null, JSON.stringify(ignored));

  await supervisor.stopAll();
  check(
    'app-runtime 插件已停止',
    supervisor.stateOf('app-runtime') === 'stopped',
    `state=${supervisor.stateOf('app-runtime')}`,
  );
}

// ---------------------- 启动失败路径：Application.start 失败必须让插件起不来
{
  // v0 里最容易「看起来对」而实际没人钉住的一段：
  // config.modules 指向不存在的模块 → Application.start() 抛错 → 插件 onInit 抛错
  // → SDK 把 lifecycle/init 回成错误、不发 plugin/ready → Supervisor 不会把它
  // 当成 running。夹具复用真实插件的入口，只把 config 换坏，所以这条断言测的是
  // 真实代码路径，而不是一份「正好也会失败」的副本。
  const fixtures = await discoverPlugins(resolve(here, 'fixtures'));
  const brokenManifests = fixtures.filter((manifest) => manifest.name === 'app-runtime-broken');
  check(
    '发现 app-runtime 启动失败夹具',
    brokenManifests.length === 1,
    fixtures.map((manifest) => manifest.name).join(', ') || '（空）',
  );

  const catalog = new PluginCatalog(brokenManifests);
  const logs = [];
  const supervisor = new Supervisor(catalog, {
    catalog,
    bot: { id: 'app-smoke-broken-id' },
    log: (level, message) => logs.push(`${level} ${message}`),
    onReply: async () => ({ ok: false, reason: 'unused', detail: '本自检不用异步回复' }),
    onSend: async () => ({ ok: false, detail: '本自检不用主动消息' }),
    onRecall: async () => ({ ok: false, reason: 'unused', detail: '本自检不用撤回' }),
  });

  await supervisor.startAll();
  const state = supervisor.stateOf('app-runtime-broken');
  check('模块加载失败时插件不进入 running', state !== 'running', `state=${String(state)}`);
  check(
    '启动失败原因进了内核日志',
    logs.some((line) => line.includes('does-not-exist')),
    logs.join(' / ').slice(0, 400) || '（没有日志）',
  );

  await supervisor.stopAll();
  check(
    '失败插件已被收干净',
    supervisor.stateOf('app-runtime-broken') !== 'running',
    `state=${String(supervisor.stateOf('app-runtime-broken'))}`,
  );
}

process.exit(failures === 0 ? 0 : 1);