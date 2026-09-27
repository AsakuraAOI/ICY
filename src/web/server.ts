import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-ignore Node 22 ships SQLite before the matching @types/node declaration.
import { DatabaseSync } from 'node:sqlite';
import { applyBotSettings, defaultsFromManifest, parseBotSettings, readBotSettings } from '../host/bot-settings.js';
import { loadManifest } from '../host/manifest.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

interface WebConfig {
  host: string; port: number; passwordSalt: string; passwordHash: string;
  dbPath: string; logPath: string; manifestPath: string; settingsPath: string; webRoot: string;
  tlsCert: string | undefined; tlsKey: string | undefined;
}
function configFrom(env: NodeJS.ProcessEnv): WebConfig {
  const port = Number(env.ICY_WEB_PORT ?? '5099');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('ICY_WEB_PORT 无效');
  const [passwordSalt, passwordHash] = (env.ICY_WEB_PASSWORD_HASH ?? '').split(':');
  if (!passwordSalt || !passwordHash || !/^[a-f0-9]{128}$/.test(passwordHash)) throw new Error('ICY_WEB_PASSWORD_HASH 无效');
  return {
    host: env.ICY_WEB_HOST ?? '127.0.0.1', port, passwordSalt, passwordHash,
    dbPath: env.ICY_WEB_DB ?? '/var/lib/icy/agent/state.sqlite',
    logPath: env.ICY_WEB_LOG_FILE ?? '/var/lib/icy/bot.log',
    manifestPath: env.ICY_WEB_MANIFEST ?? '/opt/icy/current/plugins/app-runtime/plugin.json',
    settingsPath: env.ICY_BOT_SETTINGS ?? '/var/lib/icy/config/bot-settings.json',
    webRoot: env.ICY_WEB_ROOT ?? resolve(process.cwd(), 'web'),
    tlsCert: env.ICY_WEB_TLS_CERT,
    tlsKey: env.ICY_WEB_TLS_KEY,
  };
}
function json(reply: ServerResponse, status: number, body: unknown): void {
  reply.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  reply.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求格式无效'); }
}
function cookie(request: IncomingMessage, name: string): string | undefined {
  const part = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}
function revision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function readDatabase(path: string): { total: number; byStatus: Record<string, number>; runs: unknown[] } {
  // DatabaseSync is isolated here because the WebUI must never write to Agent state.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const total = Number((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n);
    const byStatus: Record<string, number> = {};
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM runs GROUP BY status').all() as { status: string; n: number }[]) byStatus[row.status] = Number(row.n);
    const rows = db.prepare('SELECT id, session_key, status, delivery, input, result, error_kind, created_at, updated_at FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 50').all() as Record<string, string | null>[];
    return { total, byStatus, runs: rows.map((row) => ({
      id: row.id, session: createHash('sha256').update(row.session_key ?? '').digest('hex').slice(0, 10),
      status: row.status, delivery: row.delivery, inputPreview: row.input?.slice(0, 100),
      resultPreview: row.result?.slice(0, 120), errorKind: row.error_kind,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })) };
  } finally { db.close(); }
}
function recentLogs(path: string, limit: number): string[] {
  try {
    const size = statSync(path).size;
    const bytes = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(bytes);
    const fd = openSync(path, 'r');
    try { readSync(fd, buffer, 0, bytes, size - bytes); } finally { closeSync(fd); }
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (size > bytes) lines.shift();
    return lines.filter(Boolean).slice(-limit).map((line) => line.replace(/sk-[A-Za-z0-9_-]{16,}|da[A-Za-z0-9/+]{16,}/g, '[redacted]'));
  } catch { return []; }
}
function botActive(): boolean {
  const result = spawnSync('systemctl', ['is-active', 'icy.service'], { encoding: 'utf8', timeout: 2000 });
  return result.status === 0 && result.stdout.trim() === 'active';
}
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || typeof request.headers.host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    const protocol = 'encrypted' in request.socket || request.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    return parsed.host === request.headers.host && parsed.protocol === protocol;
  } catch { return false; }
}

