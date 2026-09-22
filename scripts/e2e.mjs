/**
 * 端到端自检：把真实内核（dist/main.js）指向本地替身后端，跑完整链路。
 *
 * 与 smoke.mjs 的分工：smoke 在进程内直接调用模块、断言单元行为；e2e 完全不 import
 * src，只通过 env 与 stdin/stdout/stderr 驱动 dist 产物，因此它能覆盖 smoke 覆盖不到
 * 的部分 —— 真正的进程启动、fetch 到 token/gateway、WebSocket 握手与心跳、事件下行、
 * 被动回复上行，以及 SIGTERM 关停顺序。
 *
 * 替身后端见 scripts/e2e/mock-qq.mjs，不是内核的一部分。
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockQq } from './e2e/mock-qq.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(label, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  console.log(`FAIL 等待超时：${label}`);
  failures += 1;
  return false;
}

async function main() {
  const mock = await startMockQq({ heartbeatInterval: 1200 });
  const logs = [];

  const child = spawn(process.execPath, [resolve(root, 'dist/main.js')], {
    cwd: root,
    env: {
      ...process.env,
      QQ_APP_ID: 'mock-app-id',
      QQ_APP_SECRET: 'mock-app-secret',
      QQ_API_BASE: mock.baseUrl,
      PLUGIN_DIR: resolve(root, 'plugins'),
      LOG_LEVEL: 'debug',
    },
    // 带 ipc：内核用 {type:'shutdown'} 消息走优雅关停，这是 Windows 上唯一
    // 能真正触发关停路径的方式（child.kill('SIGTERM') 在 Windows 会退化成强杀）。
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  child.on('error', (cause) => logs.push(`[spawn error] ${cause.message}`));

  // 场景二/三会在中途创建，放在 try 之外声明，保证 finally 一定能收回它们的监听端口。
  let fatalMock = null;
  let resumeMock = null;

  try {
    if (!(await waitFor('内核读到 token 并拿到 Gateway 接入点', () => mock.state.tokenCalls >= 1 && mock.state.gatewayCalls >= 1))) {
      throw new Error('前置链路未打通');
    }
    check('token 只取了一次', mock.state.tokenCalls === 1, `calls=${mock.state.tokenCalls}`);
    check('Gateway 接入点来自 /gateway', mock.state.gatewayCalls === 1);
    check('启动时用 /users/@me 验证凭证（P1）', mock.state.selfInfoCalls === 1, `calls=${mock.state.selfInfoCalls}`);
    // 插件 init 日志必须带上内核下发的 config：manifest → supervisor → IPC 这条链路
    // 任何一环断了，这里都会退化成 config={}，断言即失败。
    check(
      '插件私有 config 已下发到插件进程',
      logs.join('').includes('config={"prefix":"echo"}'),
      '插件 init 日志应带上内核下发的 config',
    );

    await waitFor('内核发出 Identify 并收到 READY', () => mock.state.readyAt !== null);

    const identify = mock.state.identifies[0];
    check('Identify 的 token 形如 QQBot {token}', identify?.token === 'QQBot mock-access-token', `token=${String(identify?.token)}`);
    check('Identify intents 聚合自插件 manifest', identify?.intents === 1 << 25, `intents=${identify?.intents}`);
    check('Identify 分片为 [0,1]', Array.isArray(identify?.shard) && identify.shard[0] === 0 && identify.shard[1] === 1);

    await waitFor('心跳发出并收到 ACK', () => mock.state.heartbeats >= 1);

    mock.pushGroupAt({ content: 'ping' });
    if (!(await waitFor('群 @ 事件被内核处理并回复', () => mock.state.sends.length >= 1))) {
      throw new Error('未观察到回复');
    }
    const first = mock.state.sends[0];
    check('被动回复带上了原消息 msg_id', first?.body?.msg_id === 'mock-message-1', `msg_id=${first?.body?.msg_id}`);
    check('被动回复内容是 echo 插件产出', first?.body?.content === 'echo: ping', `content=${JSON.stringify(first?.body?.content)}`);
    check('被动回复是文本类型', first?.body?.msg_type === 0);
    check('msg_seq 从 1 开始', first?.body?.msg_seq === 1, `msg_seq=${first?.body?.msg_seq}`);

    const before = mock.state.sends.length;
    mock.pushGroupAt({ messageId: 'mock-message-1' });
    await sleep(600);
    check('重复 msg_id 被去重，没有二次发送', mock.state.sends.length === before, `sends=${mock.state.sends.length}`);

    const closesBefore = mock.state.sends.length;
    mock.pushGroupAt({ messageId: 'mock-message-2', content: 'second', groupOpenid: 'mock-group-2' });
    await waitFor('第二条消息也得到回复', () => mock.state.sends.length > closesBefore);
    const second = mock.state.sends.at(-1);
    check('第二条回复落到对应的群', second?.groupOpenid === 'mock-group-2', `group=${second?.groupOpenid}`);

    // 单聊：必须走 /v2/users/{uid}/messages，而不是群端点。
    mock.pushC2C({ content: 'hi-c2c' });
    if (!(await waitFor('单聊消息被处理并回复', () => mock.state.c2cSends.length >= 1))) {
      throw new Error('未观察到单聊回复');
    }
    const c2c = mock.state.c2cSends[0];
    check('单聊回复走单聊端点', c2c?.userOpenid === 'mock-c2c-user', `uid=${c2c?.userOpenid}`);
    check('单聊被动回复带 msg_id', c2c?.body?.msg_id === 'mock-c2c-message-1', `msg_id=${c2c?.body?.msg_id}`);
    check('单聊回复内容是 echo 插件产出', c2c?.body?.content === 'echo: hi-c2c', `content=${JSON.stringify(c2c?.body?.content)}`);
    check('单聊与群聊的发送互不污染', mock.state.sends.length === 2, `groupSends=${mock.state.sends.length}`);

    // 平台侧失败必须以稳定 reason 到达插件，而不是让插件去解析 err_code。
    // 40034005「msg_id 已过期」是 AI 类插件最容易撞的一种，内核必须能识别。
    mock.state.failSendContent = { content: 'echo: failme', errCode: 40034005 };
    mock.pushGroupAt({ messageId: 'mock-message-fail', content: 'failme' });
    await waitFor('失败发送已被处理', () =>
      logs.join('').includes('window_expired'),
    );
    check(
      '平台错误被翻译成稳定 reason（window_expired）',
      logs.join('').includes('window_expired'),
      '内核日志里应出现稳定 reason',
    );
    check(
      '失败的那条回复没有被计入成功发送',
      mock.state.sends.at(-1)?.body?.content === 'echo: failme',
      `content=${JSON.stringify(mock.state.sends.at(-1)?.body?.content)}`,
    );
    mock.state.failSendContent = null;

    const exitCode = await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, 10000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        done(code);
      });
      try {
        child.send({ type: 'shutdown' });
      } catch {
        child.kill('SIGTERM');
      }
    });
    check('收到关停指令后干净退出（code 0）', exitCode === 0, `exit=${String(exitCode)}`);
    check('关停日志出现', logs.join('').includes('已关停'));
    check('关停时插件也被正常停止', logs.join('').includes('插件已停止'));
    check('机器人 username 已带给插件', logs.join('').includes('机器人凭证可用 id=mock-bot username=icy'), '内核日志应报出凭证校验结果');

    // ------------------------------------------- 场景二：致命关闭码（4014 intents 无权限）
    // 服务端在 Identify 之后直接关连接，内核必须停下并退出，而不是无延迟重连刷日志。
    fatalMock = await startMockQq({ heartbeatInterval: 1200, closeCodeOnIdentify: 4014 });
    const fatalLogs = [];
    const fatalChild = spawn(process.execPath, [resolve(root, 'dist/main.js')], {
      cwd: root,
      env: {
        ...process.env,
        QQ_APP_ID: 'mock-app-id',
        QQ_APP_SECRET: 'mock-app-secret',
        QQ_API_BASE: fatalMock.baseUrl,
        PLUGIN_DIR: resolve(root, 'plugins'),
        LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    fatalChild.stdout.on('data', (chunk) => fatalLogs.push(String(chunk)));
    fatalChild.stderr.on('data', (chunk) => fatalLogs.push(String(chunk)));

    const fatalExit = await new Promise((done) => {
      const timer = setTimeout(() => {
        fatalChild.kill('SIGKILL');
        done(null);
      }, 20000);
      fatalChild.once('exit', (code) => {
        clearTimeout(timer);
        done(code);
      });
    });
    const fatalText = fatalLogs.join('');
    check('致命关闭码后内核退出（code 1）', fatalExit === 1, `exit=${String(fatalExit)}`);
    check('致命关闭码被识别（4014）', fatalText.includes('4014'), '日志里应出现关闭码');
    check('致命关闭码不触发重连退避', !fatalText.includes('后重连（第'), '不应出现重连日志');

    // --------------------------- 场景三：服务端主动关连接（4009 连接过期）→ Resume 恢复
    // 网关恢复路径唯一能被真实覆盖的方式：必须看到内核带着 session_id 重连，而不是
    // 退化成重新 Identify —— 后者会让断连期间的事件全部丢失。
    resumeMock = await startMockQq({ heartbeatInterval: 1200, closeCodeAfterReady: 4009 });
    const resumeLogs = [];
    const resumeChild = spawn(process.execPath, [resolve(root, 'dist/main.js')], {
      cwd: root,
      env: {
        ...process.env,
        QQ_APP_ID: 'mock-app-id',
        QQ_APP_SECRET: 'mock-app-secret',
        QQ_API_BASE: resumeMock.baseUrl,
        PLUGIN_DIR: resolve(root, 'plugins'),
        LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    resumeChild.stdout.on('data', (chunk) => resumeLogs.push(String(chunk)));
    resumeChild.stderr.on('data', (chunk) => resumeLogs.push(String(chunk)));

    await waitFor('关闭后内核重新连上并发出 Resume', () => resumeMock.state.resumes.length >= 1);
    const resume = resumeMock.state.resumes[0];
    const resumeText = resumeLogs.join('');
    check('重连时复用 session_id', resume?.session_id === 'mock-session', `session_id=${String(resume?.session_id)}`);
    check('Resume 带上最新 seq', resume?.seq === 1, `seq=${String(resume?.seq)}`);
    check('重连没有退化成重新 Identify', resumeMock.state.identifies.length === 1, `identifies=${resumeMock.state.identifies.length}`);
    check('重连重新获取了 Gateway 接入点', resumeMock.state.gatewayCalls === 2, `gatewayCalls=${resumeMock.state.gatewayCalls}`);
    check('内核记录了连接关闭码', resumeText.includes('code=4009'), '日志里应出现 4009');

    resumeMock.pushGroupAt({ content: 'after-resume' });
    await waitFor('恢复后事件仍能下行', () => resumeMock.state.sends.length >= 1);
    check(
      '恢复后被动回复正常',
      resumeMock.state.sends[0]?.body?.content === 'echo: after-resume',
      `content=${JSON.stringify(resumeMock.state.sends[0]?.body?.content)}`,
    );

    const resumeExit = await new Promise((done) => {
      const timer = setTimeout(() => {
        resumeChild.kill('SIGKILL');
        done(null);
      }, 10000);
      resumeChild.once('exit', (code) => {
        clearTimeout(timer);
        done(code);
      });
      try {
        resumeChild.send({ type: 'shutdown' });
      } catch {
        resumeChild.kill('SIGTERM');
      }
    });
    check('恢复后仍能干净关停', resumeExit === 0, `exit=${String(resumeExit)}`);
  } catch (error) {
    console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    mock.close();
    if (fatalMock !== null) fatalMock.close();
    if (resumeMock !== null) resumeMock.close();
  }

  if (failures > 0) {
    console.log('\n--- 内核日志 ---');
    console.log(logs.join(''));
    console.log(`\nE2E FAILED（${failures} 项）`);
    process.exit(1);
  }
  console.log('\nE2E OK');
  process.exit(0);
}

main().catch((error) => {
  console.log(`E2E 崩溃：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});