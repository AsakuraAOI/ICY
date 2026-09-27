import { readFile } from 'node:fs/promises';
import type { PluginManifest } from './manifest.js';
import { readExtensionConfig, type ExtensionConfig } from '../modules/extensions/config.js';

type JsonObject = Record<string, unknown>;

export interface BotSettings {
  plugins: ExtensionConfig;
  policy: {
    allowedGroups: string[];
    blockedUsers: string[];
    allowC2c: boolean;
    groupCommandsWithoutMention: boolean;
    enabledTools: string[];
  };
  persona: {
    defaultId: string;
    profiles: { id: string; name: string; description: string; systemPrompt: string }[];
    groupAssignments: Record<string, string>;
    c2cAssignments: Record<string, string>;
  };
  agent: {
    enabled: boolean;
    modelAlias: string;
    maxConcurrency: number;
    maxQueue: number;
    maxModelCalls: number;
    maxToolCalls: number;
    outputLimit: number;
  };
  models: { alias: string; model: string; baseUrl: string; apiKeyEnv: string; supportsTools: boolean }[];
}

const paths = {
  policy: '/agent/policy.js', persona: '/persona/module.js', runs: '/agent-runtime/runs.js',
  chat: '/agent-chat/module.js', models: '/llm/module.js',
  utilities: '/utility/module.js', memory: '/memory/module.js', autoReply: '/auto-reply/module.js',
  humanize: '/humanize/module.js',
};

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as JsonObject;
}
function string(value: unknown, label: string, max = 256, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`${label} 必须是有效字符串`);
  return value.trim();
}
function strings(value: unknown, label: string, max = 1000): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} 必须是数组，最多 ${max} 项`);
  const out = value.map((v, i) => string(v, `${label}[${i}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} 不能包含重复项`);
  return out;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} 必须在 ${min}–${max} 之间`);
  return value as number;
}
function assignments(value: unknown, label: string, ids: Set<string>): Record<string, string> {
  const raw = object(value, label);
  if (Object.keys(raw).length > 1000) throw new Error(`${label} 最多 1000 项`);
  const out: Record<string, string> = Object.create(null);
  for (const [key, id] of Object.entries(raw)) {
    string(key, `${label} OpenID`);
    if (typeof id !== 'string' || !ids.has(id)) throw new Error(`${label} 引用了不存在的人设`);
    out[key] = id;
  }
  return out;
}

