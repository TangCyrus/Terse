import type { IToken } from '@jscpd/core';
import type { Source, SymbolInfo } from './types.js';

export interface ParsedSyntax {
  declarations: { location: SymbolInfo; start: number; end: number }[];
  tokens: IToken[];
  error?: string;
}

export interface SyntaxWriter {
  code: string;
  tokens: IToken[];
  declare(symbol: string, start: number, end: number, headerStart: number, headerEnd: number): void;
  emit(type: string, from: number, to: number): void;
}

export function syntaxReader(format: 'go' | 'python', language: string, analyze: (writer: SyntaxWriter) => number | undefined) {
  const cache = new WeakMap<Source, {file: string; syntax: ParsedSyntax}>();
  return (file: string, source: Source) => {
    const existing = cache.get(source);
    if (existing?.file === file) return existing.syntax;
    const syntax = parse(file, source.content);
    cache.set(source, {file, syntax});
    return syntax;
  };

  function parse(file: string, code: string): ParsedSyntax {
    const lineStarts = [0, ...Array.from(code.matchAll(/\r\n?|\n/g), match => match.index + match[0].length)];
    const position = (offset: number) => {
      let line = 0, end = lineStarts.length;
      while (line + 1 < end) {
        const middle = (line + end) >>> 1;
        if (lineStarts[middle] <= offset) line = middle;
        else end = middle;
      }
      return {line: line + 1, column: offset - lineStarts[line] + 1};
    };
    const declarations: ParsedSyntax['declarations'] = [];
    const tokens: IToken[] = [];
    const errorAt = analyze({code, tokens, declare(symbol, start, end, headerStart, headerEnd) {
      const text = code.slice(start, end).trimEnd();
      end = start + text.length;
      declarations.push({start, end, location: {path: file, symbol, line: position(start).line,
        endLine: position(end).line, signature: code.slice(headerStart, headerEnd).trim(), text}});
    }, emit(type, from, to) {
      const index = tokens.length;
      tokens.push({type: `${type}:`, value: code.slice(from, to), length: to - from, format,
        range: [from, to], loc: {start: {...position(from), position: index}, end: {...position(to), position: index}}});
    }});
    if (errorAt !== undefined) {
      const {line, column} = position(errorAt);
      return {declarations: [], tokens: [], error: `${file}:${line}:${column}: ${language} syntax could not be parsed`};
    }
    return {declarations, tokens};
  }
}
