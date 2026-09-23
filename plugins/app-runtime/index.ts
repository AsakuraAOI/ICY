/**
 * App Runtime Plugin —— 一个普通的 ICY Plugin。
 *
 * 它对 ICY 内核的意义只有一句话：订阅消息事件，把结果当成被动回复交回去。
 * 它内部跑的是什么（模块、服务、事件、管道）与内核完全无关 —— 内核不认识
 * Module / Service / Event / Pipeline，只认识 event/dispatch 的返回形状。
 *
 * 为什么 config.modules 是路径列表而不是「自动发现」：
 * 模块装配必须显式、可复现：自动扫描目录会让「哪些模块被加载」取决于磁盘状态，
 * 排查问题时无法从配置复现。v0 不做 marketplace / npm 发现 / semver 求解。
 *
 * 启动失败的处理：onInit 里 Application.start() 抛出的错误不捕获 —— 让 SDK 把
 * lifecycle/init 回成错误、不发 plugin/ready，交给 ICY Supervisor 按启动失败处理
 * （隔离 + 重试）。这里绝不能「降级为空应用继续跑」：半启动的运行时比启动失败更难查。
 */

import { createPlugin } from 'icy-qqbot/sdk';
import type { PluginHost } from 'icy-qqbot/sdk';
import { Application, createCoreModule } from 'icy-qqbot/app';
import type { Logger } from 'icy-qqbot/app';

type RuntimeConfig = { modules?: unknown };

/** 模块日志经 host/log 回到 ICY 内核：stdout 属于协议帧，不能直接写。 */
function hostLogger(host: PluginHost): Logger {
  const at =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields?: Record<string, unknown>): void => {
      host.log(level, message, fields);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function readModuleSpecs(config: RuntimeConfig): string[] {
  const raw = config.modules;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('app-runtime 的 config.modules 必须是字符串数组（模块入口路径列表）');
  }
  return raw.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`app-runtime 的 config.modules 里有非法条目：${JSON.stringify(item)}`);
    }
    return item;
  });
}

let application: Application | null = null;

createPlugin<RuntimeConfig>({
  name: 'app-runtime',
  version: '0.1.0',

  async onInit({ host, config }) {
    const app = new Application({ logger: hostLogger(host) });

    // Core Module 由 Runtime 装配：它提供 EventBus 与 MessagePipeline。
    app.add(createCoreModule());

    // 模块路径相对插件进程 cwd（= 插件目录），与 ICY 的 spawn 约定一致。
    for (const spec of readModuleSpecs(config)) {
      await app.load(spec);
    }

    await app.start();
    application = app;
    host.log('info', `App Runtime 已启动，模块顺序：${app.dependencyOrder.join(' → ')}`);
  },

  async onEvent({ event, reply, host }) {
    // 未启动就不处理。这里返回 null 而不是抛错：对这条消息来说「没人处理」是正确语义，
    // 抛出去只会让内核记一条 JSON-RPC 错误，问题依旧没有上下文。
    if (application === null) return null;
    return application.dispatch({ event, reply, host });
  },

  async onShutdown({ host }) {
    const app = application;
    application = null;
    if (app === null) return;

    try {
      await app.stop();
      host.log('info', 'App Runtime 已停止');
    } catch (error) {
      // 关停阶段不能把异常抛回 SDK：那会变成一个 lifecycle/shutdown 的错误回应，
      // 而内核此时已经在关停流程里。清理失败必须记录，但不能阻止插件退出。
      host.log('error', `App Runtime 停止时有模块清理失败：${describe(error)}`);
    }
  },
}).run();

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}