import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fork } from 'node:child_process';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActorContext } from '../agent/identity.js';

const execFileAsync = promisify(execFile);
const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_SOURCE = 20 * 1024;
const MAX_TESTS = 4 * 1024;

interface TestCase { input: unknown; expected: unknown }
interface PluginMeta { name: string; description: string; sha256: string; tests: number; createdAt: string }
type WorkerResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface CreateInput {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly testsJson: string;
  readonly inputJson?: string;
}

/** Generated code is trusted as local code; the process boundary limits hangs, not filesystem access. */
export class GeneratedPluginStore {
  readonly #root: string;
  readonly #pending = new Set<string>();

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('plugin-writer.dataDir 必须是绝对路径');
    this.#root = root;
  }

  async list(actor: ActorContext): Promise<PluginMeta[]> {
    const owner = this.#owner(actor);
    let entries;
    try { entries = await readdir(owner, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: PluginMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
      try {
        const meta: unknown = JSON.parse(await readFile(join(owner, entry.name, 'meta.json'), 'utf8'));
        if (isMeta(meta) && meta.name === entry.name) result.push(meta);
      } catch { /* Ignore incomplete or invalid directories. */ }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 15);
  }

  async create(actor: ActorContext, input: CreateInput, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { name, description, source, testsJson, inputJson } = input;
    if (!NAME.test(name)) return failure('name 只能是小写字母开头，后接小写字母、数字、_ 或 -，最长 40 位');
    if (typeof description !== 'string' || !description.trim() || description.length > 300) return failure('description 长度应为 1–300 字');
    if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE || !source.trim()) return failure('source 不能为空或超过 20 KiB');
    if (typeof testsJson !== 'string' || Buffer.byteLength(testsJson, 'utf8') > MAX_TESTS) return failure('testsJson 超过 4 KiB');
    let tests: TestCase[];
    try { tests = parseTests(testsJson); }
    catch (error) { return failure(messageOf(error)); }
    let initialInput: unknown;
    if (inputJson !== undefined) {
      if (typeof inputJson !== 'string' || Buffer.byteLength(inputJson, 'utf8') > 8 * 1024) {
        return failure('inputJson 超过 8 KiB');
      }
      try { initialInput = JSON.parse(inputJson); }
      catch { return failure('inputJson 不是合法 JSON'); }
    }

    const owner = this.#owner(actor);
    const target = join(owner, name);
    const key = `${owner}/${name}`;
    if (this.#pending.has(key)) return failure('同名插件正在创建');
    this.#pending.add(key);
    let stage: string | null = null;
    try {
      await mkdir(owner, { recursive: true });
      const sha256 = createHash('sha256').update(source).digest('hex');
      const existing = await this.#readMeta(target);
      if (existing !== null) {
        if (existing.sha256 !== sha256) return failure('同名插件已存在；请使用新名称');
        if (inputJson === undefined) return { ok: true, name, reused: true, tests: existing.tests };
        const reused = await runWorker(join(target, 'index.mjs'), initialInput, signal, 5_000);
        return reused.ok ? { ok: true, name, reused: true, tests: existing.tests, result: reused.value }
          : failure(reused.error);
      }
      stage = await mkdtemp(join(owner, '.draft-'));
      const sourcePath = join(stage, 'index.mjs');
      await writeFile(sourcePath, source, { flag: 'wx' });
      try {
        await execFileAsync(process.execPath, ['--check', sourcePath], {
          cwd: stage, env: childEnv(), timeout: 3_000, maxBuffer: 4_096, signal,
        });
      } catch (error) { return failure(`语法检查失败：${messageOf(error).slice(0, 500)}`); }
      for (let index = 0; index < tests.length; index += 1) {
        const test = tests[index]!;
        const result = await runWorker(sourcePath, test.input, signal, 5_000);
        if (!result.ok) return failure(`测试 ${index + 1} 执行失败：${result.error}`);
        if (!isDeepStrictEqual(result.value, test.expected)) {
          return failure(`测试 ${index + 1} 不匹配；预期 ${shortJson(test.expected)}，实际 ${shortJson(result.value)}`);
        }
      }
      let initialResult: WorkerResult | undefined;
      if (inputJson !== undefined) {
        initialResult = await runWorker(sourcePath, initialInput, signal, 5_000);
        if (!initialResult.ok) return failure(`首次调用失败：${initialResult.error}`);
      }
      if (signal.aborted) return failure('任务已取消');
      const meta: PluginMeta = { name, description: description.trim(), sha256, tests: tests.length, createdAt: new Date().toISOString() };
      await writeFile(join(stage, 'meta.json'), JSON.stringify(meta), { flag: 'wx' });
      await rename(stage, target);
      stage = null;
      return { ok: true, name, tests: tests.length,
        ...(initialResult?.ok ? { result: initialResult.value } : {}) };
    } catch (error) {
      return failure(messageOf(error).slice(0, 500));
    } finally {
      if (stage !== null) await rm(stage, { recursive: true, force: true });
      this.#pending.delete(key);
    }
  }

  async run(actor: ActorContext, name: string, inputJson: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!NAME.test(name)) return failure('插件名无效');
    if (typeof inputJson !== 'string' || Buffer.byteLength(inputJson, 'utf8') > 8 * 1024) return failure('inputJson 超过 8 KiB');
    let input: unknown;
    try { input = JSON.parse(inputJson); }
    catch { return failure('inputJson 不是合法 JSON'); }
    const target = join(this.#owner(actor), name);
    if (await this.#readMeta(target) === null) return failure('插件不存在');
    const result = await runWorker(join(target, 'index.mjs'), input, signal, 5_000);
    return result.ok ? { ok: true, result: result.value } : failure(result.error);
  }

  async #readMeta(dir: string): Promise<PluginMeta | null> {
    try {
      const meta: unknown = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      return isMeta(meta) ? meta : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  #owner(actor: ActorContext): string {
    const hash = createHash('sha256').update(JSON.stringify([actor.botId, actor.actorId])).digest('hex');
    return join(this.#root, hash);
  }
}

function parseTests(value: string): TestCase[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3 ||
    parsed.some((test) => test === null || typeof test !== 'object' || Array.isArray(test) ||
      !Object.hasOwn(test, 'input') || !Object.hasOwn(test, 'expected'))) {
    throw new Error('testsJson 必须是 1–3 个 {input, expected} 对象的数组');
  }
  return parsed as TestCase[];
}

function isMeta(value: unknown): value is PluginMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === 'string' && NAME.test(item.name) &&
    typeof item.description === 'string' && typeof item.sha256 === 'string' &&
    typeof item.tests === 'number' && typeof item.createdAt === 'string';
}