export function createWebServer(env: NodeJS.ProcessEnv = process.env) {
  const config = configFrom(env);
  const sessions = new Map<string, { expires: number; csrf: string }>();
  const failures = new Map<string, { count: number; since: number }>();
  const expectedHash = Buffer.from(config.passwordHash, 'hex');
  let saving = false;
  const handler = async (request: IncomingMessage, reply: ServerResponse) => {
    reply.setHeader('X-Content-Type-Options', 'nosniff');
    reply.setHeader('X-Frame-Options', 'DENY');
    reply.setHeader('Referrer-Policy', 'no-referrer');
    reply.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/health' && request.method === 'GET') { json(reply, 200, { status: 'ok' }); return; }
    const token = cookie(request, 'icy_web');
    const tokenHash = token ? createHash('sha256').update(token).digest('hex') : '';
    const session = sessions.get(tokenHash);
    const authenticated = session !== undefined && session.expires > Date.now();
    if (path === '/api/auth' && request.method === 'GET') { json(reply, 200, { authenticated, csrf: authenticated ? session.csrf : undefined }); return; }
    if (path === '/api/login' && request.method === 'POST') {
      const address = request.socket.remoteAddress ?? 'unknown';
      const old = failures.get(address);
      const record = old && Date.now() - old.since < LOGIN_WINDOW_MS ? old : { count: 0, since: Date.now() };
      if (record.count >= MAX_LOGIN_FAILURES) { json(reply, 429, { error: '尝试过多，请稍后再试' }); return; }
      let body: unknown;
      try { body = await readBody(request, 2048); } catch { json(reply, 400, { error: '请求格式无效' }); return; }
      const password = body && typeof body === 'object' && 'password' in body ? body.password : undefined;
      const candidate = typeof password === 'string' && password.length <= 512 ? scryptSync(password, config.passwordSalt, 64) : Buffer.alloc(64);
      if (!timingSafeEqual(candidate, expectedHash)) {
        failures.set(address, { ...record, count: record.count + 1 });
        json(reply, 401, { error: '密码错误' }); return;
      }
      failures.delete(address);
      for (const [id, value] of sessions) if (value.expires <= Date.now()) sessions.delete(id);
      if (sessions.size >= 2000) sessions.delete(sessions.keys().next().value!);
      const newToken = randomBytes(32).toString('base64url');
      const csrf = randomBytes(24).toString('base64url');
      sessions.set(createHash('sha256').update(newToken).digest('hex'), { expires: Date.now() + SESSION_MS, csrf });
      const secure = 'encrypted' in request.socket || request.headers['x-forwarded-proto'] === 'https';
      reply.setHeader('Set-Cookie', `icy_web=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
      json(reply, 200, { ok: true, csrf }); return;
    }
    if (path.startsWith('/api/')) {
      if (!authenticated) { json(reply, 401, { error: '请先登录' }); return; }
      if (path === '/api/logout' && request.method === 'POST') {
        sessions.delete(tokenHash);
        reply.setHeader('Set-Cookie', 'icy_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        json(reply, 200, { ok: true }); return;
      }
      try {
        if (path === '/api/summary' && request.method === 'GET') {
          const data = readDatabase(config.dbPath);
          const manifest = await loadManifest(dirname(config.manifestPath));
          const settings = await readBotSettings(config.settingsPath, manifest);
          json(reply, 200, { botActive: botActive(), modelAlias: settings.agent.modelAlias || '未配置', totalRuns: data.total, byStatus: data.byStatus, latestRunAt: (data.runs[0] as { createdAt?: string } | undefined)?.createdAt ?? null }); return;
        }
        if (path === '/api/runs' && request.method === 'GET') { json(reply, 200, { runs: readDatabase(config.dbPath).runs }); return; }
        if (path === '/api/logs' && request.method === 'GET') { json(reply, 200, { lines: recentLogs(config.logPath, 180) }); return; }
        if (path === '/api/settings' && request.method === 'GET') {
          const manifest = await loadManifest(dirname(config.manifestPath));
          const settings = await readBotSettings(config.settingsPath, manifest);
          json(reply, 200, { settings, revision: revision(settings) }); return;
        }
        if (path === '/api/settings/validate' && request.method === 'POST') {
          if (!sameOrigin(request) || request.headers['x-icy-csrf'] !== session.csrf) { json(reply, 403, { error: '请求校验失败，请刷新页面' }); return; }
          try {
            const body = await readBody(request, 128 * 1024) as Record<string, unknown>;
            const manifest = await loadManifest(dirname(config.manifestPath));
            const settings = parseBotSettings(body?.settings);
            applyBotSettings(manifest, settings);
            // Editors stage a validated draft; only PUT /api/settings persists it.
            json(reply, 200, { settings }); return;
          } catch (error) {
            json(reply, 422, { error: error instanceof Error ? error.message : '配置无效' }); return;
          }
        }
        if (path === '/api/settings' && request.method === 'PUT') {
          if (!sameOrigin(request) || request.headers['x-icy-csrf'] !== session.csrf) { json(reply, 403, { error: '请求校验失败，请刷新页面' }); return; }
          if (saving) { json(reply, 409, { error: '另一项保存正在进行' }); return; }
          saving = true;
          try {
            const body = await readBody(request, 128 * 1024) as Record<string, unknown>;
            const manifest = await loadManifest(dirname(config.manifestPath));
            const current = await readBotSettings(config.settingsPath, manifest);
            if (body?.revision !== revision(current)) { json(reply, 409, { error: '设置已被其他页面修改，请刷新后重试' }); return; }
            const next = parseBotSettings(body.settings);
            applyBotSettings(manifest, next);
            const parent = dirname(config.settingsPath);
            await mkdir(parent, { recursive: true, mode: 0o700 });
            const temp = `${config.settingsPath}.${randomBytes(8).toString('hex')}.tmp`;
            try {
              await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
              await rename(temp, config.settingsPath);
            } finally { await unlink(temp).catch(() => {}); }
            json(reply, 200, { ok: true, revision: revision(next), restarting: true }); return;
          } catch (error) {
            json(reply, error instanceof SyntaxError ? 400 : 422, { error: error instanceof Error ? error.message : '保存失败' }); return;
          } finally { saving = false; }
        }
      } catch (error) {
        process.stderr.write(`ICY WebUI 查询失败：${error instanceof Error ? error.message : String(error)}\n`);
        json(reply, 503, { error: '数据暂时无法读取' }); return;
      }
      json(reply, 404, { error: '接口不存在' }); return;
    }
    const assets: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
    };
    const asset = assets[path];
    if (request.method !== 'GET' || !asset) { reply.writeHead(404); reply.end(); return; }
    try {
      reply.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
      reply.end(readFileSync(resolve(config.webRoot, asset[0])));
    } catch { reply.writeHead(503); reply.end('WebUI assets unavailable'); }
  };
  if (config.tlsCert && config.tlsKey) return createHttpsServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler);
  if (config.tlsCert || config.tlsKey) throw new Error('TLS 证书与密钥必须同时配置');
  return createServer(handler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const config = configFrom(process.env);
  createWebServer().listen(config.port, config.host, () => process.stderr.write(`ICY WebUI listening on ${config.host}:${config.port}\n`));
}
