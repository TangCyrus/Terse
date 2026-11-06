import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {flattenConfiguration, verifyConfiguration, collectChanges, upstreamCounts, validateFunctionalReviews, protectedFileEvidence} from '../scripts/lib/benchmark-project.mjs';
import {analyzeEvaluation, prepareEvaluation} from '../scripts/lib/evaluation-project.mjs';
import {cases} from '../scripts/evaluation-cases.mjs';
import {challenges} from '../scripts/challenge-cases.mjs';
import {invoke} from '../scripts/lib/workspace.mjs';
import {snapshot} from '../dist/project.js';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-benchmark-'));
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-benchmark-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  return parent;
}

test('benchmark preparation retains strict compiler options and dynamic inclusion', () => {
  const original = {compilerOptions: {strict: true, noEmitOnError: true, noUncheckedIndexedAccess: true},
    files: ['./source/old.ts'], include: ['source'], exclude: [path.resolve('upstream/dist')]};
  const flattened = flattenConfiguration(original, path.resolve('upstream'));
  assert.deepEqual(flattened, {compilerOptions: original.compilerOptions, include: ['source'], exclude: ['dist']});
  assert(!Object.hasOwn(flattened, 'files'));
  verifyConfiguration(original, {...original});
  for (const invalid of [{...original, compilerOptions: {strict: false}}, {...original, files: []}, {...original, include: ['source/index.ts']}]) {
    assert.throws(() => verifyConfiguration(original, invalid));
  }
  const copied = {...original, exclude: [path.resolve('copy/dist')]};
  verifyConfiguration(original, copied, path.resolve('upstream'), path.resolve('copy'));
  assert.throws(() => verifyConfiguration(original, {...copied, exclude: ['source']}, path.resolve('upstream'), path.resolve('copy')));
});

test('benchmark patches include new helpers and deleted modules while flagging out-of-scope edits', t => {
  const parent = workspace(t);
  const git = (...args) => execFileSync('git', args, {cwd: parent, stdio: 'pipe'});
  git('init', '-q');
  fs.writeFileSync(path.join(parent, 'old.ts'), 'export const old = 1;\n');
  git('add', '.');
  fs.unlinkSync(path.join(parent, 'old.ts'));
  const helper = 'export const helper = () => 1;\n';
  fs.writeFileSync(path.join(parent, 'helper.ts'), helper);
  fs.writeFileSync(path.join(parent, 'unexpected.ts'), 'outside scope\n');
  const result = collectChanges(parent, ['old.ts', 'helper.ts']);
  assert.deepEqual(result.changed, ['helper.ts', 'old.ts']);
  assert.deepEqual(result.outsideScope, ['unexpected.ts']);
  assert.match(result.patch, /new file mode/);
  assert.match(result.patch, /deleted file mode/);
  assert.match(result.patch, /export const helper/);
  assert.equal(fs.readFileSync(path.join(parent, 'helper.ts'), 'utf8'), helper);
});

test('functional benchmark permits new source modules but still catches test edits', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src/original.ts'), 'export const value = 1;');
  fs.writeFileSync(path.join(root, 'test/acceptance.mjs'), 'original');
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '.'], {cwd: root});
  fs.writeFileSync(path.join(root, 'src/new-module.ts'), 'export const extra = 2;');
  fs.writeFileSync(path.join(root, 'test/acceptance.mjs'), 'tampered');
  const result = collectChanges(root, ['src/']);
  assert.deepEqual(result.changed, ['src/new-module.ts', 'test/acceptance.mjs']);
  assert.deepEqual(result.outsideScope, ['test/acceptance.mjs']);
  assert.match(result.patch, /new-module.ts/);
});

