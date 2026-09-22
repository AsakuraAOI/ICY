/**
 * TypeScript 插件夹具（DESIGN.md §6.1「多语言插件」）。
 *
 * 验证的是 spawn 路径：manifest.runtime 覆盖可执行文件与前置参数，内核不解释语言。
 * 刻意不 import 内核代码、也不做相对导入 —— 类型擦除不重写模块路径，相对导入必须
 * 写真实扩展名（见 docs/plugin.md §1.1）。
 */

import { createInterface } from 'node:readline';

const NAME = 'ts-plugin';
const VERSION = '0.1.0';
const PROTOCOL_VERSION = 2;

interface RpcFrame {
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface DispatchParams {
  event?: { eventType?: string; content?: string };
}

function log(message: string): void {
  // stdout 是协议流，日志一律走 stderr。
  process.stderr.write(`[${NAME}] ${message}\n`);
}

function send(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
}

function respond(id: RpcFrame['id'], value: unknown): void {
  send({ id, result: value });
}

/** 文本消息回显；其余事件返回 null，让内核继续 fanout。 */
function dispatch(params: DispatchParams): unknown {
  const event = params.event;
  const type = event?.eventType ?? '';
  if (type !== 'GROUP_AT_MESSAGE_CREATE' && type !== 'C2C_MESSAGE_CREATE') return null;
  return {
    scope: type === 'C2C_MESSAGE_CREATE' ? 'c2c' : 'group',
    body: { kind: 'text', text: `ts: ${event?.content ?? ''}` },
  };
}

/** 返回 false 表示可以退出了。 */
function handle(frame: RpcFrame): boolean {
  switch (frame.method) {
    case 'lifecycle/init':
      respond(frame.id, { ok: true });
      send({
        method: 'plugin/ready',
        params: { name: NAME, version: VERSION, protocolVersion: PROTOCOL_VERSION },
      });
      return true;
    case 'event/dispatch':
      respond(frame.id, dispatch((frame.params ?? {}) as DispatchParams));
      return true;
    case 'ping':
      respond(frame.id, { ok: true });
      return true;
    case 'lifecycle/shutdown':
      respond(frame.id, { ok: true });
      return false;
    default:
      log(`未实现的方法 ${String(frame.method)}`);
      return true;
  }
}

log(`启动 protocolVersion=${PROTOCOL_VERSION} node=${process.version}`);

for await (const line of createInterface({ input: process.stdin })) {
  const text = line.trim();
  if (text === '') continue;
  let frame: RpcFrame;
  try {
    frame = JSON.parse(text) as RpcFrame;
  } catch {
    log('忽略非 JSON 行');
    continue;
  }
  if (frame.method === undefined) continue;
  if (!handle(frame)) break;
}

log('stdin 关闭，退出');
