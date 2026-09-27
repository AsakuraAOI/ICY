import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scryptSync } from 'node:crypto';
import { createWebServer } from '../dist/web/server.js';
import { applyBotSettings, parseBotSettings, readBotSettings } from '../dist/host/bot-settings.js';
import { loadManifest } from '../dist/host/manifest.js';

const dir = await mkdtemp(join(tmpdir(), 'icy-web-test-'));
const settingsPath = join(dir, 'bot-settings.json');
const salt = 'test-salt';
const password = 'local-test-password';
const server = createWebServer({
  ICY_WEB_HOST: '127.0.0.1', ICY_WEB_PORT: '0',
  ICY_WEB_PASSWORD_HASH: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
  ICY_WEB_MANIFEST: resolve('plugins/app-runtime/plugin.json'), ICY_BOT_SETTINGS: settingsPath,
  ICY_WEB_ROOT: resolve('web'),
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const anonymous = await fetch(`${base}/api/settings`);
  assert.equal(anonymous.status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: base };
  const initial = await (await fetch(`${base}/api/settings`, { headers })).json();
  assert.equal(initial.settings.persona.defaultId, 'assistant');
  assert.equal(initial.settings.policy.groupCommandsWithoutMention, true);
  const legacyPolicy = structuredClone(initial.settings);
  delete legacyPolicy.policy.groupCommandsWithoutMention;
  assert.equal(parseBotSettings(legacyPolicy).policy.groupCommandsWithoutMention, true, '旧设置兼容免 @ 命令开关');
  const legacy = structuredClone(initial.settings);
  delete legacy.plugins;
  assert.equal(parseBotSettings(legacy).plugins.memory.enabled, true, '旧设置文件应能加载新插件默认值');
  assert.equal(parseBotSettings(legacy).plugins.humanize.enabled, true);
  const oldPlugins = structuredClone(initial.settings);
  delete oldPlugins.plugins.humanize;
  assert.equal(parseBotSettings(oldPlugins).plugins.humanize.perLine, true, '旧插件设置应兼容新增的拟人化插件');
  const updated = structuredClone(initial.settings);
  updated.persona.profiles[0].name = '测试人设';
  updated.policy.allowedGroups = ['test-group'];
  updated.policy.groupCommandsWithoutMention = false;
  updated.plugins.humanize = { enabled: true, stripTerminalPunctuation: true, perLine: false, includeCommands: true };
  updated.plugins.autoReply = { enabled: true, rules: [{ id: 'test', keyword: 'hi', match: 'exact', reply: 'hello', scopes: ['group'], groupOpenids: ['test-group'], cooldownSeconds: 5 }] };
  let validation = await fetch(`${base}/api/settings/validate`, { method: 'POST', headers, body: JSON.stringify({ settings: updated }) });
  assert.equal(validation.status, 403, '草稿校验也应校验 CSRF');
  validation = await fetch(`${base}/api/settings/validate`, { method: 'POST', headers: { ...headers, 'X-ICY-CSRF': csrf }, body: JSON.stringify({ settings: updated }) });
  assert.equal(validation.status, 200);
  assert.equal((await validation.json()).settings.persona.profiles[0].name, '测试人设');
  assert.equal((await (await fetch(`${base}/api/settings`, { headers })).json()).revision, initial.revision, '草稿校验不能写入配置');
  const invalidDraft = structuredClone(updated);
  invalidDraft.persona.defaultId = 'missing';
  validation = await fetch(`${base}/api/settings/validate`, { method: 'POST', headers: { ...headers, 'X-ICY-CSRF': csrf }, body: JSON.stringify({ settings: invalidDraft }) });
  assert.equal(validation.status, 422, '校验应拒绝不存在的人设引用');
  let response = await fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ revision: initial.revision, settings: updated }) });
  assert.equal(response.status, 403);
  response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { ...headers, 'X-ICY-CSRF': csrf }, body: JSON.stringify({ revision: initial.revision, settings: updated }) });
  assert.equal(response.status, 200, await response.text());
  const manifest = await loadManifest(resolve('plugins/app-runtime'));
  const stored = await readBotSettings(settingsPath, manifest);
  assert.equal(stored.persona.profiles[0].name, '测试人设');
  const effective = applyBotSettings(manifest, stored);
  const modules = effective.config.modules;
  assert.equal(effective.config.groupCommandsWithoutMention, false, 'WebUI 开关应覆盖接入层配置');
  assert.deepEqual(modules.find((entry) => entry.path?.endsWith('/agent/policy.js')).config.allowedGroups, ['test-group']);
  assert.equal(modules.find((entry) => entry.path?.endsWith('/auto-reply/module.js')).config.rules[0].reply, 'hello');
  assert.equal(modules.find((entry) => entry.path?.endsWith('/humanize/module.js')).config.perLine, false);
  const invalid = structuredClone(updated);
  invalid.persona.defaultId = 'missing';
  const currentRevision = (await (await fetch(`${base}/api/settings`, { headers })).json()).revision;
  response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { ...headers, 'X-ICY-CSRF': csrf }, body: JSON.stringify({ revision: currentRevision, settings: invalid }) });
  assert.equal(response.status, 422);
  response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { ...headers, 'X-ICY-CSRF': csrf }, body: JSON.stringify({ revision: initial.revision, settings: updated }) });
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).persona.profiles[0].name, '测试人设');
  process.stdout.write('WebUI 设置认证、CSRF、保存、覆盖与冲突检查通过\n');
} finally {
  await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
