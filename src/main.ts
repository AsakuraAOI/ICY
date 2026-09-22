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
import { FatalError } from './core/errors.js';
import { Gateway } from './core/gateway.js';
import { normalize } from './core/normalize.js';
import { ReplyRegistry } from './core/pending.js';
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

  const supervisor = new Supervisor(catalog, {
    catalog,
    // username 要等 READY 才知道，这里先只给 AppID，插件也没理由需要更多。
    bot: { id: config.appId },
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

      const { groupOpenid, content, msgId, msgSeq } = resolution.instruction;
      try {
        const sent = await api.sendGroupText({ groupOpenid, content, msgId, msgSeq });
        log('info', `插件 ${pluginName} 异步回复已发出 msg_id=${sent.messageId} msg_seq=${msgSeq}`);
        return { ok: true, messageId: sent.messageId, msgSeq };
      } catch (error) {
        return { ok: false, reason: 'send_failed', detail: describe(error) };
      }
    },
    onSend: async (pluginName, params) => {
      try {
        const sent = await api.sendGroupText({
          groupOpenid: params.groupOpenid,
          content: params.text,
        });
        log('info', `插件 ${pluginName} 主动消息已发出 msg_id=${sent.messageId}`);
        return { ok: true, messageId: sent.messageId };
      } catch (error) {
        return { ok: false, detail: describe(error) };
      }
    },
    onQuarantine: (pluginName, reason) => {
      log('error', `插件 ${pluginName} 已隔离：${reason}`);
    },
  });

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
      const sent = await api.sendGroupText({
        groupOpenid: instruction.groupOpenid,
        content: instruction.content,
        msgId: instruction.msgId,
        msgSeq: instruction.msgSeq,
      });
      log('info', `已回复 msg_id=${sent.messageId} msg_seq=${instruction.msgSeq}`);
    },
  });

  const transport = new BuiltinWsTransport();
  let gateway: Gateway;
  let closing = false;

  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    log('info', '正在关停…');
    gateway.stop();
    await dispatcher.drain();
    await supervisor.stopAll();
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

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : describe(error);
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(1);
});