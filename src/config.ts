/**
 * 环境变量解析与校验。
 *
 * 规则：
 * - QQ_APP_ID / QQ_APP_SECRET 必填，缺了直接退出（调用方负责打印）。
 * - 这里只做读取与脱敏封装：secrets 以做法的方式持有，永不进日志。
 * - 生产环境用真实环境变量；本地开发时 main.ts 会先试读 .env。
 */

import { DEFAULT_THROTTLE_LIMITS, type ThrottleLimits } from './core/throttle.js';

export interface AppConfig {
  appId: string;
  /** 只在创建 TokenManager 的瞬间使用，不提供字符串形式的访问器。 */
  readonly appSecret: Secret;
  logLevel: LogLevel;
  pluginDir: string;
  /** OpenAPI 基址覆盖（QQ_API_BASE）。空串表示用 core/routes.ts 的默认值。 */
  apiBase: string;
  /** 主动消息频控额度。默认值由 core/throttle.ts 持有。 */
  sendLimits: ThrottleLimits;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 脱敏封装：toString / JSON.stringify 都不会泄出真值。 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** 唯一的取值通道，仅限内核内部一次性消费（如 token 请求）。 */
  expose(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appId = env.QQ_APP_ID?.trim() ?? '';
  if (appId === '') {
    throw new ConfigError('缺少 QQ_APP_ID。请在环境变量或 .env 中设置（模板见 .env.example）。');
  }

  const appSecret = env.QQ_APP_SECRET?.trim() ?? '';
  if (appSecret === '') {
    throw new ConfigError('缺少 QQ_APP_SECRET。请在环境变量或 .env 中设置（模板见 .env.example）。');
  }

  const logLevel = (env.LOG_LEVEL?.trim() ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL 只能是 ${LOG_LEVELS.join(' / ')}，当前为 ${logLevel}`);
  }

  return {
    appId,
    appSecret: new Secret(appSecret),
    logLevel,
    pluginDir: env.PLUGIN_DIR?.trim() ?? './plugins',
    apiBase: env.QQ_API_BASE?.trim() ?? '',
    sendLimits: readSendLimits(env),
  };
}

/**
 * 解析主动消息频控额度。
 *
 * 默认值全部来自 core/throttle.ts，这里不再写一遍字面量 —— 两处各写一份默认值在这个
 * 项目里已经造成过真实分歧（并发度 8 被 manifest 的 1 静默覆盖，真实插件全退化成串行）。
 */
function readSendLimits(env: NodeJS.ProcessEnv): ThrottleLimits {
  return {
    perConversation: readPositiveInt(
      env,
      'QQ_SEND_PER_CONVERSATION',
      DEFAULT_THROTTLE_LIMITS.perConversation,
    ),
    global: readPositiveInt(env, 'QQ_SEND_GLOBAL', DEFAULT_THROTTLE_LIMITS.global),
    windowMs: readPositiveInt(env, 'QQ_SEND_WINDOW_MS', DEFAULT_THROTTLE_LIMITS.windowMs),
  };
}

/** 环境变量里的正整数。空值取 fallback；非法值直接报错，不静默降级。 */
function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim() ?? '';
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${key} 必须是正整数，当前为 ${JSON.stringify(raw)}`);
  }
  return value;
}