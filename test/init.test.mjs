import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWorkspace, invoke, repository} from '../scripts/lib/workspace.mjs';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-init-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-init-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const root = createWorkspace(parent, '项目 with spaces');
  return {parent, root, read: file => fs.readFileSync(path.join(root, file), 'utf8'),
    write: (file, text) => {fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});fs.writeFileSync(path.join(root, file), text);},
    remove: file => fs.unlinkSync(path.join(root, file)),
    exists: file => fs.existsSync(path.join(root, file)), run: (args, code = 0) => invoke(root, args, code)};
}

test('M5 init preserves configuration and existing instructions and is idempotent from a subdirectory', t => {
  const p = workspace(t), originalConfig = p.read('terse.config.json');
  const prefix = '\uFEFF# Team instructions\r\nKeep public behavior.\r\n';
  p.write('AGENTS.md', prefix);
  p.write('.gitignore', 'node_modules/\r\n');
  const first = invoke(path.join(p.root, 'src'), ['init']);
  assert.equal(first.command, 'init');assert.equal(first.verificationConfigured, true);
  assert.equal(first.root, p.root);assert.equal(first.instructionsPath, 'AGENTS.md');
  assert.equal(p.read('terse.config.json'), originalConfig);
  assert(p.read('AGENTS.md').startsWith(prefix));
  assert(p.read('.gitignore').startsWith('node_modules/\r\n'));
  assert.equal(execFileSync('git', ['check-ignore', '--no-index', '.terse/agent.json'], {cwd: p.root, encoding: 'utf8'}).trim(), '.terse/agent.json');
  const bytes = first.files.map(file => [file.path, fs.readFileSync(path.join(p.root, file.path))]);
  const second = p.run(['init']);
  assert(second.files.every(file => ['unchanged', 'preserved'].includes(file.status)));
  for (const [file, content] of bytes) assert.deepEqual(fs.readFileSync(path.join(p.root, file)), content);
  assert.deepEqual(first.setupIssues, []);
  const schema = JSON.parse(fs.readFileSync(path.join(repository, 'docs/cli-output.schema.json'), 'utf8'));
  const branch = schema.allOf.at(-1).then.oneOf.find(item => item.properties.command.const === 'init');
  for (const key of [...schema.required, ...branch.required]) assert(Object.hasOwn(first, key), key);
});

test('M5 init targets active root override instructions without rewriting other guidance', t => {
  const p = workspace(t);
  p.write('AGENTS.md', '# Original guidance\n');
  p.write('AGENTS.override.md', '# Active guidance\n');
  const result = p.run(['init']);
  assert.equal(result.instructionsPath, 'AGENTS.override.md');
  assert.equal(p.read('AGENTS.md'), '# Original guidance\n');
  assert(p.read('AGENTS.override.md').startsWith('# Active guidance\n'));
  assert(p.read('AGENTS.override.md').includes(result.skillPath));
  assert(p.run(['init']).files.every(file => ['unchanged', 'preserved'].includes(file.status)));
});

test('M5 init preserves installed templates across Git line-ending conversion', t => {
  const p = workspace(t), initialized = p.run(['init']);
  const files = initialized.files.filter(file => file.path.startsWith('.agents/'));
  const converted = new Map();
  for (const {path: file} of files) {
    const text = p.read(file), newline = text.includes('\r\n') ? '\n' : '\r\n';
    const changed = text.replace(/\r?\n/g, newline);p.write(file, changed);converted.set(file, changed);
  }
  const again = p.run(['init']);
  for (const [file, contents] of converted) {
    assert.equal(p.read(file), contents);
    assert.equal(again.files.find(item => item.path === file).status, 'unchanged');
  }
});

test('M5 init ignores all task caches when only the CLI binding was previously ignored', t => {
  const p = workspace(t);p.write('.gitignore', '.terse/agent.json\n');
  p.run(['init']);
  assert(p.read('.gitignore').startsWith('.terse/agent.json\n'));
  assert.equal(execFileSync('git', ['check-ignore', '--no-index', '.terse/runs/task/baseline.json'], {cwd: p.root, encoding: 'utf8'}).trim(), '.terse/runs/task/baseline.json');
});

test('M5 init leaves an explicit setup gap when verification is unknown', t => {
  const p = workspace(t);p.remove('terse.config.json');
  const result = p.run(['init'], 2);
  assert.equal(result.verificationConfigured, false);
  assert.equal(result.setupIssues[0].code, 'VERIFICATION_NOT_CONFIGURED');
  assert.deepEqual(JSON.parse(p.read('terse.config.json')).verification, []);
  assert.equal(p.exists('.terse/runs'), false);
  // Even a valid decision cannot turn missing behavior validation into pass.
  const begun = p.run(['begin', '--task', 'Keep export behavior', '--query', 'exportOrders']);
  const candidate = begun.context.candidates.find(item => item.symbol === 'exportOrders');
  p.run(['decide', '--run', begun.run, '--strategy', 'reuse', '--candidate', candidate.candidateId, '--rationale', 'Existing exporter fits.']);
  const checked = p.run(['check', '--run', begun.run], 2);
  assert(checked.findings.some(item => item.rule === 'VERIFICATION_MISSING'));
});

