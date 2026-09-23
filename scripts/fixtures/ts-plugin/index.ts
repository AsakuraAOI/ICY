/**
 * TypeScript + SDK 插件夹具。
 *
 * 这里同时验证两件事：manifest.runtime 能直接启动 .ts 入口，以及插件作者不需要
 * 自己实现 JSON-RPC / NDJSON / lifecycle / ping / plugin/ready 样板。
 */

import { createPlugin } from 'icy-qqbot/sdk';

interface Config {
  prefix?: string;
}

const plugin = createPlugin<Config>({
  name: 'ts-plugin',
  version: '0.1.0',

  onInit({ config, host }) {
    host.log('debug', 'TS SDK fixture initialized', { prefix: config.prefix ?? 'ts' });
  },

  onEvent({ event, config }) {
    if (event.kind !== 'group' && event.kind !== 'c2c') return null;
    const prefix = typeof config.prefix === 'string' && config.prefix !== '' ? config.prefix : 'ts';
    return {
      scope: event.kind,
      body: { kind: 'text', text: `${prefix}: ${event.content ?? ''}` },
    };
  },
});

plugin.run();