function childEnv(): NodeJS.ProcessEnv {
  return process.platform === 'win32' && process.env.SystemRoot
    ? { SystemRoot: process.env.SystemRoot } : {};
}

async function runWorker(sourcePath: string, input: unknown, signal: AbortSignal, timeoutMs: number): Promise<WorkerResult> {
  if (signal.aborted) return { ok: false, error: '任务已取消' };
  return new Promise((resolve) => {
    const child = fork(WORKER, [sourcePath], {
      cwd: dirname(sourcePath), env: childEnv(),
      execArgv: ['--permission', `--allow-fs-read=${WORKER}`, `--allow-fs-read=${sourcePath}`,
        '--max-old-space-size=256'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    let settled = false;
    const finish = (result: WorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(result);
        return;
      }
      child.once('exit', () => resolve(result));
      child.kill('SIGKILL');
    };
    const onAbort = (): void => finish({ ok: false, error: '任务已取消' });
    const timer = setTimeout(() => finish({ ok: false, error: '插件执行超时' }), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => finish({ ok: false, error: `插件进程启动失败：${error.message}` }));
    child.once('exit', () => finish({ ok: false, error: '插件进程未返回结果' }));
    child.once('message', (message: unknown) => {
      if (message !== null && typeof message === 'object' && 'ok' in message) {
        const result = message as WorkerResult;
        finish(result.ok ? { ok: true, value: result.value } : { ok: false, error: String(result.error).slice(0, 500) });
      } else finish({ ok: false, error: '插件进程返回无效结果' });
    });
    child.send(JSON.stringify(input), (error) => { if (error) finish({ ok: false, error: '插件输入发送失败' }); });
  });
}

function failure(error: string): { ok: false; error: string } { return { ok: false, error }; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function shortJson(value: unknown): string { return JSON.stringify(value).slice(0, 200); }
