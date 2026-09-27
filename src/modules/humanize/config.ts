export interface HumanizeConfig {
  readonly enabled: boolean;
  readonly stripTerminalPunctuation: boolean;
  readonly perLine: boolean;
  readonly includeCommands: boolean;
}

export const DEFAULT_HUMANIZE: HumanizeConfig = Object.freeze({
  enabled: true,
  stripTerminalPunctuation: true,
  perLine: true,
  includeCommands: false,
});

export function readHumanizeConfig(value: unknown = {}): HumanizeConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('拟人化输出配置必须是对象');
  }
  const config = { ...DEFAULT_HUMANIZE, ...value };
  for (const key of Object.keys(DEFAULT_HUMANIZE) as (keyof HumanizeConfig)[]) {
    if (typeof config[key] !== 'boolean') throw new Error(`humanize.${key} 必须是布尔值`);
  }
  return {
    enabled: config.enabled, stripTerminalPunctuation: config.stripTerminalPunctuation,
    perLine: config.perLine, includeCommands: config.includeCommands,
  };
}
