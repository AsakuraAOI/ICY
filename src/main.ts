/**
 * 入口：读配置 → 发现并聚合 intents → 拉起插件 → 连接 Gateway。
 *
 * 顺序是有约束的（DESIGN.md §6.1）：intents 是连接级参数，Identify 时一次性打包，
 * 运行中改不了。所以必须先扫完所有 manifest、聚合完 intents、报出需要申请权限的
 * 那些，再建连。反过来做只会在连上之后被 4014 关掉。
 *
 * 关停顺序同样是约束：先停收事件（Gateway），再放干在途事件（Dispatcher），
 * 最后停插件。反过来会让插件在退出途中还在等一个永远不会来的发送结果。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigError, loadConfig } from './config.js';
import { QQApiClient } from './core/api.js';
import { Deduper, dedupeKey } from './core/dedupe.js';
import { Dispatcher, type LogLevel } from './core/dispatch.js';
import { FatalError, describeSendFailure } from './core/errors.js';
import { Gateway } from './core/gateway.js';
import { normalize } from './core/normalize.js';
import { ReplyRegistry, type ReplyInstruction } from './core/pending.js';
import { SendThrottle } from './core/throttle.js';
import { getApiBase, setApiBase } from './core/routes.js';
import { TokenManager } from './core/token.js';
import { BuiltinWsTransport, builtinWebSocketCtor } from './core/transport.js';
import { aggregateIntents, intentsNeedingApproval } from './host/manifest.js';
import { discoverPlugins, PluginCatalog } from './host/registry.js';
import { Supervisor } from './host/supervisor.js';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(min: LogLevel): (level: LogLevel, message: string) => void {
  const floor = LEVEL_ORDER[min];
  return (level, message) => {
    if (LEVEL_ORDER[level] < floor) return;
    // 内核日志一律走 stderr：stdout 留给插件协议帧（marshal 层也可能用）。
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
  };
}

/**
 * 极简 .env 读取：只填环境里缺的键，不做变量展开、不支持多行值。
 * 生产环境用真实环境变量，这个函数只是本地开发的便利。
 */
function loadDotEnv(file: string, env: NodeJS.ProcessEnv): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // 没有 .env 是正常情况。
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
}

