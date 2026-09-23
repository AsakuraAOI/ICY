import { defineModule } from '../../app/runtime/module.js';
import { ToolRegistry, Tools } from './tools.js';
import { Policy } from './policy.js';

export const toolsModule = defineModule({
  name: 'tools',
  version: '0.1.0',
  requires: ['policy'],
  setup(ctx) {
    ctx.provide(Tools, new ToolRegistry(ctx.services.require(Policy)));
  },
  start(ctx) {
    ctx.services.require(Tools).freeze();
  },
});

export default toolsModule;