test('missing, renamed or replaced acceptance files retain their frozen identity and invalidate the run', t => {
  const root = workspace(t);
  const files = ['orders.test.mjs', 'routes.test.mjs', 'acceptance.test.mjs'];
  for (const file of files) fs.writeFileSync(path.join(root, file), `baseline ${file}`);
  const expected = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const initial = protectedFileEvidence(root, expected, files);
  assert.deepEqual(initial.tampered, []);
  fs.unlinkSync(path.join(root, files[0]));
  fs.renameSync(path.join(root, files[1]), path.join(root, 'renamed.mjs'));
  fs.unlinkSync(path.join(root, files[2]));
  fs.mkdirSync(path.join(root, files[2]));
  const invalid = protectedFileEvidence(root, expected, files);
  assert.deepEqual(invalid.tampered, files);
  assert.equal(invalid.acceptanceHash, initial.acceptanceHash);
  const result = {artifactId:'invalid', arm:'terse', correct:false, protocolValid:false, evidence:{patchHash:'unchanged'}};
  assert.deepEqual(validateFunctionalReviews([result], [{artifactId:'invalid',patchHash:'unchanged',functional:false,reason:'Protected acceptance files were removed or replaced.'}]),
    {control:{runs:0,behaviorCorrect:0,functional:0},terse:{runs:1,behaviorCorrect:0,functional:0}});
});

test('configuration snapshot failures remain persistable invalid samples and do not stop later grading', async t => {
  const results = [];
  for (const mode of ['malformed', 'directory', 'healthy']) {
    const root = workspace(t);
    execFileSync('git', ['init', '-q'], {cwd: root});
    const configPath = path.join(root, 'terse.config.json');
    fs.writeFileSync(configPath, '{"verification":[]}');
    fs.writeFileSync(path.join(root, 'source.js'), 'export const value = 1;\n');
    const before = snapshot(root);
    if (mode === 'malformed') fs.writeFileSync(configPath, '{invalid');
    if (mode === 'directory') { fs.unlinkSync(configPath); fs.mkdirSync(configPath); }
    if (mode !== 'healthy') assert.throws(() => snapshot(root), /INVALID_JSON|JSON_READ_FAILED/);
    const analysis = await analyzeEvaluation(root, before, []);
    if (mode !== 'healthy') {
      assert.equal(analysis.after, null);
      assert.equal(analysis.duplications, null);
      assert.equal(analysis.newDuplications, null);
      assert.equal(analysis.possibleDuplications, null);
      assert.equal(analysis.similarities, null);
      assert.match(analysis.duplicationError, /INVALID_JSON|JSON_READ_FAILED/);
    } else {
      assert.equal(analysis.duplicationError, null);
      assert.equal(analysis.newDuplications, 0);
      assert.deepEqual(analysis.duplications, []);
      assert.equal(analysis.possibleDuplications, 0);
      assert.deepEqual(analysis.similarities, []);
    }
    const result = {artifactId: mode, arm:'control', correct:mode === 'healthy', protocolValid:!analysis.duplicationError,
      newDuplications:analysis.newDuplications, duplicationError:analysis.duplicationError, evidence:{patchHash:mode}};
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result));
    results.push(JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')));
  }
  assert.equal(results.length, 3);
  assert.deepEqual(validateFunctionalReviews(results, results.map(result => ({artifactId:result.artifactId,patchHash:result.evidence.patchHash,
    functional:result.protocolValid,reason:result.duplicationError ?? 'Subsequent healthy grading completed.'}))),
    {control:{runs:3,behaviorCorrect:1,functional:1},terse:{runs:0,behaviorCorrect:0,functional:0}});
});

test('both agent arms are graded for rewritten overlap, exact suppression and cleanup with the same parent analyzer', async t => {
  const parent = workspace(t);
  for (const [id, variantId, exact, possible, cleanup] of [
    ['modify', 'rewritten-copy', false, 1, []], ['modify', 'copy', true, 0, []],
    ['modify', 'reuse', false, 0, []], ['delete', 'retained', false, 0, ['REMOVAL_REMAINS']],
    ['delete', 'cleanup', false, 0, []], ['dynamic', 'review', false, 0, ['REMOVAL_REFERENCE_UNRESOLVED']],
  ]) await t.test(`${id}/${variantId}`, async () => {
    const scenario = cases.find(item => item.id === id);
    const {project, sources} = prepareEvaluation(parent, `${id}-${variantId}`, scenario);
    const before = snapshot(project);
    scenario.variants.find(item => item.id === variantId).edit(sources);
    const result = await analyzeEvaluation(project, before, scenario.remove ?? []);
    assert.equal(result.duplicationError, null);
    assert.equal(result.newDuplications > 0, exact);
    assert.equal(result.possibleDuplications, possible);
    assert.equal(result.similarities.length, possible);
    assert.equal(result.similarityAlgorithm, 'implementation-anchors/1');
    assert.deepEqual(result.cleanup.map(item => item.rule), cleanup);
    if (possible) assert(result.similarities[0].similarity.shared.literals.includes('id,customer,total,status'));
  });
});