export function parseBotSettings(value: unknown): BotSettings {
  const root = object(value, '设置');
  const policy = object(root.policy, 'policy');
  const persona = object(root.persona, 'persona');
  const agent = object(root.agent, 'agent');
  const profilesRaw = persona.profiles;
  if (!Array.isArray(profilesRaw) || profilesRaw.length < 1 || profilesRaw.length > 32) throw new Error('人设数量必须在 1–32 之间');
  const profiles = profilesRaw.map((item, index) => {
    const p = object(item, `人设 ${index + 1}`);
    const id = string(p.id, '人设 ID', 32);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw new Error('人设 ID 格式无效');
    return { id, name: string(p.name, '人设名称', 80), description: string(p.description ?? '', '人设简介', 160, true), systemPrompt: string(p.systemPrompt, '系统提示词', 8000) };
  });
  const ids = new Set(profiles.map((p) => p.id));
  if (ids.size !== profiles.length) throw new Error('人设 ID 不能重复');
  const defaultId = string(persona.defaultId, '默认人设 ID', 32);
  if (!ids.has(defaultId)) throw new Error('默认人设不存在');
  if (!Array.isArray(root.models) || root.models.length > 16) throw new Error('模型数量最多 16 个');
  const models = root.models.map((item, index) => {
    const m = object(item, `模型 ${index + 1}`);
    const baseUrl = string(m.baseUrl, '模型地址', 1000);
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('模型地址不是有效 URL'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('模型地址必须使用 HTTPS');
    const apiKeyEnv = string(m.apiKeyEnv ?? '', '密钥环境变量名', 128, true);
    if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error('密钥环境变量名格式无效');
    return { alias: string(m.alias, '模型别名', 80), model: string(m.model, '模型 ID', 128), baseUrl, apiKeyEnv, supportsTools: boolean(m.supportsTools, '工具调用开关') };
  });
  if (new Set(models.map((m) => m.alias)).size !== models.length) throw new Error('模型别名不能重复');
  const modelAlias = string(agent.modelAlias, 'Agent 模型别名', 80, models.length === 0 && agent.enabled === false);
  if ((models.length > 0 || agent.enabled) && !models.some((m) => m.alias === modelAlias)) throw new Error('Agent 模型别名不存在');
  const enabledTools = strings(policy.enabledTools, '启用工具', 7);
  if (enabledTools.some((t) => !['clock_now', 'calculator_evaluate', 'knowledge_search', 'memory_search',
    'plugin_list', 'plugin_create', 'plugin_run'].includes(t))) throw new Error('含有未知工具');
  return {
    plugins: readExtensionConfig(root.plugins),
    policy: { allowedGroups: strings(policy.allowedGroups, '群白名单'), blockedUsers: strings(policy.blockedUsers, '封禁用户'), allowC2c: boolean(policy.allowC2c, '私聊开关'), groupCommandsWithoutMention: boolean(policy.groupCommandsWithoutMention ?? true, '群命令免 @ 开关'), enabledTools },
    persona: { defaultId, profiles, groupAssignments: assignments(persona.groupAssignments, '群人设分配', ids), c2cAssignments: assignments(persona.c2cAssignments, '私聊人设分配', ids) },
    agent: { enabled: boolean(agent.enabled, 'Agent 开关'), modelAlias, maxConcurrency: integer(agent.maxConcurrency, '并发数', 1, 64), maxQueue: integer(agent.maxQueue, '队列长度', 1, 1000), maxModelCalls: integer(agent.maxModelCalls, '模型调用上限', 1, 20), maxToolCalls: integer(agent.maxToolCalls, '工具调用上限', 1, 32), outputLimit: integer(agent.outputLimit, '输出 token 上限', 1, 2000) },
    models,
  };
}

function moduleConfig(manifest: PluginManifest, suffix: string): JsonObject {
  const modules = manifest.config.modules;
  if (!Array.isArray(modules)) throw new Error('app-runtime 缺少模块列表');
  const entry = modules.find((item) => item !== null && typeof item === 'object' && typeof item.path === 'string' && item.path.endsWith(suffix));
  if (!entry) throw new Error(`缺少模块 ${suffix}`);
  return object(entry.config ?? {}, suffix);
}

export function defaultsFromManifest(manifest: PluginManifest): BotSettings {
  const p = moduleConfig(manifest, paths.policy);
  const persona = moduleConfig(manifest, paths.persona);
  const runs = moduleConfig(manifest, paths.runs);
  const chat = moduleConfig(manifest, paths.chat);
  const llm = moduleConfig(manifest, paths.models);
  const models = Array.isArray(llm.models) ? llm.models.map((item) => {
    const m = object(item, '模型');
    return { alias: m.alias, model: m.model, baseUrl: m.baseUrl, apiKeyEnv: m.apiKeyEnv ?? '', supportsTools: m.supportsTools ?? false };
  }) : [];
  return parseBotSettings({
    plugins: Object.fromEntries(['utilities', 'memory', 'autoReply', 'humanize'].map((key) => {
      try { return [key, moduleConfig(manifest, paths[key as 'utilities' | 'memory' | 'autoReply' | 'humanize'])]; }
      catch { return [key, {}]; }
    })),
    policy: { allowedGroups: p.allowedGroups ?? [], blockedUsers: p.blockedUsers ?? [], allowC2c: p.allowC2c ?? false, groupCommandsWithoutMention: manifest.config.groupCommandsWithoutMention ?? true, enabledTools: p.enabledTools ?? ['clock_now', 'calculator_evaluate', 'knowledge_search'] },
    persona: { defaultId: persona.defaultId, profiles: persona.profiles, groupAssignments: persona.groupAssignments ?? {}, c2cAssignments: persona.c2cAssignments ?? {} },
    agent: { enabled: Boolean(chat.enabled && runs.enabled), modelAlias: runs.modelAlias ?? models[0]?.alias ?? '', maxConcurrency: runs.maxConcurrency ?? 1, maxQueue: runs.maxQueue ?? 2, maxModelCalls: runs.maxModelCalls ?? 3, maxToolCalls: runs.maxToolCalls ?? 2, outputLimit: runs.outputLimit ?? 512 },
    models,
  });
}

export function applyBotSettings(manifest: PluginManifest, settings: BotSettings): PluginManifest {
  if (manifest.name !== 'app-runtime') return manifest;
  const baseModels = (moduleConfig(manifest, paths.models).models ?? []) as JsonObject[];
  if (settings.models.length !== baseModels.length || settings.models.some((model) => !baseModels.some((base) => base.alias === model.alias && base.apiKeyEnv === model.apiKeyEnv))) {
    throw new Error('当前只能编辑已配置的模型；模型别名和密钥环境变量不可在 WebUI 中更改');
  }
  const selected = baseModels.find((model) => model.alias === settings.agent.modelAlias);
  if (settings.agent.enabled && (!selected || typeof selected.maxOutputTokens !== 'number' || settings.agent.outputLimit > selected.maxOutputTokens)) {
    throw new Error('输出 token 上限超过所选模型的能力');
  }
  const configs: Record<string, JsonObject> = {
    [paths.utilities]: settings.plugins.utilities,
    [paths.memory]: settings.plugins.memory,
    [paths.autoReply]: settings.plugins.autoReply,
    [paths.humanize]: { ...settings.plugins.humanize },
    [paths.policy]: settings.policy, [paths.persona]: settings.persona,
    [paths.runs]: { ...settings.agent, enabled: settings.agent.enabled },
    [paths.chat]: { enabled: settings.agent.enabled },
  };
  configs[paths.models] = { models: settings.models.map((model) => ({ ...(baseModels.find((m) => m.alias === model.alias) ?? {}), ...model })) };
  const modules = (manifest.config.modules as unknown[]).map((item) => {
    if (item === null || typeof item !== 'object' || typeof (item as JsonObject).path !== 'string') return item;
    const entry = item as JsonObject;
    const suffix = Object.keys(configs).find((key) => (entry.path as string).endsWith(key));
    return suffix ? { ...entry, config: { ...object(entry.config ?? {}, suffix), ...configs[suffix] } } : item;
  });
  return { ...manifest, config: { ...manifest.config, groupCommandsWithoutMention: settings.policy.groupCommandsWithoutMention, modules } };
}

export async function readBotSettings(path: string, manifest: PluginManifest): Promise<BotSettings> {
  try { return parseBotSettings(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultsFromManifest(manifest);
    throw error;
  }
}