async function main(): Promise<void> {
  loadDotEnv(resolve(process.cwd(), '.env'), process.env);

  const config = loadConfig();
  const log = createLogger(config.logLevel);
  log('info', `icy 启动 node=${process.version} cwd=${process.cwd()}`);

  // 基址覆盖必须先于任何请求：端到端自检靠它把内核指向本地替身。
  if (config.apiBase !== '') {
    setApiBase(config.apiBase);
    log('info', `OpenAPI 基址覆盖为 ${getApiBase()}`);
  }

  // 启动即探测，不做静默降级：没有内置 WebSocket 就直接退出，而不是连到一半才炸。
  if (builtinWebSocketCtor() === null) {
    throw new FatalError(
      '当前 Node 运行时没有内置 WebSocket（需要 Node ≥ 22）。请升级 Node，或为 WsTransport 提供 ws 适配实现。',
    );
  }

  const manifests = await discoverPlugins(config.pluginDir);
  if (manifests.length === 0) {
    throw new FatalError(`插件目录里没有发现任何插件：${resolve(config.pluginDir)}`);
  }

  const catalog = new PluginCatalog(manifests);
  const intents = aggregateIntents(manifests);
  const needApproval = intentsNeedingApproval(intents);
  if (needApproval.length > 0) {
    log(
      'warn',
      `以下 intents 需要在 QQ 开放平台申请权限，否则 Identify 后会被关连接（4014）：${needApproval.join(' / ')}`,
    );
  }
  log('info', `发现 ${manifests.length} 个插件 intents=${intents.join(' / ')}`);

  const tokens = new TokenManager({
    appId: config.appId,
    clientSecret: config.appSecret.expose(),
  });
  const api = new QQApiClient({ tokenManager: tokens });
  const replies = new ReplyRegistry();
  const deduper = new Deduper();
  // 主动消息的唯一闸门。被动回复由平台窗口兜底，主动消息没有，只能在这里拦。
  const throttle = new SendThrottle(config.sendLimits);

  // P1：凭证是否真的可用只有 /users/@me 能证明。拿到的 username 一并带给插件，
  // 这样插件日志里显示的是机器人名字而不是一串 AppID。失败不阻断启动 —— 这条
  // 链路挂了不代表发送链路挂了，记日志即可。
  let botUsername: string | undefined;
  try {
    const self = await api.getSelfInfo();
    botUsername = self.username;
    log(
      'info',
      `机器人凭证可用 id=${self.id}${self.username === undefined ? '' : ` username=${self.username}`}`,
    );
  } catch (error) {
    log('warn', `机器人自身信息获取失败（不阻断启动）：${describe(error)}`);
  }

  /**
   * 被动回复的唯一出口。
   *
   * 群聊与单聊的定位字段不同，但窗口、msg_id、msg_seq 语义完全一致，所以分流只
   * 发生在这里，其余代码（句柄校验、发送、日志）两条路径共用。
   */
  const sendReply = async (instruction: ReplyInstruction) => {
    if (instruction.scope === 'c2c') {
      return api.sendC2CText({
        userOpenid: instruction.userOpenid,
        content: instruction.content,
        msgId: instruction.msgId,
        msgSeq: instruction.msgSeq,
      });
    }
    return api.sendGroupText({
      groupOpenid: instruction.groupOpenid,
      content: instruction.content,
      msgId: instruction.msgId,
      msgSeq: instruction.msgSeq,
    });
  };

  const supervisor = new Supervisor(catalog, {
    catalog,
    bot: botUsername === undefined ? { id: config.appId } : { id: config.appId, username: botUsername },
    log,
    onReply: async (pluginName, params) => {
      const resolution = replies.resolve(params.handleId, params.text);
      if (!resolution.ok) {
        log(
          'warn',
          `插件 ${pluginName} 的异步回复被内核拒绝：${resolution.error.reason} — ${resolution.error.detail}`,
        );
        return { ok: false, reason: resolution.error.reason, detail: resolution.error.detail };
      }

      const instruction = resolution.instruction;
      try {
        const sent = await sendReply(instruction);
        log(
          'info',
          `插件 ${pluginName} 异步回复已发出 msg_id=${sent.messageId} msg_seq=${instruction.msgSeq}`,
        );
        return { ok: true, messageId: sent.messageId, msgSeq: instruction.msgSeq };
      } catch (error) {
        // reason 是稳定枚举，插件据此决定「重试」还是「放弃」；detail 只给人看。
        const reason = describeSendFailure(error);
        log('warn', `插件 ${pluginName} 的异步回复发送失败：${reason} — ${describe(error)}`);
        return { ok: false, reason, detail: describe(error) };
      }
    },
    onSend: async (pluginName, params) => {
      // 频控必须在请求之前：放过去再处理限流错误，等于让插件的行为已经打到平台了。
      // 会话键带 scope：群 openid 与用户 openid 是两套 ID 空间，不区分会互相污染额度。
      const key =
        params.scope === 'c2c' ? `c2c:${params.userOpenid}` : `group:${params.groupOpenid}`;
      const gate = throttle.take(key);
      if (!gate.ok) {
        log(
          'warn',
          `插件 ${pluginName} 的主动消息被频控拒绝：${gate.reason}（上限 ${gate.limit} 条/窗口，约 ${Math.ceil(gate.retryAfterMs / 1000)} 秒后可重试）`,
        );
        return { ok: false, detail: `rate_limited:${gate.reason}` };
      }

      try {
        const sent =
          params.scope === 'c2c'
            ? await api.sendC2CText({ userOpenid: params.userOpenid, content: params.text })
            : await api.sendGroupText({ groupOpenid: params.groupOpenid, content: params.text });
        log(
          'info',
          `插件 ${pluginName} 主动消息已发出 scope=${params.scope} msg_id=${sent.messageId}`,
        );
        return { ok: true, messageId: sent.messageId };
      } catch (error) {
        const reason = describeSendFailure(error);
        log('warn', `插件 ${pluginName} 的主动消息发送失败：${reason} — ${describe(error)}`);
        return { ok: false, detail: `${reason}: ${describe(error)}` };
      }
    },
    onQuarantine: (pluginName, reason) => {
      log('error', `插件 ${pluginName} 已隔离：${reason}`);
    },
  });

  // 从这里开始子进程已经存在，任何后续失败都必须先把它们收干净。
  activeSupervisor = supervisor;

  await supervisor.startAll();

  const quarantined = supervisor.quarantined;
  if (quarantined.length === manifests.length) {
    throw new FatalError(`全部插件都启动失败：${quarantined.join(' / ')}`);
  }
  if (quarantined.length > 0) {
    // 部分失败不阻断启动：其余插件仍可用，隔离的那个只在日志里报。
    log('warn', `有插件被隔离，不参与事件投递：${quarantined.join(' / ')}`);
  }

  const dispatcher = new Dispatcher({
    plugins: supervisor.endpoints(),
    replies,
    log,
    send: async (instruction) => {
      try {
        const sent = await sendReply(instruction);
        log('info', `已回复 msg_id=${sent.messageId} msg_seq=${instruction.msgSeq}`);
      } catch (error) {
        // 同步回复路径的失败在这里翻译成稳定 reason 并落日志。不再往上抛：
        // Dispatcher 收到后只会把它原样再记一遍，而它的日志里拿不到 reason，
        // 等于把刚翻译好的信息丢掉。
        log('warn', `被动回复发送失败：${describeSendFailure(error)} — ${describe(error)}`);
      }
    },
  });

  const transport = new BuiltinWsTransport();
  let gateway: Gateway;
  let closing = false;

  /**
   * 关停看门狗。
   *
   * 关停本身不能变成新的悬挂点：dispatcher.drain() 等的是在途事件，而单事件上限是
   * 4.5 分钟。如果 drain() 或 stopAll() 卡住，进程会一直挂在这里，上层只能 SIGKILL ——
   * 那时插件子进程反而会被留下当孤儿。所以到点强制退出：宁可放弃在途事件，
   * 也不留下一个谁也杀不掉的进程。
   */
  const SHUTDOWN_WATCHDOG_MS = 20_000;

  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    log('info', '正在关停…');

    const watchdog = setTimeout(() => {
      log('error', `关停超过 ${SHUTDOWN_WATCHDOG_MS / 1000} 秒仍未完成，强制退出`);
      process.exit(code === 0 ? 1 : code);
    }, SHUTDOWN_WATCHDOG_MS);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    gateway.stop();
    await dispatcher.drain();
    await supervisor.stopAll();
    clearTimeout(watchdog);
    log('info', '已关停');
    process.exit(code);
  };

  gateway = new Gateway(transport, {
    tokenManager: tokens,
    intents,
    log,
    onDispatch: (payload) => {
      const event = normalize(payload);
      if (event === null) return;

      const key = dedupeKey(event);
      if (!deduper.accept(key)) {
        log('debug', `丢弃重复事件 ${key}`);
        return;
      }
      dispatcher.submit(event);
    },
    onReady: (sessionId) => {
      log('info', `Gateway 就绪 session_id=${sessionId}`);
    },
    onFatal: (error) => {
      log('error', error.message);
      void shutdown(1);
    },
  });

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  // 未捕获异常与未处理的 reject 也必须走关停，而不是让进程带崩退出。插件是子进程，
  // 内核消失并不会带走它们；而且带崩退出会让日志断在半截，事后完全看不出发生了什么。
  process.on('uncaughtException', (error) => {
    log('error', `未捕获异常：${describe(error)}`);
    void shutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    log('error', `未处理的 Promise 拒绝：${describe(reason)}`);
    void shutdown(1);
  });
  // Windows 无法向子进程投递 SIGTERM（child.kill 会退化成强杀），所以上层宿主
  // 想走真实关停路径时，用 spawn 时的 IPC 通道发 {type:'shutdown'}。这个监听
  // 只有在带 IPC 通道启动时才会被触发，不影响普通前台运行。
  process.on('message', (message: unknown) => {
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'shutdown'
    ) {
      void shutdown(0);
    }
  });

  await gateway.start();
  log('info', '已连接 Gateway，等待 Hello → Identify → READY');
}

/**
 * 已创建的 Supervisor（模块级）。
 *
 * 启动后期的失败走不到 shutdown()：main() 直接 reject，由下面的 catch 兜底。
 * 那时插件子进程可能已经起来了，不回收就会变成孤儿进程 —— 父进程没了，而它们的
 * stdin 仍然是开着的，插件自己不会退出（echo 之外的自定义插件未必监听 stdin end）。
 */
let activeSupervisor: Supervisor | null = null;

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

main().catch(async (error: unknown) => {
  const message = error instanceof ConfigError ? error.message : describe(error);
  process.stderr.write(`[fatal] ${message}\n`);

  if (activeSupervisor !== null) {
    try {
      await activeSupervisor.stopAll();
      process.stderr.write('[fatal] 已回收插件进程\n');
    } catch (stopError) {
      process.stderr.write(`[fatal] 回收插件失败：${describe(stopError)}\n`);
    }
  }
  process.exit(1);
});