test('upstream counts distinguish expected failures from passing tests', () => {
  assert.deepEqual(upstreamCounts('\u001b[32m45 tests passed\u001b[0m\n2 known failures'), {passed: 45, knownFailures: 2});
  assert.deepEqual(upstreamCounts('1 test passed\n1 known failure'), {passed: 1, knownFailures: 1});
  assert.deepEqual(upstreamCounts('initialization failed'), {passed: 0, knownFailures: 0});
});

test('functional grading requires patch review and cannot promote zero-clone or incomplete runs', () => {
  const results = [
    {artifactId: 'modify-control', arm: 'control', correct: true, protocolValid: true, newDuplications: 0, evidence: {patchHash: 'copied-semantics'}},
    {artifactId: 'modify-terse', arm: 'terse', correct: true, protocolValid: true, newDuplications: 0, evidence: {patchHash: 'reused-owner'}},
  ];
  const reviews = [
    {artifactId: 'modify-control', patchHash: 'copied-semantics', functional: false, reason: 'Behavior passed, but the route implements another CSV encoder with different tokens.'},
    {artifactId: 'modify-terse', patchHash: 'reused-owner', functional: true, reason: 'Route delegates to the existing exporter; one encoder remains.'},
  ];
  assert.deepEqual(validateFunctionalReviews(results, reviews), {
    control: {runs: 1, behaviorCorrect: 1, functional: 0}, terse: {runs: 1, behaviorCorrect: 1, functional: 1},
  });
  assert.throws(() => validateFunctionalReviews(results, []), /Every run/);
  assert.throws(() => validateFunctionalReviews(results, [reviews[0], reviews[0]]), /unique/);
  assert.throws(() => validateFunctionalReviews(results, [reviews[0], {...reviews[1], patchHash: 'other'}]), /exact observed/);
  assert.throws(() => validateFunctionalReviews([{...results[1], protocolValid: false}], [reviews[1]]), /Incomplete/);
  assert.throws(() => validateFunctionalReviews([{...results[1], correct: false}], [reviews[1]]), /behavior-incorrect/);
});

