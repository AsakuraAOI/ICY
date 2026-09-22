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

const PROTOCOL_VERSION = 2;
const VERSION = '0.1.0';

// 插件私有配置，由内核从 plugin.json 的 config 字段下发。初值与 plugin.json 一致，
// 这样 config 缺失时插件也能跑，不会因为读不到配置就崩。
let replyPrefix = 'echo';

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

/** 由事件推出主动消息 / 撤回的目标。缺少定位字段时返回 null。 */
function targetOf(event) {
  if (event.kind === 'c2c' && typeof event.userOpenid === 'string' && event.userOpenid !== '') {
    return { target: { scope: 'c2c', userOpenid: event.userOpenid }, id: event.userOpenid };
  }
  if (typeof event.groupOpenid === 'string' && event.groupOpenid !== '') {
    return { target: { scope: 'group', groupOpenid: event.groupOpenid }, id: event.groupOpenid };
  }
  return null;
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

  // 主动消息演示：走 host/send，不占用被动窗口，受内核频控。
  if (content === 'send') {
    const where = targetOf(event);
    if (where === null) {
      log('事件缺少主动消息目标，忽略');
      return null;
    }
    setTimeout(() => {
      callHost('host/send', { ...where.target, body: { kind: 'text', text: `${replyPrefix}: 主动消息` } })
        .then((result) => log(`host/send => ${JSON.stringify(result)}`))
        .catch((error) => log(`host/send 失败：${error.message}`));
    }, 100);
    return null;
  }

  // 撤回演示：先主动发一条，再用返回的 messageId 撤回它。
  // 插件只能撤回自己发过的消息 —— 别人的消息 ID 它本来就拿不到。
  if (content === 'recall') {
    const where = targetOf(event);
    if (where === null) {
      log('事件缺少撤回目标，忽略');
      return null;
    }
    setTimeout(() => {
      callHost('host/send', { ...where.target, body: { kind: 'text', text: `${replyPrefix}: 待撤回` } })
        .then((sent) => {
          if (!sent || sent.ok !== true || typeof sent.messageId !== 'string') {
            throw new Error(`host/send 未返回 messageId：${JSON.stringify(sent)}`);
          }
          return callHost('host/recall', { ...where.target, messageId: sent.messageId });
        })
        .then((result) => log(`host/recall => ${JSON.stringify(result)}`))
        .catch((error) => log(`撤回演示失败：${error.message}`));
    }, 100);
    return null;
  }

  // 没有被动窗口（例如群生命周期事件）就什么都不回。
  if (handle === null) return null;

  // 异步路径演示：先返回 null，稍后用 host/reply 回。
  if (content === 'async') {
    setTimeout(() => {
      callHost('host/reply', {
        handleId: handle.handleId,
        body: { kind: 'text', text: '这是异步回复（host/reply）' },
      })
        .then((result) => log(`host/reply => ${JSON.stringify(result)}`))
        .catch((error) => log(`host/reply 失败：${error.message}`));
    }, 200);
    return null;
  }

  const where = event.kind === 'c2c' ? 'c2c' : 'group';

  // Markdown 演示：msg_type=2。插件只说「这是 markdown」，msg_type 由内核填。
  if (content === 'markdown') {
    return { scope: where, body: { kind: 'markdown', markdown: `**${replyPrefix}**: *斜体* 与列表\n- 一\n- 二` } };
  }

  // ARK 演示：msg_type=3，同样发到 /messages —— 没有 /ark 这个端点。
  // template_id 由平台侧配置；kv 的 key 是模板占位符，value 与 obj 二选一。
  if (content === 'ark') {
    return {
      scope: where,
      body: {
        kind: 'ark',
        ark: {
          template_id: 23,
          kv: [
            { key: '#DESC#', value: '示例卡片' },
            { key: '#LIST#', obj: [{ obj_kv: [{ key: 'desc', value: 'item' }] }] },
          ],
        },
      },
    };
  }

  // Embed 演示：msg_type=4。字段形状固定，同样没有独立端点。
  if (content === 'embed') {
    return {
      scope: where,
      body: {
        kind: 'embed',
        embed: {
          title: '示例 Embed',
          prompt: '通知栏提示',
          thumbnail: { url: 'https://example.com/i.png' },
          fields: [{ name: '字段一' }, { name: '字段二' }],
        },
      },
    };
  }

  // 内嵌键盘演示：keyboard 不是独立接口，只是消息 body 上的字段，与文本一起提交。
  if (content === 'keyboard') {
    return {
      scope: where,
      body: {
        kind: 'text',
        text: `${replyPrefix}: 请选择`,
        keyboard: {
          content: {
            rows: [
              {
                buttons: [
                  {
                    id: 'btn_1',
                    render_data: { label: '确认', visited_label: '已确认', style: 1 },
                    action: { type: 1, permission: { type: 2 }, data: 'confirm' },
                  },
                ],
              },
            ],
          },
        },
      },
    };
  }

  // 富媒体演示：插件只交出一个来源（url 或 base64），上传由内核负责 ——
  // 小文件整传、大文件自动分片，插件看不到 upload_id / presigned_url / file_info。
  if (content === 'image') {
    return {
      scope: where,
      body: {
        kind: 'media',
        fileType: 1,
        url: 'https://example.com/cat.png',
        text: `${replyPrefix}: 图来了`,
      },
    };
  }

  // 输入状态演示：msg_type=6，只有单聊有；群聊里发会被内核在发送前拒掉。
  if (content === 'typing') {
    if (where !== 'c2c') return { scope: where, body: { kind: 'text', text: '输入状态只有单聊支持' } };
    return { scope: where, body: { kind: 'typing', inputSecond: 30 } };
  }

  const text = content === '' ? '你好，我收到了你的消息' : `${replyPrefix}: ${content}`;
  // scope 必须与事件场景一致：内核会按句柄的真实目标发送，这里只是自述。
  return { scope: where, body: { kind: 'text', text } };
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
      const config = init.config && typeof init.config === 'object' ? init.config : {};
      if (typeof config.prefix === 'string' && config.prefix.trim() !== '') {
        replyPrefix = config.prefix.trim();
      }
      log(`初始化完成 bot=${init.bot ? init.bot.id : 'unknown'} config=${JSON.stringify(config)}`);
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