#!/usr/bin/env node
/**
 * 必崩插件：冒烟自检的测试夹具，不是示例。
 *
 * 它正确地完成握手（init 回 ok、发 plugin/ready），然后在 150ms 后强制退出，
 * 用来验证 supervisor 的两条加固行为真的生效：
 *   1. running 阶段崩溃会按退避重启；
 *   2. 60 秒窗口内连崩 3 次会被 quarantine，不再自动拉起。
 *
 * 故意不做任何别的处理：它唯一的职责就是崩。
 */

const VERSION = '0.1.0';

let buffer = '';

function write(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const at = buffer.indexOf('\n');
    if (at < 0) break;
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line === '') continue;

    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame === null || typeof frame !== 'object') continue;

    if (frame.method === 'lifecycle/init') {
      write({ jsonrpc: '2.0', id: frame.id, result: { ok: true, version: VERSION } });
      write({
        jsonrpc: '2.0',
        method: 'plugin/ready',
        params: { name: 'crasher', version: VERSION, protocolVersion: 2 },
      });
      // 握手一完成就崩，模拟「能启动但稳定不住」的插件。
      setTimeout(() => process.exit(9), 150);
    } else if (frame.method === 'lifecycle/shutdown') {
      write({ jsonrpc: '2.0', id: frame.id, result: { ok: true } });
      setTimeout(() => process.exit(0), 30);
    } else if (frame.method === 'event/dispatch') {
      write({ jsonrpc: '2.0', id: frame.id, result: null });
    }
  }
});