import { parser } from '@lezer/python';
import { syntaxReader } from './syntax.js';

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];
const literals = new Set(['String', 'FormatString']);

export const pythonSyntax = syntaxReader('python', 'Python', ({code, tokens, declare, emit}) => {
  const tree = parser.parse(code);
  let errorAt: number | undefined;
  tree.iterate({enter(node) { if (node.type.isError) errorAt ??= node.from; }});
  if (errorAt !== undefined) return errorAt;
  // The tree omits some punctuation, such as commas and return arrows.
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
        declare(scope, start, node.to, node.from, body.from);
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
});
