import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {repository} from './workspace.mjs';
import {hash, hashFiles} from './skill-evidence.mjs';
import {showConfiguration, flattenConfiguration, verifyCommand} from './benchmark-project.mjs';
import {prepareOpenSourceProject} from './open-source-project.mjs';

export const pqueueFixture = path.join(repository, 'benchmarks/p-queue');
export const pqueueSpecification = JSON.parse(fs.readFileSync(path.join(pqueueFixture, 'project.json'), 'utf8'));
export const pqueueCases = pqueueSpecification.tasks.map(task => {
  const requirement = fs.readFileSync(path.join(pqueueFixture, task.taskFile), 'utf8').split(/\r?\n\r?\nOnly edit /)[0].trim();
  return {...task, prompt: `${requirement}\n\nOnly edit ${task.editable.join(', ')}. Preserve tests, dependencies and configuration. You may read the acceptance/ files. Do not commit or push. Explain the changes and validation results.`};
});
export const pqueueFixtureFiles = ['project.json', 'support.mjs', 'LICENSE', ...pqueueSpecification.tasks.flatMap(task => [task.taskFile, task.acceptance, task.typeAcceptance])]
  .map(file => `benchmarks/p-queue/${file}`);

export function pqueueCommands(task) {
  return {build: pqueueSpecification.buildArguments,
    acceptance: [...pqueueSpecification.loaderArguments, '--test', `acceptance/${task.acceptance}`],
    upstream: pqueueSpecification.upstreamArguments,
    types: ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', '--esModuleInterop', `acceptance/${task.typeAcceptance}`]};
}

export function installPqueueAcceptance(project, task, fixture = pqueueFixture) {
  const target = path.join(project, 'acceptance');fs.mkdirSync(target, {recursive: true});
  for (const file of [task.acceptance, 'support.mjs']) fs.copyFileSync(path.join(fixture, file), path.join(target, file));
  const original = fs.readFileSync(path.join(fixture, task.typeAcceptance), 'utf8');
  assert(original.includes('./project/'), 'Original type acceptance must use the documented project-relative imports');
  // Only relocate imports; assertions and compiler flags stay unchanged.
  fs.writeFileSync(path.join(target, task.typeAcceptance), original.replaceAll('./project/', '../'));
}

export function createPqueueSkillSuite(source) {
  assert(source, '--source <pristine p-queue checkout with installed dependencies> is required');
  source = fs.realpathSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  assert.equal(git('rev-parse', 'HEAD').trim(), pqueueSpecification.commit);
  git('diff', 'HEAD', '--exit-code');
  assert(fs.existsSync(path.join(source, 'node_modules/ava/entrypoints/cli.mjs')));
  const files = git('ls-files', '-z').split('\0').filter(Boolean).sort();
  const dependencyLock = fs.readFileSync(path.join(source, 'package-lock.json'));
  const originalConfiguration = showConfiguration(source), flattened = flattenConfiguration(originalConfiguration, source);
  const inputs = {files: Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(source, file), 'utf8')])), dependencyLock: dependencyLock.toString('utf8')};
  const labels = Object.keys(pqueueCommands(pqueueCases[0]));
  const acceptanceByProject = new Map();
  return {cases: pqueueCases, labels,
    prepare(directory, task) {
      const prepared = prepareOpenSourceProject({source, directory, files, dependencyLock, originalConfiguration, flattened, task,
        specification: {...pqueueSpecification, exclude: [...pqueueSpecification.exclude, 'acceptance']}, commands: pqueueCommands(task),
        setup: project => installPqueueAcceptance(project, task)});
      acceptanceByProject.set(prepared.project, prepared.acceptanceCases);
      return prepared;
    },
    saveInputs(output) {
      const packed = gzipSync(Buffer.from(JSON.stringify(inputs)));
      fs.writeFileSync(path.join(output, 'upstream-inputs.json.gz'), packed, {flag: 'wx'});
      return {repository: pqueueSpecification.repository, commit: pqueueSpecification.commit, tag: pqueueSpecification.tag, license: pqueueSpecification.license,
        inputHash: hash(packed), sourceHashes: hashFiles(source, files), dependencyLockHash: hash(dependencyLock),
        preparation: {kind: 'equivalent-flat-tsconfig', originalHash: hash(fs.readFileSync(path.join(source, 'tsconfig.json'))), configuration: flattened},
        verificationLabels: labels, upstreamCounts: pqueueSpecification.upstreamCounts};
    },
    verify(project, config, directory, prefix) {
      const task = pqueueCases.find(task => config.verification[1].args.includes(`acceptance/${task.acceptance}`));
      assert(task, 'Verification must retain the fixed task acceptance');
      const checks = Object.fromEntries(config.verification.map((command, index) => [labels[index], verifyCommand(project, `${prefix}-${labels[index]}`, command.args, directory,
        {env: Object.fromEntries(Object.entries({...process.env, FORCE_COLOR: '0'}).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
          expectedCases: labels[index] === 'acceptance' ? acceptanceByProject.get(project) : undefined,
          expectedCounts: labels[index] === 'upstream' ? pqueueSpecification.upstreamCounts : undefined})]));
      return {passed: Object.values(checks).every(item => item.passed), checks};
    },
    reference(project, task) {
      const publication = path.join(pqueueFixture, 'optimized-observed');
      const report = JSON.parse(fs.readFileSync(path.join(publication, 'comparison.json'), 'utf8'));
      const run = report.results.find(item => item.taskId === task.id && item.arm === 'terse' && item.repetition === 1);
      assert(run);
      const patch = path.join(publication, run.patch);
      assert.equal(hash(fs.readFileSync(patch)), run.evidence.patchHash);
      execFileSync('git', ['apply', '--', patch], {cwd: project, stdio: 'pipe'});
      return {cohort: 'p-queue/optimized-observed', patch: run.patch, patchHash: run.evidence.patchHash};
    }};
}
