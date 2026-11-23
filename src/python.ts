import type { IToken } from '@jscpd/core';
import { parser } from '@lezer/python';
import type { Source, SymbolInfo } from './types.js';

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];
interface PythonSyntax {
  declarations: { location: SymbolInfo; start: number; end: number }[];
  tokens: IToken[];
  error?: string;
}

const cache = new WeakMap<Source, {file: string; syntax: PythonSyntax}>();
const literals = new Set(['String', 'FormatString']);

export function pythonSyntax(file: string, source: Source): PythonSyntax {
  const existing = cache.get(source);
  if (existing?.file === file) return existing.syntax;
  const syntax = parsePython(file, source.content);
  cache.set(source, {file, syntax});
  return syntax;
}

function parsePython(file: string, code: string): PythonSyntax {
  const tree = parser.parse(code);
  const lineStarts = [0, ...Array.from(code.matchAll(/\r\n?|\n/g), match => match.index + match[0].length)];
  const position = (offset: number) => {
    let line = 0, end = lineStarts.length;
    while (line + 1 < end) {
      const middle = (line + end) >>> 1;
      if (lineStarts[middle] <= offset) line = middle;
      else end = middle;
    }
    return { line: line + 1, column: offset - lineStarts[line] + 1 };
  };
  const declarations: PythonSyntax['declarations'] = [];
  const tokens: IToken[] = [];
  let errorAt: number | undefined;
  tree.iterate({ enter(node) { if (node.type.isError) errorAt ??= node.from; } });
  if (errorAt !== undefined) {
    const {line, column} = position(errorAt);
    return {declarations, tokens, error: `${file}:${line}:${column}: Python syntax could not be parsed`};
  }

  const emit = (type: string, from: number, to: number) => {
    const index = tokens.length;
    tokens.push({type: `${type}:`, value: code.slice(from, to), length: to - from, format: 'python',
      range: [from, to], loc: {start: {...position(from), position: index}, end: {...position(to), position: index}}});
  };
  // The tree omits some punctuation, such as commas and return arrows. Preserve
  // it in lexical order. Ignore layout trivia and explicit line continuations.
  const gap = (from: number, to: number) => {
    for (const match of code.slice(from, to).matchAll(/\\\r?\n|[^\s\\]+|\\/g)) {
      if (/^\\\r?\n$/.test(match[0])) continue;
      emit('punctuation', from + match.index, from + match.index + match[0].length);
    }
  };
  const visit = (node: SyntaxNode, scope: string): void => {
    const kind = node.name;
    if (kind === 'Comment') return;
    const firstToken = tokens.length;
    if (kind === 'FunctionDefinition' || kind === 'ClassDefinition') {
      const name = node.getChild('VariableName');
      const body = node.getChild('Body');
      if (name && body) {
        scope = `${scope ? `${scope}.` : ''}${code.slice(name.from, name.to)}`;
        const start = node.parent?.name === 'DecoratedStatement' ? node.parent.from : node.from;
        const text = code.slice(start, node.to).trimEnd();
        const end = start + text.length;
        declarations.push({start, end, location: {path: file, symbol: scope, line: position(start).line,
          endLine: position(end).line, signature: code.slice(node.from, body.from).trim(), text}});
      }
    }
    if (literals.has(kind) || !node.firstChild) {
      if (node.from < node.to && code.slice(node.from, node.to).trim()) emit(kind, node.from, node.to);
    } else {
      let offset = node.from;
      for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling) {
        gap(offset, child.from);
        visit(child, scope);
        offset = child.to;
      }
      gap(offset, node.to);
    }
    if (tokens.length > firstToken) {
      // Attach boundaries to real tokens so minTokens still counts source tokens.
      if (kind === 'Body') {
        tokens[firstToken].type = `suite:${tokens[firstToken].type}`;
        tokens.at(-1)!.type = `end-suite:${tokens.at(-1)!.type}`;
      }
      if (/(?:Statement|Definition)$/.test(kind)) tokens[firstToken].type = `statement:${tokens[firstToken].type}`;
    }
  };
  visit(tree.topNode, '');
  return {declarations, tokens};
}
