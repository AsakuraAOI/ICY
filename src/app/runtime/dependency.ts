/**
 * 模块依赖图：missing dependency / cycle / 拓扑排序。
 *
 * 三条硬规则：
 *
 * 1. requires 是硬依赖：模块缺失直接让 Application 启动失败。降级跳过只会让
 *    用户在很久以后收到一个「某个功能莫名不工作」的现象，而日志里什么都没写。
 * 2. optional 不是硬依赖：存在就排在前面（存在则可用），不存在不影响启动。
 * 3. 环必须报出来，并且报成一条能看懂的路径。只说「有环」等于没说。
 *
 * 排出的顺序是「依赖 → 被依赖者」：setup / start 顺着走，stop 逆着走。
 * 顺序完全由这个函数决定，不依赖 Map 的迭代顺序或对象键顺序 ——
 * 后者在不同 Node 版本、不同注册路径下都可能变，启动顺序不能建在这上面。
 *
 * v0 不做 semver 求解：这里只有模块名，没有版本区间。
 */

export interface DependencyNode {
  readonly name: string;
  /** 必须存在的模块。 */
  readonly requires: readonly string[];
  /** 存在则可用的模块。缺失不报错，存在则参与排序。 */
  readonly optional: readonly string[];
}

export interface MissingDependency {
  readonly code: 'missing_dependency';
  readonly module: string;
  readonly dependency: string;
}

export interface DependencyCycle {
  readonly code: 'cycle';
  /** 环上的模块名，首尾同名，例如 [A, B, C, A]。 */
  readonly path: readonly string[];
}

/** 同名模块。正常路径由 ModuleManager 先挡，这里是依赖图自身的防御性检查。 */
export interface DuplicateModule {
  readonly code: 'duplicate_module';
  readonly module: string;
}

export type DependencyIssue = MissingDependency | DependencyCycle | DuplicateModule;

export class DependencyError extends Error {
  readonly code: DependencyIssue['code'];
  readonly issues: readonly DependencyIssue[];

  constructor(issues: readonly DependencyIssue[]) {
    super(describeIssues(issues));
    this.name = 'DependencyError';
    this.issues = issues;
    // 环的 path 单独留一份，测试与调用方不需要再去 issues 里翻。
    const first = issues[0];
    this.code = first?.code ?? 'missing_dependency';
  }

  /** 环路径；不是环错误时为 []。 */
  get cyclePath(): readonly string[] {
    for (const issue of this.issues) {
      if (issue.code === 'cycle') return issue.path;
    }
    return [];
  }
}

export interface DependencyGraph {
  /** 拓扑序：依赖在前，依赖它的模块在后。 */
  readonly order: readonly string[];
  /**
   * 每个模块「实际存在的 optional 依赖」，按声明顺序。
   * 模块可以用它判断某个可选能力是否可用；不存在的不在表里。
   */
  readonly optionalDependencies: ReadonlyMap<string, readonly string[]>;
}

export function buildDependencyGraph(nodes: readonly DependencyNode[]): DependencyGraph {
  const byName = new Map<string, DependencyNode>();
  for (const node of nodes) {
    // 重名由 ModuleManager（loader.ts）在注册阶段拒绝；这里再挡一次，
    // 因为「同名节点」会让下面的图直接变成不确定的。
    if (byName.has(node.name)) {
      throw new DependencyError([{ code: 'duplicate_module', module: node.name }]);
    }
    byName.set(node.name, node);
  }

  const missing: MissingDependency[] = [];
  const optionalDependencies = new Map<string, readonly string[]>();
  for (const node of nodes) {
    for (const dependency of node.requires) {
      if (!byName.has(dependency)) {
        missing.push({ code: 'missing_dependency', module: node.name, dependency });
      }
    }
    optionalDependencies.set(
      node.name,
      node.optional.filter((dependency) => byName.has(dependency)),
    );
  }
  if (missing.length > 0) throw new DependencyError(missing);

  const edgesOf = (node: DependencyNode): readonly string[] => [
    ...node.requires,
    ...(optionalDependencies.get(node.name) ?? []),
  ];

  const done = new Set<string>();
  const stack: string[] = [];
  const order: string[] = [];

  const visit = (name: string): void => {
    if (done.has(name)) return;
    const at = stack.indexOf(name);
    if (at >= 0) {
      throw new DependencyError([{ code: 'cycle', path: [...stack.slice(at), name] }]);
    }

    const node = byName.get(name);
    if (node === undefined) return; // 只可能是 requires 校验漏掉的边，防御性返回。

    stack.push(name);
    for (const dependency of edgesOf(node)) visit(dependency);
    stack.pop();
    done.add(name);
    order.push(name);
  };

  for (const node of nodes) visit(node.name);

  return { order, optionalDependencies };
}

function describeIssues(issues: readonly DependencyIssue[]): string {
  const lines = issues.map((issue) => {
    if (issue.code === 'missing_dependency') {
      return `module "${issue.module}" requires missing module "${issue.dependency}"`;
    }
    if (issue.code === 'duplicate_module') {
      return `module "${issue.module}" 被注册了多次`;
    }
    return `模块依赖出现环：${issue.path.join(' → ')}`;
  });
  return `模块依赖校验失败：\n  - ${lines.join('\n  - ')}`;
}