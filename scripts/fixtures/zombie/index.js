#!/usr/bin/env node
/**
 * 僵死插件：冒烟自检的测试夹具，不是示例。
 *
 * 它正确完成握手（init 回 ok、发 plugin/ready），然后**永不再回任何请求**：
 * 不响应 ping，也不响应 lifecycle/shutdown。
 *
 * 用来验证 supervisor 的健康检查真的能覆盖「进程活着但不能干活」这一种失败 ——
 * 这类插件不会 exit，从外面看状态一直是 running，只有主动 ping 才能发现。
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
        params: { name: 'zombie', version: VERSION, protocolVersion: 2 },
      });
      // 之后什么都不回：ping 与 shutdown 都石沉大海。
    }
  }
});

// 故意不设 exit 定时器：这个进程会一直活着，只是不再响应协议。
