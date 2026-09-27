import type { HumanizeConfig } from './config.js';
import type { OutputSource } from './contracts.js';

/** 仅改变可确认是自然语言的末尾标点，保留原始换行和空白。 */
export function humanizeText(text: string, config: HumanizeConfig, source: OutputSource = 'agent'): string {
  if (!config.enabled || !config.stripTerminalPunctuation ||
    (source === 'command' && !config.includeCommands)) return text;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return text; } catch { /* 普通文字不是完整 JSON。 */ }
  }
  if (/^<[\s\S]*>$/.test(trimmed)) return text;

  const parts = text.split(/(\r\n|\n|\r)/);
  let last = parts.length - 1;
  while (last >= 0 && !parts[last]?.trim()) last -= 2;
  let fence: { marker: string; length: number } | undefined;
  let math: '$$' | '\\[' | undefined;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!;
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (boundary && boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.length && !boundary[2]!.trim()) fence = undefined;
      continue;
    }
    if (boundary) { fence = { marker: boundary[1]![0]!, length: boundary[1]!.length }; continue; }
    const compact = line.trim();
    if (math) { if (compact === (math === '$$' ? '$$' : '\\]')) math = undefined; continue; }
    if (compact === '$$' || compact === '\\[') { math = compact; continue; }
    if (!config.perLine && i !== last) continue;
    if (protectedLine(line)) continue;
    const ending = /([。！？.!?]+)([ \t]*)$/.exec(line);
    if (!ending || ending[1]!.includes('..')) continue; // 省略号表达语气，保留它。
    const content = line.slice(0, ending.index);
    // 不生成空回复，也不把独立数字/列表标记改成另一种结构。
    if (!content.trim() || /^ {0,3}(?:[-+*]|\d+[.)]|#{1,6})\s*$/.test(content) || /^[+-]?\d+\.$/.test(compact)) continue;
    parts[i] = content + ending[2];
  }
  return parts.join('');
}

function protectedLine(line: string): boolean {
  if (/^(?: {4}|\t| {0,3}>)/.test(line)) return true; // 缩进代码、原文引用。
  if (/[`|$]/.test(line)) return true; // 行内代码、表格、公式保守保留整行。
  if (/^\s*(?:[\[{]|<[A-Za-z/!]|["']?\w[\w.-]*["']?\s*:)/.test(line)) return true;
  const lastToken = line.trimEnd().split(/\s+/).at(-1) ?? '';
  if (/^(?:https?:\/\/|www\.|mailto:)/i.test(lastToken) || /\S+@\S+\.\S+/.test(lastToken)) return true;
  if (/\.(?:json|ya?ml|[cm]?[jt]s|py|sh|md|txt|html|css|csv|zip|png|exe)\.?$/i.test(lastToken)) return true;
  if (/\b(?:e\.g|i\.e|Mr|Mrs|Ms|Dr|Prof|vs|etc)\.$/i.test(line.trimEnd())) return true;
  return false;
}
