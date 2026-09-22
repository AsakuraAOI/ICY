/**
 * 环境变量解析与校验。
 *
 * 规则：
 * - QQ_APP_ID / QQ_APP_SECRET 必填，缺了直接退出（调用方负责打印）。
 * - 这里只做读取与脱敏封装：secrets 以做法的方式持有，永不进日志。
 * - 生产环境用真实环境变量；本地开发时 main.ts 会先试读 .env。
 */

export interface AppConfig {
  appId: string;
  /** 只在创建 TokenManager 的瞬间使用，不提供字符串形式的访问器。 */
  readonly appSecret: Secret;
  logLevel: LogLevel;
  pluginDir: string;
  /** OpenAPI 基址覆盖（QQ_API_BASE）。空串表示用 core/routes.ts 的默认值。 */
  apiBase: string;
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
  };
}