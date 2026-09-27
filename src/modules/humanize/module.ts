import { Messages } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import { readHumanizeConfig } from './config.js';
import { Humanize } from './contracts.js';
import { humanizeText } from './format.js';

export default defineModule<unknown>({
  name: 'humanize', version: '0.1.0', requires: ['core'],
  setup(ctx) {
    const config = readHumanizeConfig(ctx.config);
    const output = { format: (text: string, source: 'agent' | 'message' | 'command') => humanizeText(text, config, source) };
    ctx.provide(Humanize, output);
    if (!config.enabled) return;
    ctx.services.require(Messages).use(async (message, next) => {
      const result = await next();
      if (!result || result.body.kind !== 'text' ||
        (message.event.kind !== 'group' && message.event.kind !== 'c2c')) return result;
      const source = message.event.content?.trimStart().startsWith('/') ? 'command' : 'message';
      return { ...result, body: { ...result.body, text: output.format(result.body.text, source) } };
    }, { priority: -10_000, id: 'humanize.output', resources: ctx.resources });
    ctx.logger.info('拟人化输出已启用');
  },
});
