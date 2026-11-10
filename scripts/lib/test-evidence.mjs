import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Register identities without importing candidate code. The current acceptance
// fixtures use literal, top-level node:test calls; dynamic suites need an explicit
// manifest extension rather than silently falling back to a numeric test count.
export function freezeTestCases(project, args) {
  const testIndex = args.indexOf('--test');
  assert(testIndex >= 0 && args.length > testIndex + 1, 'Explicit Node test files are required');
  return args.slice(testIndex + 1).flatMap(file => {
    assert(!file.startsWith('-') && !/[*?]/.test(file), 'Acceptance requires explicit test files');
    const absolute = path.resolve(project, file);
    const source = ts.createSourceFile(absolute, fs.readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
    assert.equal(source.parseDiagnostics.length, 0, `Invalid acceptance syntax: ${file}`);
    const bindings = new Set();
    for (const node of source.statements) if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'node:test') {
      if (node.importClause?.name) bindings.add(node.importClause.name.text);
      for (const binding of node.importClause?.namedBindings?.elements ?? []) {
        if ((binding.propertyName ?? binding.name).text === 'test') bindings.add(binding.name.text);
      }
    }
    const cases = source.statements.flatMap(node => {
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return [];
      const call = node.expression, callee = call.expression;
      const binding = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
      if (!ts.isIdentifier(binding) || !bindings.has(binding.text)) return [];
      assert(ts.isStringLiteralLike(call.arguments[0]), `Acceptance needs literal test names: ${file}`);
      const position = source.getLineAndCharacterOfPosition(call.getStart(source));
      return [{file: absolute, name: call.arguments[0].text, line: position.line + 1, column: position.character + 1}];
    });
    assert(cases.length > 0, `No registered acceptance identities: ${file}`);
    return cases;
  });
}

export function testArguments(args, expectedCases) {
  if (!args.includes('--test')) {
    assert(!expectedCases, 'Test identities require --test');
    return args;
  }
  assert(expectedCases?.length > 0, 'Node acceptance requires frozen test identities');
  assert(!args.some(arg => arg.startsWith('--test-reporter') || arg.startsWith('--test-isolation') || arg.startsWith('--experimental-test-isolation')), 'Acceptance must retain isolated host reporting');
  return ['--test-reporter=' + new URL('./test-reporter.mjs', import.meta.url).href, ...args];
}

const identity = ({file, name, line, column}) => JSON.stringify([path.resolve(file), name, line, column]);

export function testEvidence(output, expectedCases) {
  try {
    const events = output.trim().split('\n').map(line => JSON.parse(line));
    const completed = events.at(-1)?.type === 'terse:reporter-complete';
    const summaries = events.filter(event => event.type === 'test:summary');
    const total = summaries.find(event => !event.data.file)?.data;
    const cases = events.filter(event => ['test:pass', 'test:fail'].includes(event.type));
    const expected = expectedCases.map(identity), actual = cases.map(event => identity(event.data));
    const missing = expectedCases.filter(item => actual.filter(key => key === identity(item)).length !== 1).map(item => item.name);
    const unexpected = cases.filter(event => !expected.includes(identity(event.data)))
      .map(event => event.data.entryFile ? event.data.name : `file:${path.basename(event.data.file)}`);
    const clean = data => data?.success === true && data.counts.failed === 0 && data.counts.cancelled === 0 && data.counts.skipped === 0 && data.counts.todo === 0;
    const fileSummaries = [...new Set(expectedCases.map(item => item.file))].every(file => {
      const matches = summaries.filter(event => event.data.file && path.resolve(event.data.file) === file);
      return matches.length === 1 && clean(matches[0].data);
    });
    return {passed: completed && clean(total) && fileSummaries && total.counts.tests === expected.length && total.counts.passed === expected.length
      && missing.length === 0 && unexpected.length === 0 && cases.every(event => event.type === 'test:pass' && !event.data.skip && !event.data.todo),
      completed, expected: expected.length, observed: cases.length, missing, unexpected, counts: total?.counts ?? null};
  } catch (error) {
    return {passed: false, completed: false, error: error.message};
  }
}
