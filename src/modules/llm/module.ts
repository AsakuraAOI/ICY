import { defineModule } from '../../app/runtime/module.js';
import { Models } from './contracts.js';
import { OpenAICompatibleModels, type OpenAICompatibleModelConfig } from './openai-compatible.js';

interface ModelsModuleConfig {
  readonly models?: unknown;
}

export const modelsModule = defineModule<ModelsModuleConfig>({
  name: 'models',
  version: '0.1.0',

  setup(ctx) {
    const models = readModelConfigs(ctx.config.models);
    ctx.provide(Models, new OpenAICompatibleModels(models));
    if (models.length === 0) {
      ctx.logger.warn('没有配置模型；Models service 已注册，但 generate() 暂不可用');
    } else {
      ctx.logger.info(`已配置 ${models.length} 个 OpenAI-compatible 模型别名`);
    }
  },
});

function readModelConfigs(value: unknown): OpenAICompatibleModelConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('models 模块的 config.models 必须是数组');
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`config.models[${index}] 必须是对象`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.alias !== 'string' ||
      typeof record.model !== 'string' ||
      typeof record.baseUrl !== 'string' ||
      typeof record.contextTokens !== 'number' ||
      typeof record.maxOutputTokens !== 'number' ||
      (record.apiKeyEnv !== undefined && typeof record.apiKeyEnv !== 'string') ||
      (record.supportsTools !== undefined && typeof record.supportsTools !== 'boolean') ||
      (record.timeoutMs !== undefined && typeof record.timeoutMs !== 'number') ||
      (record.outputTokenParameter !== undefined && typeof record.outputTokenParameter !== 'string')
    ) {
      throw new Error(`config.models[${index}] 缺少有效字段（alias/model/baseUrl/contextTokens/maxOutputTokens）`);
    }
    return record as unknown as OpenAICompatibleModelConfig;
  });
}

export default modelsModule;
