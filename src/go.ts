import fs from 'node:fs';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { syntaxReader } from './syntax.js';

await Parser.init();
const language = await Language.load(fs.readFileSync(new URL(import.meta.resolve('tree-sitter-go/tree-sitter-go.wasm'))));
const parser = new Parser();
parser.setLanguage(language);

const packageSpecs = new Set(['type_spec', 'type_alias', 'var_spec', 'const_spec']);
const packageGroups = new Set(['type_declaration', 'const_declaration', 'var_declaration', 'var_spec_list']);
const lists = new Set(['source_file', 'statement_list', 'field_declaration_list', 'interface_type',
  'type_declaration', 'const_declaration', 'import_spec_list', 'var_spec_list']);
const literals = new Set(['interpreted_string_literal', 'raw_string_literal', 'rune_literal']);

function receiverType(node: Node | null): Node | null {
  if (node?.type === 'type_identifier') return node;
  if (node?.type === 'generic_type') return node.childForFieldName('type');
  if (node?.type === 'pointer_type') return receiverType(node.firstNamedChild);
  return null;
}

function syntaxError(node: Node): number {
  if (node.isError || node.isMissing) return node.startIndex;
  const child = node.children.find(item => item.hasError || item.isMissing);
  return child ? syntaxError(child) : node.startIndex;
}

export const goSyntax = syntaxReader('go', 'Go', ({code, tokens, declare, emit}) => {
  const tree = parser.parse(code);
  if (!tree) return 0;
  try {
    const root = tree.rootNode;
    if (root.hasError) return syntaxError(root);
    const first = root.namedChildren.find(node => node.type !== 'comment');
    if (first?.type !== 'package_clause') return first?.startIndex ?? 0;

    const text = (node: Node) => code.slice(node.startIndex, node.endIndex);
    const visit = (node: Node, parent?: string, topLevel = false): void => {
      const kind = node.type;
      if (kind === 'comment') return;
      const inList = parent !== undefined && lists.has(parent);
      // Statement lists also accept an implicit newline separator. Keep the
      // significant semicolons in if/for/switch headers as separate tokens.
      if (inList && kind === ';') return;
      const firstToken = tokens.length;
      if (parent === 'source_file' && (kind === 'function_declaration' || kind === 'method_declaration')) {
        const name = node.childForFieldName('name');
        const receiver = node.childForFieldName('receiver');
        const owner = receiverType(receiver?.firstNamedChild?.childForFieldName('type') ?? null);
        if (name && text(name) !== '_' && (!receiver || owner)) declare(owner ? `${text(owner)}.${text(name)}` : text(name), node.startIndex,
          node.endIndex, node.startIndex, node.childForFieldName('body')?.startIndex ?? node.endIndex);
      } else if (topLevel && packageSpecs.has(kind)) {
        for (const name of node.childrenForFieldName('name')) {
          if (text(name) !== '_') declare(text(name), node.startIndex, node.endIndex, node.startIndex, node.endIndex);
        }
      }
      if (literals.has(kind) || !node.childCount) {
        if (node.startIndex < node.endIndex && text(node).trim()) emit(kind, node.startIndex, node.endIndex);
      } else {
        const declarations = kind === 'source_file' || topLevel && packageGroups.has(kind);
        for (const child of node.children) visit(child, kind, declarations);
      }
      if (inList && node.isNamed && tokens.length > firstToken) tokens[firstToken].type = `statement:${tokens[firstToken].type}`;
    };
    visit(root);
  } finally {
    tree.delete();
  }
});
