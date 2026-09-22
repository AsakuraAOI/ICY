/**
 * 最小 QQ 后端替身（零依赖，仅用于本地端到端自检，不属于内核）。
 *
 * 实现内核真正会用到的那几条链路：
 *   POST /app/getAppAccessToken
 *   GET  /gateway                → ws://127.0.0.1:<port>/websocket/
 *   GET  /users/@me
 *   POST /v2/groups/{gid}/messages
 *   以及 Gateway 侧的 Hello → Identify → READY 与心跳 ACK。
 *
 * 两个可选开关用于验证内核的关闭码分支：
 * - options.closeCodeOnIdentify：Identify 之后立刻用该码关连接（验证致命分支）。
 * - options.closeCodeAfterReady：READY 之后用该码关连接（验证 Resume 恢复分支）。
 *
 * WebSocket 服务端是手写帧实现：Node 只内置了客户端，而本项目不允许引入
 * 运行时依赖。只覆盖小文本帧与 ping/pong/close 这几种真实会出现的控制帧。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 服务端 → 客户端：不掩码的文本帧。 */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 服务端 → 客户端：不掩码的关闭帧，携带 2 字节状态码。 */
export function encodeCloseFrame(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 0x02]), payload]);
}

/** 客户端 → 服务端：必然掩码。逐帧拆出完整文本帧与控制帧。 */
function decodeFrames(link, chunk, onText, onControl) {
  link.buffer = Buffer.concat([link.buffer, chunk]);
  for (;;) {
    const buf = link.buffer;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let at = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      at = 10;
    }
    const maskAt = at;
    if (masked) {
      if (buf.length < at + 4) return;
      at += 4;
    }
    if (buf.length < at + len) return;
    let payload = buf.subarray(at, at + len);
    if (masked) {
      const mask = buf.subarray(maskAt, maskAt + 4);
      const copy = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ mask[i % 4];
      payload = copy;
    }
    link.buffer = buf.subarray(at + len);
    if (opcode === 0x1) onText(payload.toString('utf8'));
    else if (opcode >= 0x8) onControl(opcode, payload);
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 起一个替身后端，返回句柄。 */
export function startMockQq(options = {}) {
  const heartbeatInterval = options.heartbeatInterval ?? 1500;
  let port = 0;
  let seq = 0;
  const state = {
    tokenCalls: 0,
    selfInfoCalls: 0,
    gatewayCalls: 0,
    heartbeats: 0,
    identifies: [],
    resumes: [],
    sends: [],
    c2cSends: [],
    /** 撤回请求（DELETE），用于验证 host/recall 的落地端点。 */
    recalls: [],
    /** 内容匹配时故意回 err_code，用于验证内核把平台错误翻译成稳定 reason。可运行中改写。 */
    failSendContent: null,
    /** 数字时所有撤回请求都返回该 err_code，用于验证撤回错误的稳定 reason。可运行中改写。 */
    failRecallErrCode: null,
    link: null,
    readyAt: null,
  };

  const sockets = new Set();

  /** 记录撤回请求并按 state 决定成功还是回错误码。 */
  function finishRecall(res, entry) {
    state.recalls.push(entry);
    const failCode = state.failRecallErrCode;
    if (typeof failCode === 'number') {
      json(res, 200, { err_code: failCode, message: 'mock 拒绝撤回' });
      return;
    }
    res.writeHead(200);
    res.end();
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '').split('?')[0] ?? '';

      if (path === '/app/getAppAccessToken' && req.method === 'POST') {
        state.tokenCalls += 1;
        json(res, 200, { access_token: 'mock-access-token', expires_in: '7200' });
        return;
      }
      if (path === '/gateway' && req.method === 'GET') {
        state.gatewayCalls += 1;
        if (options.gatewayFails === true) {
          json(res, 500, { err_code: 500, message: 'mock 接入点不可用' });
          return;
        }
        json(res, 200, { url: `ws://127.0.0.1:${port}/websocket/` });
        return;
      }
      if (path === '/users/@me' && req.method === 'GET') {
        state.selfInfoCalls += 1;
        json(res, 200, { id: 'mock-bot', username: 'icy' });
        return;
      }
      // 撤回：成功时 HTTP 200 且**无响应体**（与文档一致），所以这里不写 body。
      // 群聊与单聊仍是两个独立端点。
      const recallGroup = /^\/v2\/groups\/([^/]+)\/messages\/([^/]+)$/.exec(path);
      if (recallGroup !== null && req.method === 'DELETE') {
        return finishRecall(res, { scope: 'group', openid: recallGroup[1], messageId: recallGroup[2] });
      }
      const recallC2C = /^\/v2\/users\/([^/]+)\/messages\/([^/]+)$/.exec(path);
      if (recallC2C !== null && req.method === 'DELETE') {
        return finishRecall(res, { scope: 'c2c', openid: recallC2C[1], messageId: recallC2C[2] });
      }

      // 单聊与群聊是两个独立端点，且文件不能跨场景使用，因此分开记录。
      const c2cSending = /^\/v2\/users\/([^/]+)\/messages$/.exec(path);
      if (c2cSending !== null && req.method === 'POST') {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        state.c2cSends.push({ userOpenid: c2cSending[1], body });
        json(res, 200, {
          id: `mock-c2c-reply-${state.c2cSends.length}`,
          timestamp: '2026-09-22T10:00:00+08:00',
        });
        return;
      }
      const sending = /^\/v2\/groups\/([^/]+)\/messages$/.exec(path);
      if (sending !== null && req.method === 'POST') {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        state.sends.push({ groupOpenid: sending[1], body });
        const fail = state.failSendContent;
        if (fail !== null && body !== null && body.content === fail.content) {
          json(res, 200, { err_code: fail.errCode, message: 'mock 拒绝发送' });
          return;
        }
        json(res, 200, {
          id: `mock-reply-${state.sends.length}`,
          timestamp: '2026-09-22T10:00:00+08:00',
        });
        return;
      }
      json(res, 404, { err_code: 404, message: `mock 未实现 ${req.method} ${path}` });
    });
  });

  function onFrame(link, text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.op === 1) {
      state.heartbeats += 1;
      link.send(JSON.stringify({ op: 11, d: null }));
      return;
    }
    if (frame.op === 2) {
      state.identifies.push(frame.d);
      // 模拟致命关闭：Identify 之后服务端立刻用指定关闭码关连接（例如 4014 intents 无权限）。
      if (typeof options.closeCodeOnIdentify === 'number') {
        setTimeout(() => link.closeWith(options.closeCodeOnIdentify), 20);
      }
      setTimeout(() => {
        seq += 1;
        link.send(
          JSON.stringify({
            op: 0,
            s: seq,
            t: 'READY',
            d: {
              version: 1,
              session_id: 'mock-session',
              user: { id: 'mock-bot', username: 'icy' },
              shard: [0, 1],
            },
          }),
        );
        state.readyAt = Date.now();
        // 模拟服务端主动要求重连（例如 4009 连接过期）：READY 之后直接关连接。
        // 内核此时应带着 session_id + 最新 seq 走 Resume，而不是退化成重新 Identify。
        if (typeof options.closeCodeAfterReady === 'number') {
          setTimeout(
            () => link.closeWith(options.closeCodeAfterReady),
            options.closeAfterReadyDelayMs ?? 100,
          );
        }
      }, 20);
      return;
    }
    if (frame.op === 6) {
      state.resumes.push(frame.d);
      seq += 1;
      link.send(JSON.stringify({ op: 0, s: seq, t: 'RESUMED', d: {} }));
    }
  }

  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    if (key === '') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const link = {
      buffer: Buffer.alloc(0),
      send: (text) => socket.write(encodeTextFrame(text)),
      closeWith: (code) => {
        if (socket.destroyed) return;
        socket.write(encodeCloseFrame(code));
        socket.end();
      },
    };
    state.link = link;
    sockets.add(socket);

    socket.on('close', () => {
      sockets.delete(socket);
      if (state.link === link) state.link = null;
    });
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      decodeFrames(
        link,
        chunk,
        (text) => onFrame(link, text),
        (opcode, payload) => {
          if (opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          else if (opcode === 0x8) socket.end();
        },
      );
    });

    // Hello 必须由服务端先发，客户端的 Identify 是收到它之后的回应。
    setTimeout(() => {
      if (!socket.destroyed) link.send(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatInterval } }));
    }, 20);
  });

  /** 推一条 op=0 Dispatch。 */
  function pushEvent(eventType, data) {
    if (state.link === null) throw new Error('替身后端：还没有活跃的 Gateway 连接');
    seq += 1;
    state.link.send(JSON.stringify({ id: `mock-event-${seq}`, op: 0, s: seq, t: eventType, d: data }));
  }

  /** 推一条单聊消息事件。 */
  function pushC2C(overrides = {}) {
    pushEvent('C2C_MESSAGE_CREATE', {
      id: overrides.messageId ?? 'mock-c2c-message-1',
      content: overrides.content ?? 'hi',
      timestamp: '2026-09-22T10:00:00+08:00',
      message_type: 0,
      author: { id: 'mock-user-2', user_openid: overrides.userOpenid ?? 'mock-c2c-user' },
    });
  }

  /** 推一条群 @ 消息事件。 */
  function pushGroupAt(overrides = {}) {
    pushEvent('GROUP_AT_MESSAGE_CREATE', {
      id: overrides.messageId ?? 'mock-message-1',
      content: overrides.content ?? 'ping',
      group_openid: overrides.groupOpenid ?? 'mock-group-1',
      timestamp: '2026-09-22T10:00:00+08:00',
      message_type: 0,
      author: {
        id: 'mock-user-1',
        member_openid: 'mock-member-1',
        username: 'tester',
        member_role: 'member',
      },
      message_scene: { source: 'default', ext: ['msg_idx=REFIDX_1=='] },
    });
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('替身后端监听失败'));
        return;
      }
      port = address.port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        pushEvent,
        pushGroupAt,
        pushC2C,
        close: () => {
          state.link = null;
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close();
        },
      });
    });
  });
}
