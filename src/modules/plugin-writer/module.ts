import { defineModule } from '../../app/runtime/module.js';
import { Tools } from '../agent/tools.js';
import { GeneratedPluginStore } from './store.js';

interface PluginWriterConfig {
  readonly enabled?: boolean;
  readonly dataDir?: string;
}

export const pluginWriterModule = defineModule<PluginWriterConfig>({
  name: 'plugin-writer', version: '0.1.0', requires: ['tools'],
  setup(ctx) {
    if (ctx.config.enabled !== undefined && typeof ctx.config.enabled !== 'boolean') {
      throw new Error('plugin-writer.enabled 必须是布尔值');
    }
    const enabled = ctx.config.enabled ?? process.env.ICY_PLUGIN_WRITER_ENABLED === '1';
    if (!enabled) return;
    if (!process.allowedNodeEnvironmentFlags.has('--permission')) {
      throw new Error('plugin-writer 需要支持 --permission 的 Node 运行时');
    }
    const dataDir = ctx.config.dataDir ?? process.env.ICY_PLUGIN_DATA_DIR;
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
      throw new Error('plugin-writer.dataDir 必须配置独立的绝对目录');
    }
    const store = new GeneratedPluginStore(dataDir);
    const tools = ctx.services.require(Tools);

    tools.register({
      name: 'plugin_list', version: '1', effect: 'read', requiredAction: 'plugins.list',
      resource: () => ({ kind: 'tool' }), timeoutMs: 3_000, maxOutputBytes: 8 * 1024,
      description: '列出你已创建的可调用功能插件。需要新增能力时先查看列表。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, toolCtx) { return { plugins: await store.list(toolCtx.actor) }; },
    });
    tools.register({
      name: 'plugin_create', version: '1', effect: 'write', requiredAction: 'plugins.create',
      resource: () => ({ kind: 'tool' }), timeoutMs: 25_000, maxOutputBytes: 2 * 1024,
      description: '创建功能插件。仅在已有插件不够用时调用。source 用简短 .mjs 代码 export default async function run(input)，返回 JSON，不依赖 npm 包。testsJson 是 1–3 个 {input,expected} 的 JSON 数组。若本轮需要结果，同时传 inputJson；系统测试后立即执行并在结果中返回 result，省去一次 plugin_run。失败时按错误用新名称修正。',
      inputSchema: {
        type: 'object', properties: {
          name: { type: 'string', maxLength: 40 },
          description: { type: 'string', maxLength: 300 },
          source: { type: 'string', maxLength: 20_000 },
          testsJson: { type: 'string', maxLength: 4_000 },
          inputJson: { type: 'string', maxLength: 8_000 },
        }, required: ['name', 'description', 'source', 'testsJson'], additionalProperties: false,
      },
      async execute(args, toolCtx) {
        return store.create(toolCtx.actor, {
          name: String(args.name), description: String(args.description),
          source: String(args.source), testsJson: String(args.testsJson),
          ...(args.inputJson === undefined ? {} : { inputJson: String(args.inputJson) }),
        }, toolCtx.signal);
      },
    });
    tools.register({
      name: 'plugin_run', version: '1', effect: 'write', requiredAction: 'plugins.run',
      resource: () => ({ kind: 'tool' }), timeoutMs: 7_000, maxOutputBytes: 18 * 1024,
      description: '调用一个已有功能插件；传入 inputJson，返回插件实际计算的 JSON 结果。只有调用成功才能据此回复用户。',
      inputSchema: {
        type: 'object', properties: {
          name: { type: 'string', maxLength: 40 },
          inputJson: { type: 'string', maxLength: 8_000 },
        }, required: ['name', 'inputJson'], additionalProperties: false,
      },
      async execute(args, toolCtx) {
        return store.run(toolCtx.actor, String(args.name), String(args.inputJson), toolCtx.signal);
      },
    });
    ctx.logger.info('Plugin Writer 已启用，注册 plugin_list / plugin_create / plugin_run');
  },
});

export default pluginWriterModule;
