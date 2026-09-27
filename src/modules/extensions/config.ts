import { DEFAULT_HUMANIZE, readHumanizeConfig, type HumanizeConfig } from '../humanize/config.js';

export interface ExtensionConfig {
  utilities: { enabled: boolean; maxDice: number };
  memory: { enabled: boolean; maxEntries: number; maxChars: number };
  autoReply: { enabled: boolean; rules: ReplyRule[] };
  humanize: HumanizeConfig;
}
export interface ReplyRule {
  id: string; keyword: string; match: 'exact' | 'contains'; reply: string;
  scopes: ('group' | 'c2c')[]; groupOpenids: string[]; cooldownSeconds: number;
}
export const DEFAULT_EXTENSIONS: ExtensionConfig = {
  utilities: { enabled: true, maxDice: 20 },
  memory: { enabled: true, maxEntries: 20, maxChars: 300 },
  autoReply: { enabled: false, rules: [] },
  humanize: DEFAULT_HUMANIZE,
};
function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值`);
  return value;
}
function number(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} 必须是 ${min}–${max} 的整数`);
  return value as number;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} 必须是非空字符串，最多 ${max} 字符`);
  return value.trim();
}
export function readExtensionConfig(value: unknown = DEFAULT_EXTENSIONS): ExtensionConfig {
  const root = record(value, '插件配置');
  const u = { ...DEFAULT_EXTENSIONS.utilities, ...record(root.utilities ?? {}, '实用命令') };
  const m = { ...DEFAULT_EXTENSIONS.memory, ...record(root.memory ?? {}, '记忆') };
  const a = { ...DEFAULT_EXTENSIONS.autoReply, ...record(root.autoReply ?? {}, '关键词回复') };
  if (!Array.isArray(a.rules) || a.rules.length > 100) throw new Error('关键词回复规则最多 100 条');
  const rules = a.rules.map((item): ReplyRule => {
    const r = record(item, '回复规则');
    const id = text(r.id, '规则 ID', 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error('规则 ID 格式无效');
    if (r.match !== 'exact' && r.match !== 'contains') throw new Error('匹配方式必须是 exact 或 contains');
    if (!Array.isArray(r.scopes) || r.scopes.length === 0 || r.scopes.length > 2 ||
      r.scopes.some((s) => s !== 'group' && s !== 'c2c') || new Set(r.scopes).size !== r.scopes.length) throw new Error('规则适用场景无效');
    if (!Array.isArray(r.groupOpenids) || r.groupOpenids.length > 1000) throw new Error('规则群列表无效');
    return { id, keyword: text(r.keyword, '关键词', 100), match: r.match,
      reply: text(r.reply, '回复文本', 1500), scopes: r.scopes,
      groupOpenids: r.groupOpenids.map((id) => text(id, '群 OpenID', 256)),
      cooldownSeconds: number(r.cooldownSeconds, '冷却秒数', 0, 86400) };
  });
  if (new Set(rules.map((r) => r.id)).size !== rules.length) throw new Error('规则 ID 不能重复');
  return {
    utilities: { enabled: flag(u.enabled, '实用命令开关'), maxDice: number(u.maxDice, '骰子数量上限', 1, 100) },
    memory: { enabled: flag(m.enabled, '记忆开关'), maxEntries: number(m.maxEntries, '每用户记忆条数', 1, 100), maxChars: number(m.maxChars, '每条记忆字数', 1, 1000) },
    autoReply: { enabled: flag(a.enabled, '关键词回复开关'), rules },
    humanize: readHumanizeConfig(root.humanize),
  };
}
