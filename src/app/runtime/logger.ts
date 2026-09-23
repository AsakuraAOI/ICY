/**
 * App Runtime 的日志门面。
 *
 * Runtime 不直接用 console：它跑在 ICY 插件进程里，stdout 属于 JSON-RPC 协议帧，
 * 日志必须经 host/log 回到内核。所以这里只定义最小接口，落点由宿主注入。
 *
 * 子 Logger 只做前缀拼接，不改变行为：模块日志里必须一眼看出是谁写的。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** 丢弃全部日志。既是 Runtime 的默认值，也给不关心日志的测试用。 */
export const NOOP_LOGGER: Logger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 给日志加作用域前缀。
 *
 * 底层 logger 抛异常（例如宿主通道已关闭）不能反过来打断业务：日志是旁路，
 * 所以这里刻意吞掉。业务异常绝不吞，但日志失败没有传播价值。
 */
export function childLogger(parent: Logger, scope: string): Logger {
  const prefix = scope === '' ? '' : `[${scope}] `;
  const at =
    (level: LogLevel) =>
    (message: string, fields?: Record<string, unknown>): void => {
      try {
        parent[level](`${prefix}${message}`, fields);
      } catch {
        // 日志失败不影响业务路径。
      }
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** 控制台 logger：脚本、冒烟自检与本地调试用。日志一律走 stderr。 */
export function createConsoleLogger(min: LogLevel = 'info'): Logger {
  const floor = LEVEL_ORDER[min];
  const at =
    (level: LogLevel) =>
    (message: string, fields?: Record<string, unknown>): void => {
      if (LEVEL_ORDER[level] < floor) return;
      const suffix =
        fields === undefined || Object.keys(fields).length === 0
          ? ''
          : ` ${JSON.stringify(fields)}`;
      process.stderr.write(`${level.toUpperCase()} ${message}${suffix}\n`);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}