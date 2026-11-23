import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createWorkspace, invoke, repository} from './workspace.mjs';

export function runReuseDemo({example, file, verification, symbols, implement}) {
  const cache = path.join(repository, '.terse');
  fs.mkdirSync(cache, {recursive: true});
  const output = fs.mkdtempSync(path.join(cache, `demo-${example}-`));
  const results = ['copy', 'reuse'].map(variant => {
    const project = createWorkspace(output, variant, repository, example);
    invoke(project, ['init', '--verify', JSON.stringify(verification)]);
    const task = invoke(project, ['begin', '--task', 'Export a receipt for paid entries only', '--query', symbols.join(' ')]);
    for (const symbol of symbols) assert(task.context.candidates.some(candidate => candidate.symbol === symbol), `Missing candidate ${symbol}`);
    const editor = task.context.candidates.find(candidate => candidate.symbol === symbols[0] && candidate.path === file);
    assert(editor);
    invoke(project, ['decide', '--run', task.run, '--strategy', variant === 'copy' ? 'new' : 'modify',
      '--candidate', editor.candidateId, '--rationale', variant === 'copy' ? 'Controlled duplicate implementation' : 'Reuse the existing receipt formatter']);

    const source = path.join(project, file);
    const original = fs.readFileSync(source, 'utf8').replaceAll('\r\n', '\n');
    fs.writeFileSync(source, implement(original, variant));
    const report = invoke(project, ['check', '--run', task.run, '--summary'], variant === 'copy' ? 2 : 0);
    assert.equal(report.verification[0]?.status, 'passed');
    assert(variant === 'copy' ? report.newDuplications > 0 : report.newDuplications === 0);
    return {variant, status: report.status, newDuplications: report.newDuplications,
      verification: report.verification[0].status, report: report.reportPath};
  });
  const comparison = path.join(output, 'comparison.json');
  fs.writeFileSync(comparison, JSON.stringify({results}, null, 2) + '\n');
  console.log(JSON.stringify({results, comparison}, null, 2));
}
