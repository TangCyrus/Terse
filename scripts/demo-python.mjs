import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createWorkspace, invoke, repository} from './lib/workspace.mjs';

const cache = path.join(repository, '.terse');
fs.mkdirSync(cache, {recursive: true});
const output = fs.mkdtempSync(path.join(cache, 'demo-python-'));
const command = process.env.TERSE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const verification = {command, args: ['-B', '-m', 'unittest', '-v', 'test_receipts']};
const results = ['copy', 'reuse'].map(variant => {
  const project = createWorkspace(output, variant, repository, 'python');
  invoke(project, ['init', '--verify', JSON.stringify(verification)]);
  const task = invoke(project, ['begin', '--task', 'Export a receipt for paid entries only', '--query', 'format_receipt ReceiptTests']);
  const editor = task.context.candidates.find(candidate => candidate.symbol === 'format_receipt');
  assert(editor && task.context.candidates.some(candidate => candidate.symbol === 'ReceiptTests'));
  invoke(project, ['decide', '--run', task.run, '--strategy', variant === 'copy' ? 'new' : 'modify',
    '--candidate', editor.candidateId, '--rationale', variant === 'copy' ? 'Controlled duplicate implementation' : 'Reuse the existing receipt formatter']);

  const source = path.join(project, 'receipts.py');
  const original = fs.readFileSync(source, 'utf8').replaceAll('\r\n', '\n');
  const filtered = "\n\ndef export_paid_receipt(entries):\n    entries = [entry for entry in entries if entry['paid']]\n";
  fs.writeFileSync(source, original + filtered + (variant === 'copy' ? original.slice(original.indexOf('\n') + 1) : '    return format_receipt(entries)\n'));
  const report = invoke(project, ['check', '--run', task.run, '--summary'], variant === 'copy' ? 2 : 0);
  assert.equal(report.verification[0]?.status, 'passed');
  assert(variant === 'copy' ? report.newDuplications > 0 : report.newDuplications === 0);
  return {variant, status: report.status, newDuplications: report.newDuplications,
    verification: report.verification[0].status, report: report.reportPath};
});
const comparison = path.join(output, 'comparison.json');
fs.writeFileSync(comparison, JSON.stringify({results}, null, 2) + '\n');
console.log(JSON.stringify({results, comparison}, null, 2));