test('agent publication uses task-specific artifacts and preserves unknown duplicate measurements', t => {
  const parent = workspace(t);
  const label = 'refactor-pair-1-terse';
  fs.mkdirSync(path.join(parent, label));
  fs.writeFileSync(path.join(parent, label, 'implementation.patch'), 'new helper patch\n');
  fs.writeFileSync(path.join(parent, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(parent, 'comparison.json'), JSON.stringify({schemaVersion: 2, kind: 'open-source-agent-comparison',
    artifactDirectory: parent, results: [{artifactId: label, taskId: 'refactor', repetition: 1, arm: 'terse',
      newDuplications: null, duplicationError: 'Analysis failed', protocolValid: false,
      events: {errors: ['Reconnecting with a machine-specific detail'], finalMessage: 'Private prose'}}]}));
  const target = path.join(parent, 'publication');
  const script = fileURLToPath(new URL('../scripts/export-agent-benchmark.mjs', import.meta.url));
  execFileSync(process.execPath, [script, '--input', parent, '--output', target], {stdio: 'pipe'});
  const report = JSON.parse(fs.readFileSync(path.join(target, 'comparison.json'), 'utf8'));
  assert.equal(report.results[0].patch, `${label}.patch`);
  assert.equal(fs.readFileSync(path.join(target, `${label}.patch`), 'utf8'), 'new helper patch\n');
  assert.equal(report.results[0].newDuplications, null);
  assert.equal(report.results[0].duplications, null);
  assert.equal(report.results[0].protocolValid, false);
  assert(!Object.hasOwn(report.results[0].events, 'finalMessage'));
  assert.deepEqual(report.results[0].events.errors, ['Transport reconnect']);
  assert(!Object.hasOwn(report, 'artifactDirectory'));
  assert.throws(() => execFileSync(process.execPath, [script, '--input', parent, '--output', target], {stdio: 'pipe'}));
});

test('functional publication requires complete reviews and immutable patch bytes without a dependency lock', t => {
  const parent = workspace(t);
  const artifactId = 'modify-pair-1-terse';
  fs.mkdirSync(path.join(parent, artifactId));
  const patchPath = path.join(parent, artifactId, 'implementation.patch');
  fs.writeFileSync(patchPath, 'reviewed patch');
  const patchHash = createHash('sha256').update('reviewed patch').digest('hex');
  fs.writeFileSync(path.join(parent, 'comparison.json'), JSON.stringify({kind: 'controlled-agent-comparison',
    artifactDirectory: parent, results: [{artifactId, arm: 'terse', correct: true, protocolValid: true,
      evidence: {patchHash}, events: {errors: [], finalMessage: 'Do not publish prose'}}]}));
  const script = fileURLToPath(new URL('../scripts/export-agent-benchmark.mjs', import.meta.url));
  const target = path.join(parent, 'publication');
  const publish = destination => execFileSync(process.execPath, [script, '--input', parent, '--output', destination], {stdio: 'pipe'});
  assert.throws(() => publish(target));
  assert(!fs.existsSync(target));
  const reviews = [{artifactId, patchHash, functional: true, reason: 'Single existing exporter owns CSV encoding.'}];
  fs.writeFileSync(path.join(parent, 'functional-reviews.json'), JSON.stringify(reviews));
  publish(target);
  const report = JSON.parse(fs.readFileSync(path.join(target, 'comparison.json'), 'utf8'));
  assert.equal(report.functionalSummary.terse.functional, 1);
  assert(!fs.existsSync(path.join(target, 'dependency-lock.json.gz')));
  assert(!Object.hasOwn(report, 'artifactDirectory'));
  assert(!Object.hasOwn(report.results[0].events, 'finalMessage'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'functional-reviews.json'), 'utf8')), reviews);
  fs.writeFileSync(patchPath, 'modified after review');
  const altered = path.join(parent, 'altered');
  assert.throws(() => publish(altered));
  assert(!fs.existsSync(altered));
  // New cohorts must publish their independent M3 evidence, including zero findings.
  const measured = JSON.parse(fs.readFileSync(path.join(parent, 'comparison.json'), 'utf8'));
  measured.results[0].possibleDuplications = 0;
  measured.results[0].similarityAlgorithm = 'implementation-anchors/1';
  fs.writeFileSync(path.join(parent, 'comparison.json'), JSON.stringify(measured));
  fs.writeFileSync(patchPath, 'reviewed patch');
  const missing = path.join(parent, 'missing-evidence');
  assert.throws(() => publish(missing));
  assert(!fs.existsSync(missing));
  fs.writeFileSync(path.join(parent, artifactId, 'similarities.json'), '[{}]');
  assert.throws(() => publish(missing));
  assert(!fs.existsSync(missing));
  fs.writeFileSync(path.join(parent, artifactId, 'similarities.json'), '[]');
  publish(missing);
  const newReport = JSON.parse(fs.readFileSync(path.join(missing, 'comparison.json'), 'utf8'));
  assert.equal(newReport.results[0].similarities, `${artifactId}.similarities.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(missing, newReport.results[0].similarities), 'utf8')), []);
  const initialPatch='inherited patch';
  const initial={snapshotHash:'start'};
  const initialText=JSON.stringify(initial);
  fs.writeFileSync(path.join(parent,artifactId,'initial.patch'),initialPatch);
  fs.writeFileSync(path.join(parent,artifactId,'initial-analysis.json'),initialText);
  measured.results[0].initial=initial;
  measured.results[0].evidence.initialPatchHash=createHash('sha256').update(initialPatch).digest('hex');
  measured.results[0].evidence.initialAnalysisHash=createHash('sha256').update(initialText).digest('hex');
  fs.writeFileSync(path.join(parent,'comparison.json'),JSON.stringify(measured));
  const seeded=path.join(parent,'seeded');
  publish(seeded);
  assert.equal(fs.readFileSync(path.join(seeded,`${artifactId}.initial.patch`),'utf8'),initialPatch);
  fs.writeFileSync(path.join(parent,artifactId,'initial.patch'),'changed');
  const tampered=path.join(parent,'tampered-seed');
  assert.throws(()=>publish(tampered));
  assert(!fs.existsSync(tampered));
});

test('seeded challenges expose new problems against the original baseline and permit real checked corrections', async t => {
  const parent=workspace(t);
  for(const scenario of challenges.filter(item=>item.seed)) await t.test(scenario.id,async()=>{
    const {project,sources}=prepareEvaluation(parent,scenario.id,scenario);
    const begun=invoke(project,['begin','--task',scenario.task,'--query',scenario.task]);
    const before=snapshot(project);
    scenario.seed(sources);
    const initial=await analyzeEvaluation(project,before,scenario.remove??[]);
    assert.equal(initial.duplicationError,null);
    assert.notEqual(initial.after.hash,before.hash);
    if(scenario.id==='rewrite-resume') assert.equal(initial.possibleDuplications,1);
    else assert(initial.cleanup.some(item=>item.rule==='REMOVAL_REMAINS'));
    const candidate=begun.context.candidates.find(item=>item.path==='src/orders.ts'&&item.symbol==='exportOrders');
    invoke(project,['decide','--run',begun.run,'--strategy','refactor','--rationale','Consolidate inherited work.',
      '--candidate',candidate.candidateId,...(scenario.remove??[]).flatMap(item=>['--remove',item.path])]);
    const warning=invoke(project,['check','--run',begun.run,'--summary'],scenario.id==='rewrite-resume'?2:1);
    assert(warning.findings.some(item=>scenario.targetRules.includes(item.rule)));
    assert(warning.verification.every(item=>item.status==='passed'));
    if(scenario.id==='rewrite-resume') sources.write('paid.ts',"import {exportOrders,type Order} from './orders.ts';\nexport function exportPaidOrders(input:Order[],user:string) { return exportOrders(input.filter(item=>item.status==='paid'),user); }\n");
    else sources.remove('legacy.ts');
    assert.equal(invoke(project,['check','--run',begun.run,'--summary']).status,'pass');
    const final=await analyzeEvaluation(project,before,scenario.remove??[]);
    assert.equal(final.possibleDuplications,0);
    assert.deepEqual(final.cleanup,[]);
  });
});

test('streaming challenge exposes a behavior-correct rewrite and accepts shared formatting', async t => {
  const scenario=challenges.find(item=>item.id==='stream-paid');
  const {project,sources,config}=prepareEvaluation(workspace(t),'stream',scenario);
  const before=snapshot(project);
  sources.write('stream.ts',`import type {Order} from './orders.ts';
export async function streamPaidOrders(input:Order[], user:string, emit:(row:string)=>Promise<void>) {
  if (!user) throw Error('ownerId is required');
  const selected = input.filter(item => item.ownerId === user && item.status === 'paid');
  await emit('id,customer,total,status');
  for (const item of selected) {
    if (item.total < 0 || !Number.isFinite(item.total)) throw Error('Invalid total');
    const escaped = '"' + item.customer.split('"').join('""') + '"';
    await emit(item.id + ',' + escaped + ',' + Number(item.total).toFixed(2) + ',' + item.status);
  }
}`);
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  const verify=()=>execFileSync(process.execPath,config.verification[0].args,{cwd:project,encoding:'utf8',env});
  assert.match(verify(),/tests 3\b/);
  const copied=await analyzeEvaluation(project,before,[]);
  assert.equal(copied.newDuplications,0);
  assert.equal(copied.possibleDuplications,1);
  // A shared selector and row formatter owns the authorization/encoding rules.
  sources.write('format.ts',`import type {Order} from './orders.ts';
export const header='id,customer,total,status';
export function owned(orders:Order[],ownerId:string) {
  if(!ownerId) throw Error('ownerId is required');
  return orders.filter(order=>order.ownerId===ownerId);
}
export function row(order:Order) {
  if(!Number.isFinite(order.total)||order.total<0) throw Error('Invalid total');
  const customer='"'+order.customer.replaceAll('"','""')+'"';
  return [order.id,customer,order.total.toFixed(2),order.status].join(',');
}`);
  sources.write('orders.ts',sources.read('orders.ts').split('// 订单导出')[0]+`import {header,owned,row} from './format.ts';
export function exportOrders(orders:Order[],ownerId:string) {return [header,...owned(orders,ownerId).map(row)].join('\\n');}`);
  sources.write('stream.ts',`import type {Order} from './orders.ts';
import {header,owned,row} from './format.ts';
export async function streamPaidOrders(orders:Order[],ownerId:string,emit:(row:string)=>Promise<void>) {
  const selected=owned(orders,ownerId).filter(order=>order.status==='paid');
  await emit(header);
  for(const order of selected) await emit(row(order));
}`);
  assert.match(verify(),/tests 3\b/);
  const shared=await analyzeEvaluation(project,before,[]);
  assert.equal(shared.newDuplications,0);
  assert.equal(shared.possibleDuplications,0);
});

test('barrel cleanup omissions pass download behavior but remain visible to the parent analyzer', async t => {
  const scenario=challenges.find(item=>item.id==='cleanup-indirect');
  const {project,sources,config}=prepareEvaluation(workspace(t),'barrel',scenario);
  const before=snapshot(project);
  sources.write('routes.ts',sources.read('routes.ts').replace('exportLegacyOrders as exportOrders','exportOrders').replace("'./legacy.ts'","'./orders.ts'"));
  sources.remove('legacy.ts');
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  assert.match(execFileSync(process.execPath,config.verification[0].args,{cwd:project,encoding:'utf8',env}),/tests 3\b/);
  const broken=await analyzeEvaluation(project,before,scenario.remove);
  assert(broken.cleanup.some(item=>item.rule==='REMOVAL_REFERENCE_REMAINS'&&item.locations[0].path==='src/providers.ts'));
  sources.write('providers.ts',"export {exportOrders as archiveExporter} from './orders.ts';\n");
  assert.deepEqual((await analyzeEvaluation(project,before,scenario.remove)).cleanup,[]);
});

test('challenge preflight keeps inherited work passing while the streaming requirement starts unmet', () => {
  const script=fileURLToPath(new URL('../scripts/benchmark-reuse.mjs',import.meta.url));
  const output=JSON.parse(execFileSync(process.execPath,[script,'--codex',process.execPath,'--suite','challenge','--preflight-only'],{encoding:'utf8',timeout:60_000}));
  assert.equal(output.preflight.length,4);
  assert.deepEqual(output.preflight.filter(item=>!item.verification.passed).map(item=>item.taskId),['stream-paid']);
});

test('functional preflight checks all six task starts without a live model or credentials', () => {
  const script = fileURLToPath(new URL('../scripts/benchmark-reuse.mjs', import.meta.url));
  // Node --version stands in only for version discovery; preflight must never call exec.
  const output = execFileSync(process.execPath, [script, '--codex', process.execPath, '--preflight-only'], {encoding: 'utf8', timeout: 60_000});
  const {output: directory, preflight} = JSON.parse(output);
  assert.equal(preflight.length, 6);
  assert.deepEqual(preflight.filter(item => item.verification.passed).map(item => item.taskId), ['delete']);
  const plan = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8'));
  assert.equal(plan.kind, 'controlled-agent-comparison');
  assert(plan.tasks.every(task => task.query === task.task));
  assert(!fs.existsSync(path.join(directory, 'comparison.json')));
  for (const task of plan.tasks) assert(!fs.existsSync(path.join(directory, `preflight-${task.id}`, 'agent.jsonl')));
});

for (const cohort of ['observed', 'optimized-observed']) test(`published functional observation ${cohort} binds every fixture, pair, patch and implementation review`, () => {
  const directory = fileURLToPath(new URL(`../benchmarks/reuse/${cohort}/`, import.meta.url));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8'));
  const reviews = JSON.parse(fs.readFileSync(path.join(directory, 'functional-reviews.json'), 'utf8'));
  const hash = data => createHash('sha256').update(data).digest('hex');
  assert.equal(report.kind, 'controlled-agent-comparison');
  assert.equal(report.tasks.length, 6);
  assert.equal(report.results.length, 12);
  assert.deepEqual(validateFunctionalReviews(report.results, reviews), report.functionalSummary);
  assert.equal(report.reviewHash, hash(JSON.stringify(reviews)));
  assert.equal(report.functionalSummary.control.functional, 6);
  assert.equal(report.functionalSummary.terse.functional, 6);
  // Validate the original inputs, not the evolving HEAD's task oracle or helpers.
  assert.match(report.terseRevision, /^[a-f0-9]{40}$/);
  const snapshot = JSON.parse(gunzipSync(fs.readFileSync(path.join(directory, '..', 'fixtures', `${report.terseRevision}.json.gz`))).toString('utf8'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.revision, report.terseRevision);
  assert.deepEqual(Object.keys(snapshot.files).sort(), Object.keys(report.fixtureHashes).sort());
  assert.deepEqual(Object.keys(report.fixtureCanonicalHashes), Object.keys(report.fixtureHashes));
  for (const [file, expected] of Object.entries(report.fixtureCanonicalHashes)) {
    const input = snapshot.files[file];
    assert.equal(typeof input, 'string');
    assert.equal(hash(input), report.fixtureHashes[file], file);
    const canonical = input.replaceAll('\r\n', '\n');
    assert.equal(hash(canonical), expected, file);
  }
  assert.deepEqual(Object.keys(snapshot.publicationHashes).sort(), fs.readdirSync(directory).sort());
  for (const [file, expected] of Object.entries(snapshot.publicationHashes)) assert.equal(hash(fs.readFileSync(path.join(directory, file))), expected, `Historical publication changed: ${file}`);
  for (const result of report.results) {
    assert.equal(hash(fs.readFileSync(path.join(directory, result.patch))), result.evidence.patchHash);
    const duplicates = JSON.parse(fs.readFileSync(path.join(directory, result.duplications), 'utf8'));
    assert.equal(duplicates.length, result.newDuplications);
    if (cohort === 'optimized-observed') {
      assert.equal(result.similarityAlgorithm, 'implementation-anchors/1');
      const similarities = JSON.parse(fs.readFileSync(path.join(directory, result.similarities), 'utf8'));
      assert.equal(similarities.length, result.possibleDuplications);
      assert(similarities.every(item => item.rule === 'POSSIBLE_DUPLICATION' && item.similarity.algorithm === result.similarityAlgorithm));
      assert.deepEqual(result.cleanup, []);
    }
    assert.equal(result.events.completed, true);
    assert.equal(result.correct, true);
    assert.equal(result.protocolValid, true);
    assert(!Object.hasOwn(result.events, 'finalMessage'));
    assert.match(result.evidence.eventHash, /^[a-f0-9]{64}$/);
  }
  for (const task of report.tasks) {
    const runs = report.results.filter(result => result.taskId === task.id);
    assert.deepEqual(new Set(runs.map(result => result.arm)), new Set(['control', 'terse']));
    assert.equal(runs[0].baselineHash, runs[1].baselineHash);
    assert.equal(runs[0].acceptanceHash, runs[1].acceptanceHash);
    assert.equal(report.pairs.find(pair => pair.taskId === task.id).comparable, true);
  }
  const terse = report.results.filter(result => result.arm === 'terse');
  assert.equal(terse.filter(result => result.candidateHit === true).length, 5);
  assert(terse.every(result => result.workflow && result.terseStatus === 'pass'));
  assert(!Object.hasOwn(report, 'artifactDirectory'));
  assert(!fs.existsSync(path.join(directory, 'dependency-lock.json.gz')));
});

test('retrospective decision measurements refuse altered raw events and never overwrite observations', t => {
  const parent = workspace(t);
  const label = 'pair-1-terse';
  fs.mkdirSync(path.join(parent, label));
  const raw = JSON.stringify({type: 'turn.completed'}) + '\n';
  fs.writeFileSync(path.join(parent, label, 'agent.jsonl'), raw);
  const report = {kind: 'open-source-agent-comparison', results: [{repetition: 1, arm: 'terse', evidence: {
    eventHash: createHash('sha256').update(raw).digest('hex')}, events: {commandCount: 0}}]};
  const reportPath = path.join(parent, 'comparison.json');
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const output = path.join(parent, 'measured.json');
  const script = fileURLToPath(new URL('../scripts/measure-agent-decisions.mjs', import.meta.url));
  const args = [script, '--report', reportPath, '--events', parent, '--output', output];
  execFileSync(process.execPath, args, {stdio: 'pipe'});
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).results[0].decisions.retries, 0);
  assert.throws(() => execFileSync(process.execPath, args, {stdio: 'pipe'}));
  fs.appendFileSync(path.join(parent, label, 'agent.jsonl'), '{}\n');
  assert.throws(() => execFileSync(process.execPath, [...args.slice(0, -1), path.join(parent, 'altered.json')], {stdio: 'pipe'}));
  assert(!fs.existsSync(path.join(parent, 'altered.json')));
  assert.equal(fs.readFileSync(reportPath, 'utf8'), JSON.stringify(report));
});
