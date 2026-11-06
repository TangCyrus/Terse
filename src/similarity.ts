import ts from 'typescript';
import { digest } from './project.js';
import type { Finding, Location, SimilarityEvidence } from './types.js';

export const SIMILARITY_ALGORITHM = 'implementation-anchors/1';
export interface Implementation extends Location {
  bodyHash: string;
  anchors: { literals: string[]; members: string[]; calls: string[] };
}
const genericMembers = new Set(['length', 'size']);
const genericCalls = new Set(['map', 'filter', 'forEach', 'reduce', 'join', 'push', 'slice', 'then', 'catch']);
const printer = ts.createPrinter({removeComments: true, newLine: ts.NewLineKind.LineFeed});

// Use the existing parser's function bodies. Control flow and local variable names are
// deliberately absent from the anchors, but the evidence does not prove equivalence.
export function implementation(body: ts.Node, ast: ts.SourceFile, location: Location): Implementation | undefined {
  if (!ts.isBlock(body) || body.statements.length < 4) return;
  const literals = new Set<string>(), members = new Set<string>(), calls = new Set<string>();
  const member = (node: ts.Node): string | undefined => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  function visit(node: ts.Node) {
    // Diagnostics and type annotations do not establish a shared implementation.
    if (ts.isThrowStatement(node) || ts.isTypeNode(node)) return;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
      || ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent))) return;
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console') return;
      const name = member(node.expression);
      if (name && !genericCalls.has(name)) calls.add(name);
    }
    const name = member(node);
    if (name && !genericMembers.has(name) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) members.add(name);
    if (ts.isStringLiteralLike(node) && node.text.length >= 6 && node.text.length <= 120
      && !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)) literals.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(body);
  if (!literals.size || members.size < 3 || calls.size < 2 || literals.size + members.size + calls.size < 8) return;
  const {path, symbol, line, endLine} = location;
  return {path, symbol, line, endLine, bodyHash: digest(printer.printNode(ts.EmitHint.Unspecified, body, ast)),
    anchors: {literals: [...literals].sort(), members: [...members].sort(), calls: [...calls].sort()}};
}

function comparison(left: Implementation, right: Implementation): SimilarityEvidence | undefined {
  const common = (left: string[], right: string[]) => {
    const lookup = new Set(right);
    return left.filter(value => lookup.has(value));
  };
  const shared = {literals: common(left.anchors.literals, right.anchors.literals),
    members: common(left.anchors.members, right.anchors.members), calls: common(left.anchors.calls, right.anchors.calls)};
  const size = (item: Implementation) => Object.values(item.anchors).reduce((sum, values) => sum + values.length, 0);
  const sharedAnchors = Object.values(shared).reduce((sum, values) => sum + values.length, 0);
  if (!shared.literals.length || shared.members.length < 3 || shared.calls.length < 2 || sharedAnchors < 8
    || sharedAnchors / Math.min(size(left), size(right)) < 0.65) return;
  return {algorithm: SIMILARITY_ALGORITHM, shared, sharedAnchors, leftAnchors: size(left), rightAnchors: size(right), evidenceTruncated: false};
}

export function similarImplementations(before: Implementation[], after: Implementation[], exact: Finding[]): Finding[] {
  // One-to-one matching preserves moves and historical pairs without letting one
  // baseline implementation justify arbitrarily many new copies.
  const matches = new Map<number, number>(), used = new Set<number>();
  const identity = (item: Implementation) => JSON.stringify([item.path, item.symbol]);
  const previous = new Map<string, number[]>();
  before.forEach((item, index) => {
    const key = identity(item), indices = previous.get(key) ?? [];
    indices.push(index); previous.set(key, indices);
  });
  const identities = new Map<string, number>();
  after.forEach(item => identities.set(identity(item), (identities.get(identity(item)) ?? 0) + 1));
  after.forEach((item, index) => {
    const candidates = previous.get(identity(item));
    if (candidates?.length === 1 && identities.get(identity(item)) === 1) {
      matches.set(index, candidates[0]); used.add(candidates[0]);
    }
  });
  const bodies = new Map<string, number[]>();
  before.forEach((item, index) => {
    if (used.has(index)) return;
    const indices = bodies.get(item.bodyHash) ?? [];
    indices.push(index); bodies.set(item.bodyHash, indices);
  });
  after.forEach((item, index) => {
    if (matches.has(index)) return;
    const previous = bodies.get(item.bodyHash)?.pop();
    if (previous !== undefined) matches.set(index, previous);
  });
  const literals = new Map<string, number[]>();
  after.forEach((item, index) => item.anchors.literals.forEach(value => {
    const indices = literals.get(value) ?? [];
    indices.push(index); literals.set(value, indices);
  }));
  const findings: Finding[] = [];
  after.forEach((left, i) => {
    const candidates = new Set(left.anchors.literals.flatMap(value => literals.get(value) ?? []).filter(j => j > i));
    for (const j of [...candidates].sort((a, b) => a - b)) {
      const right = after[j], similarity = comparison(left, right);
      if (!similarity) continue;
      const oldLeft = matches.get(i), oldRight = matches.get(j);
      const historical = oldLeft !== undefined && oldRight !== undefined ? comparison(before[oldLeft], before[oldRight]) : undefined;
      if (historical && (['literals', 'members', 'calls'] as const).every(kind => similarity.shared[kind].every(value => historical.shared[kind].includes(value)))) continue;
      const overlaps = (item: Implementation, location: Finding['locations'][number]) => item.path === location.path
        && location.line !== undefined && location.endLine !== undefined && location.line <= item.endLine && location.endLine >= item.line;
      if (exact.some(finding => finding.rule === 'NEW_DUPLICATION' && finding.locations.some((location, a) => overlaps(left, location)
        && finding.locations.some((other, b) => a !== b && overlaps(right, other))))) continue;
      const locate = ({path, symbol, line, endLine}: Implementation) => ({path, symbol, line, endLine});
      const evidence = {...similarity, evidenceTruncated: Object.values(similarity.shared).some(values => values.length > 20),
        shared: {literals: similarity.shared.literals.slice(0, 20), members: similarity.shared.members.slice(0, 20), calls: similarity.shared.calls.slice(0, 20)}};
      findings.push({rule: 'POSSIBLE_DUPLICATION', severity: 'review', similarity: evidence, locations: [locate(left), locate(right)],
        message: 'These implementations newly share literal, data-member and operation anchors. Review responsibility overlap and reuse; distinct behavior or authorization may justify both. Similarity is not proof of equivalence.'});
    }
  });
  return findings;
}
