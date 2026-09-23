import { defineModule } from '../../app/runtime/module.js';
import { Tools } from './tools.js';

interface KnowledgeEntry {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly visibility: 'public' | 'groups';
  readonly groupOpenids: readonly string[];
}

interface BasicToolsConfig {
  readonly knowledge?: unknown;
}

export const basicToolsModule = defineModule<BasicToolsConfig>({
  name: 'tools-basic',
  version: '0.1.0',
  requires: ['tools'],
  setup(ctx) {
    const tools = ctx.services.require(Tools);
    const knowledge = readKnowledge(ctx.config.knowledge);

    tools.register({
      name: 'clock_now', version: '1', effect: 'read', timeoutMs: 1_000, maxOutputBytes: 1_024,
      requiredAction: 'tools.clock_now', resource: () => ({ kind: 'tool' }),
      description: '返回当前日期、时间和可选时区。',
      inputSchema: {
        type: 'object', properties: { timeZone: { type: 'string', maxLength: 64 } },
        additionalProperties: false,
      },
      execute(args) {
        const timeZone = typeof args.timeZone === 'string' ? args.timeZone : 'UTC';
        const now = new Date();
        return {
          iso: now.toISOString(), timeZone,
          local: new Intl.DateTimeFormat('zh-CN', {
            timeZone, dateStyle: 'full', timeStyle: 'long',
          }).format(now),
        };
      },
    });

    tools.register({
      name: 'calculator_evaluate', version: '1', effect: 'read', timeoutMs: 1_000,
      requiredAction: 'tools.calculator_evaluate', resource: () => ({ kind: 'tool' }),
      maxOutputBytes: 1_024,
      description: '计算只包含数字、括号和加减乘除的表达式。',
      inputSchema: {
        type: 'object', properties: { expression: { type: 'string', maxLength: 160 } },
        required: ['expression'], additionalProperties: false,
      },
      execute(args) {
        return { value: evaluate(String(args.expression)) };
      },
    });

    if (knowledge.length > 0) tools.register({
      name: 'knowledge_search', version: '1', effect: 'read', timeoutMs: 1_000,
      requiredAction: 'knowledge.read',
      resource: (_args, actor) => ({ kind: 'knowledge',
        ...(actor.groupOpenid === undefined ? {} : { groupOpenid: actor.groupOpenid }) }),
      maxOutputBytes: 16 * 1024,
      description: '查询管理员预先配置的知识条目，返回匹配摘要与出处。',
      inputSchema: {
        type: 'object', properties: { query: { type: 'string', maxLength: 100 } },
        required: ['query'], additionalProperties: false,
      },
      execute(args, toolCtx) {
        const query = String(args.query).trim().toLocaleLowerCase();
        if (query === '') return { matches: [] };
        const terms = query.split(/\s+/).slice(0, 8);
        const matches = knowledge
          .filter((entry) => entry.visibility === 'public' ||
            (toolCtx.actor.groupOpenid !== undefined &&
              entry.groupOpenids.includes(toolCtx.actor.groupOpenid)))
          .map((entry) => ({
            entry,
            score: terms.reduce(
              (sum, term) => sum + (entry.title.toLocaleLowerCase().includes(term) ? 2 : 0)
                + (entry.text.toLocaleLowerCase().includes(term) ? 1 : 0),
              0,
            ),
          }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(({ entry }) => ({ id: entry.id, title: entry.title, excerpt: entry.text.slice(0, 360) }));
        return { matches };
      },
    });
    ctx.logger.info(`只读工具已注册：clock_now / calculator_evaluate${knowledge.length > 0 ? ' / knowledge_search' : ''}（知识条目 ${knowledge.length}）`);
  },
});

function readKnowledge(value: unknown): KnowledgeEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('tools-basic.knowledge 必须是最多 100 条的数组');
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`tools-basic.knowledge[${index}] 必须是对象`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string' || record.id.trim() === '' || record.id.length > 80 ||
      typeof record.title !== 'string' || record.title.trim() === '' || record.title.length > 200 ||
      typeof record.text !== 'string' || record.text.trim() === '' || record.text.length > 4_000
    ) {
      throw new Error(`tools-basic.knowledge[${index}] 缺少有效 id/title/text`);
    }
    const visibility = record.visibility;
    if (visibility !== 'public' && visibility !== 'groups') {
      throw new Error(`tools-basic.knowledge[${index}].visibility 必须是 public 或 groups`);
    }
    const groupOpenids = record.groupOpenids ?? [];
    if (!Array.isArray(groupOpenids) || groupOpenids.some((id) => typeof id !== 'string' || id === '') ||
      (visibility === 'groups' && groupOpenids.length === 0)) {
      throw new Error(`tools-basic.knowledge[${index}].groupOpenids 无效`);
    }
    return { id: record.id, title: record.title, text: record.text,
      visibility, groupOpenids: groupOpenids as string[] };
  });
}

/** 有界递归下降计算器。输入只有四则运算，拒绝任意代码和非有限结果。 */
export function evaluate(expression: string): number {
  if (expression.length === 0 || expression.length > 160) throw new Error('表达式长度无效');
  let cursor = 0;
  const spaces = (): void => {
    while (cursor < expression.length && /\s/.test(expression[cursor] ?? '')) cursor += 1;
  };
  const finite = (value: number): number => {
    if (!Number.isFinite(value)) throw new Error('结果不是有限数字');
    return value;
  };
  const factor = (depth: number): number => {
    if (depth > 32) throw new Error('括号嵌套过深');
    spaces();
    const char = expression[cursor];
    if (char === '+' || char === '-') {
      cursor += 1;
      const value = factor(depth + 1);
      return char === '-' ? -value : value;
    }
    if (char === '(') {
      cursor += 1;
      const value = sum(depth + 1);
      spaces();
      if (expression[cursor] !== ')') throw new Error('括号未闭合');
      cursor += 1;
      return value;
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(cursor));
    if (match === null) throw new Error('表达式包含非法字符');
    cursor += match[0].length;
    return finite(Number(match[0]));
  };
  const product = (depth: number): number => {
    let value = factor(depth);
    for (;;) {
      spaces();
      const operator = expression[cursor];
      if (operator !== '*' && operator !== '/') return value;
      cursor += 1;
      const right = factor(depth);
      if (operator === '/' && right === 0) throw new Error('不能除以零');
      value = finite(operator === '*' ? value * right : value / right);
    }
  };
  const sum = (depth: number): number => {
    let value = product(depth);
    for (;;) {
      spaces();
      const operator = expression[cursor];
      if (operator !== '+' && operator !== '-') return value;
      cursor += 1;
      const right = product(depth);
      value = finite(operator === '+' ? value + right : value - right);
    }
  };
  const result = sum(0);
  spaces();
  if (cursor !== expression.length) throw new Error('表达式末尾包含非法字符');
  return result;
}

export default basicToolsModule;
