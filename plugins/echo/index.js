#!/usr/bin/env node
/**
 * echo 示例插件。
 *
 * 演示最小插件契约（DESIGN.md §6）：
 * - stdout 只写 JSON-RPC NDJSON 协议帧，任何日志一律走 stderr；
 * - 实现 lifecycle/init、lifecycle/shutdown、ping、event/dispatch 四个方法；
 * - 初始化完成后主动发 plugin/ready 通知；
 * - 同一事件有两条回复路径：同步返回 ReplyInstruction（推荐），或返回 null
 *   再用 host/reply + handleId 异步回复。两种都在下面演示。
 *
 * 本文件故意不依赖任何库，也不 import 内核代码 —— 插件与内核之间只有 IPC。
 */

const PROTOCOL_VERSION = 1;
const VERSION = '0.1.0';

let buffer = '';
let nextId = 1;
const pending = new Map();

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function log(message) {
  process.stderr.write(`[echo] ${message}\n`);
}

function replyTo(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function failTo(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

/** 插件 → 内核的请求。超时与错误都 reject，调用方自己决定降级策略。 */
function callHost(method, params, timeoutMs = 10_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    write({ jsonrpc: '2.0', id, method, params });
  });
}

async function onDispatch(params) {
  const event = params && params.event;
  const handle = params && params.reply ? params.reply : null;
  if (!event || typeof event.eventType !== 'string') {
    log('收到没有 event 的 dispatch，忽略');
    return null;
  }

  const content = typeof event.content === 'string' ? event.content.trim() : '';
  log(`收到 ${event.eventType} content=${JSON.stringify(content)} handle=${handle ? handle.handleId : 'null'}`);

  // 没有被动窗口（例如群生命周期事件）就什么都不回。
  if (handle === null) return null;

  // 异步路径演示：先返回 null，稍后用 host/reply 回。
  if (content === 'async') {
    setTimeout(() => {
      callHost('host/reply', { handleId: handle.handleId, text: '这是异步回复（host/reply）' })
        .then((result) => log(`host/reply => ${JSON.stringify(result)}`))
        .catch((error) => log(`host/reply 失败：${error.message}`));
    }, 200);
    return null;
  }

  const text = content === '' ? '你好，我收到了你的消息' : `echo: ${content}`;
  // scope 必须与事件场景一致：内核会按句柄的真实目标发送，这里只是自述。
  return { scope: event.kind === 'c2c' ? 'c2c' : 'group', content: text };
}

async function onRequest(id, method, params) {
  switch (method) {
    case 'ping':
      replyTo(id, { ok: true });
      return;
    case 'lifecycle/init': {
      const init = params || {};
      if (typeof init.protocolVersion === 'number' && init.protocolVersion !== PROTOCOL_VERSION) {
        log(`协议版本不一致：内核 ${init.protocolVersion} / 插件 ${PROTOCOL_VERSION}`);
        failTo(id, -32602, `不支持的协议版本 ${init.protocolVersion}`);
        return;
      }
      log(`初始化完成 bot=${init.bot ? init.bot.id : 'unknown'}`);
      replyTo(id, { ok: true, version: VERSION });
      notify('plugin/ready', { name: 'echo', version: VERSION, protocolVersion: PROTOCOL_VERSION });
      return;
    }
    case 'lifecycle/shutdown': {
      replyTo(id, { ok: true });
      // 给 stdout 一点时间把最后一帧刷出去，再退出。
      setTimeout(() => process.exit(0), 50);
      return;
    }
    case 'event/dispatch': {
      try {
        replyTo(id, await onDispatch(params));
      } catch (error) {
        failTo(id, -32603, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    default:
      failTo(id, -32601, `echo 插件没有实现 ${method}`);
  }
}

function onResponse(frame) {
  const entry = pending.get(frame.id);
  if (entry === undefined) return;
  pending.delete(frame.id);

  const error = frame.error;
  if (error !== null && typeof error === 'object') {
    entry.reject(new Error(`${error.code}: ${error.message}`));
    return;
  }
  entry.resolve(frame.result === undefined ? null : frame.result);
}

function onLine(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    log(`stdin 出现非 JSON 的行：${line.slice(0, 120)}`);
    return;
  }
  if (frame === null || typeof frame !== 'object') return;

  const hasId = typeof frame.id === 'number' || typeof frame.id === 'string';
  if (hasId && typeof frame.method !== 'string') {
    onResponse(frame);
    return;
  }
  if (typeof frame.method !== 'string') return;

  if (hasId) {
    void onRequest(frame.id, frame.method, frame.params);
    return;
  }
  log(`忽略内核通知 ${frame.method}`);
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const at = buffer.indexOf('\n');
    if (at < 0) break;
    let line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() === '') continue;
    onLine(line);
  }
});

process.stdin.on('end', () => {
  log('stdin 已关闭，退出');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log(`未捕获异常：${error && error.stack ? error.stack : String(error)}`);
  process.exit(1);
});