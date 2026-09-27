import { pathToFileURL } from 'node:url';

const source = process.argv[2];
if (!source) process.exit(2);

process.once('message', async (payload: unknown) => {
  try {
    if (typeof payload !== 'string') throw new Error('插件输入无效');
    const input: unknown = JSON.parse(payload);
    const loaded: unknown = await import(pathToFileURL(source).href);
    const run = (loaded as { default?: unknown }).default;
    if (typeof run !== 'function') throw new Error('插件必须 export default async function run(input)');
    const value: unknown = await run(input);
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
      throw new Error('插件输出必须是小于 16 KiB 的 JSON');
    }
    process.send?.({ ok: true, value: JSON.parse(serialized) }, () => process.exit(0));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.send?.({ ok: false, error: message.slice(0, 500) }, () => process.exit(1));
  }
});
