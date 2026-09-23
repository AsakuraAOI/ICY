/**
 * 验证模块之间共享的契约（service token + event token）。
 *
 * 为什么单独一个文件：token 是「双方都要知道的名字」。provider 与 consumer
 * 各写一个 `defineService('demo.counter')` 也能靠 id 字符串对上，但那就退化成裸字符串
 * —— 拼写错误只在运行时暴露，而且类型信息全丢。契约文件让双方共享同一个 token 对象，
 * 类型检查覆盖到调用点。
 *
 * 这是真实 App Module 的写法示范：业务 token 属于「用它的那些模块」，
 * 不属于 Runtime，也不属于 Core Module。
 */

import type { InboundEvent } from '../sdk/index.js';
import { defineEvent, defineService } from '../app/runtime/contracts.js';

/**
 * 「请明确执行一件事并返回结果」的示范：进程内计数器。
 * 它与 Event 的分工是硬的 —— 读取当前值必须走 Service，
 * 不能靠广播一个事件再收集回答。
 */
export interface CounterService {
  increment(): number;
  get(): number;
}

/** 审计器对外暴露的只读计数。用于让外部（测试）观察 EventBus 广播真的发生过。 */
export interface AuditService {
  count(): number;
  lastContent(): string | null;
}

/** 广播用的载荷：某条消息被看到了。只是「某件事发生了」，没有返回值。 */
export interface MessageSeenPayload {
  readonly scope: 'group' | 'c2c';
  readonly content: string;
}

export const Counter = defineService<CounterService>('demo.counter');
export const Audit = defineService<AuditService>('demo.audit');
export const MessageSeen = defineEvent<MessageSeenPayload>('demo.message.seen');

/**
 * 只有群聊 / 单聊消息才有可回复的 scope。
 * 放在契约层是因为 pinger 与 greeter 都要判断同一件事，判定规则不能有两份实现。
 */
export function replyScopeOf(event: InboundEvent): 'group' | 'c2c' | null {
  if (event.kind === 'group') return 'group';
  if (event.kind === 'c2c') return 'c2c';
  return null;
}