test('M5 init accepts multiple real commands without executing them and preserves the full verification set', t => {
  const p = workspace(t);p.remove('terse.config.json');
  const tests = {command: 'node', args: ['--test', 'test/orders.test.mjs']};
  const syntax = {command: 'node', args: ['--check', 'src/orders.ts']};
  const configured = p.run(['init', '--verify', JSON.stringify(tests), '--verify', JSON.stringify(syntax)]);
  assert.equal(configured.verificationConfigured, true);assert.equal(p.exists('.terse/runs'), false);
  const begun = p.run(['begin', '--task', 'Preserve export behavior', '--query', 'exportOrders']);
  const candidate = begun.context.candidates.find(item => item.symbol === 'exportOrders');
  p.run(['decide', '--run', begun.run, '--strategy', 'reuse', '--candidate', candidate.candidateId, '--rationale', 'No parallel exporter needed.']);
  const checked = p.run(begun.verificationGuide.argvTemplate);
  assert.equal(checked.verification.length, 2);
  assert(checked.verification.every(item => item.status === 'passed'));
  assert.deepEqual(checked.verification.map(item => item.command.args), [tests.args, syntax.args]);
  assert.equal(p.run(['init', '--verify', JSON.stringify(tests)], 3).outputKind, 'error');
  assert.equal(JSON.parse(p.read('terse.config.json')).verification.length, 2);
});

test('M5 init validates commands before writing project files', async t => {
  for (const value of ['{bad', 'null', '{"command":"node"}', '{"command":"node","args":[],"timeoutMs":1}']) {
    await t.test(value, t => {
      const p = workspace(t);p.remove('terse.config.json');
      const ignore = p.read('.gitignore');
      const result = p.run(['init', '--verify', value], 3);
      assert.equal(result.outputKind, 'error');
      assert.equal(p.exists('terse.config.json'), false);assert.equal(p.exists('AGENTS.md'), false);
      assert.equal(p.exists('.agents'), false);assert.equal(p.read('.gitignore'), ignore);
    });
  }
});

test('M5 init preflight preserves custom skills, invalid configs and edited managed instructions', async t => {
  for (const file of ['.agents/skills/terse/SKILL.md', 'terse.config.json', 'AGENTS.md']) await t.test(file, t => {
    const p = workspace(t);
    const contents = file === 'terse.config.json' ? '{bad' : file === 'AGENTS.md' ? '<!-- terse:begin -->\nLocal edits\n<!-- terse:end -->\n' : 'Custom skill\n';
    p.write(file, contents);
    const ignore = p.read('.gitignore');
    const result = p.run(['init'], 3);
    assert.equal(result.outputKind, 'error');
    assert.equal(p.read(file), contents);assert.equal(p.read('.gitignore'), ignore);
    assert.equal(p.exists('.terse/agent.json'), false);
    assert.equal(p.exists('.agents/skills/terse/scripts/run.mjs'), false);
  });
});

test('M5 init refuses directory junctions before writing outside the project', t => {
  const p = workspace(t), outside = path.join(p.parent, 'outside');
  fs.mkdirSync(outside);fs.writeFileSync(path.join(outside, 'keep'), 'original');
  fs.symlinkSync(outside, path.join(p.root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = p.run(['init'], 3);
  assert.equal(result.outputKind, 'error');
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  assert.equal(p.exists('AGENTS.md'), false);assert.equal(p.exists('.terse/agent.json'), false);
});

test('M5 installed launcher works from unrelated cwd, forwards failure, and supports restoring a missing binding', t => {
  const p = workspace(t), initialized = p.run(['init']);
  const launcher = path.join(p.root, initialized.runnerArgv[1]);
  const env = {...process.env};delete env.NODE_TEST_CONTEXT;
  const execute = args => spawnSync(process.execPath, [launcher, ...args], {cwd: p.parent, env, encoding: 'utf8', timeout: 30_000});
  const begunProcess = execute(['begin', '--task', 'Fix export while preserving behavior', '--query', 'exportOrders', '--json']);
  assert.equal(begunProcess.status, 0, begunProcess.stdout + begunProcess.stderr);
  const begun = JSON.parse(begunProcess.stdout);assert.equal(begun.root, p.root);
  const candidate = begun.context.candidates.find(item => item.symbol === 'exportOrders');
  invoke(p.root, ['decide', '--run', begun.run, '--strategy', 'modify', '--candidate', candidate.candidateId, '--rationale', 'Keep existing export rules.'], 0, launcher);
  p.write('src/orders.ts', p.read('src/orders.ts').replace('toFixed(2)', 'toFixed(0)'));
  const failed = invoke(p.root, begun.verificationGuide.argvTemplate, 1, launcher);
  assert(failed.findings.some(item => item.rule === 'VERIFICATION_FAILED'));
  assert.equal(failed.verification[0].status, 'failed');
  const invalid = execute(['begin', '--json']);assert.equal(invalid.status, 3);
  assert.equal(JSON.parse(invalid.stdout).diagnostics[0].code, 'INVALID_ARGUMENT');
  p.remove('.terse/agent.json');
  const missing = execute(['--version', '--json']);assert.equal(missing.status, 3);
  assert.equal(missing.stdout, '');assert.match(missing.stderr, /init --cwd/);
  p.run(['init']);assert.equal(execute(['--version', '--json']).status, 0);
});

test('M5 installed integration completes retrieval, decision, duplicate feedback and correction on one baseline', () => {
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/demo-agent.mjs', import.meta.url))], {encoding: 'utf8', timeout: 60_000}));
  assert.equal(result.mode, 'scripted-integration');assert.equal(result.modelSessions, 0);
  assert.equal(result.candidate.symbol, 'exportOrders');assert.equal(result.sameBaseline, true);
  assert.equal(result.draft.status, 'needs-review');assert.equal(result.draft.newDuplications, 1);
  assert.equal(result.final.status, 'pass');assert.equal(result.final.newDuplications, 0);
  assert.deepEqual(result.draft.verification, ['passed']);assert.deepEqual(result.final.verification, ['passed']);
  for (const report of [result.draft.report, result.final.report]) assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).run, result.run);
});
