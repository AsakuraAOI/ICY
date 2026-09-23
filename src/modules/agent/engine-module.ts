import { defineModule } from '../../app/runtime/module.js';
import { Models } from '../llm/contracts.js';
import { Agents, BoundedAgentEngine } from './engine.js';
import { Tools } from './tools.js';

export const engineModule = defineModule({
  name: 'agent-engine',
  version: '0.1.0',
  requires: ['models', 'tools'],
  setup(ctx) {
    ctx.provide(Agents, new BoundedAgentEngine(
      ctx.services.require(Models),
      ctx.services.require(Tools),
    ));
  },
});

export default engineModule;
