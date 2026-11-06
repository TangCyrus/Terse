import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { summarizeEvents, pairedSummary, correctionEvidence } from '../scripts/lib/agent-events.mjs';

test('agent events retain real usage, transport failures and final completion separately', () => {
  const result = summarizeEvents([
    {type: 'error', message: 'Reconnecting'},
    {type: 'item.completed', item: {type: 'command_execution'}},
    {type: 'item.completed', item: {type: 'agent_message', text: 'Done'}},
    {type: 'turn.completed', usage: {input_tokens: 120, cached_input_tokens: 80, output_tokens: 12}},
  ].map(event => JSON.stringify(event)).join('\n'));
  assert.equal(result.completed, true);
  assert.deepEqual(result.usage, {input_tokens: 120, cached_input_tokens: 80, output_tokens: 12});
  assert.deepEqual(result.errors, ['Reconnecting']);
  assert.equal(result.commandCount, 1);
  assert.equal(result.finalMessage, 'Done');
});

test('missing, truncated and failed agent turns cannot be counted as completed runs', () => {
  for (const text of ['', 'null', '12', '{"type":"turn.started"}', '{"type":"turn.completed"}\n{broken', '{"type":"turn.completed"}\n{"type":"turn.failed"}']) {
    assert.equal(summarizeEvents(text).completed, false);
  }
  assert.equal(summarizeEvents('').usage, null);
  assert.equal(summarizeEvents('{"type":"turn.completed"}').usage, null);
});

const decisionResponse = failed => ({schemaVersion: 1, command: 'decide', outputKind: failed ? 'error' : 'result',
  status: failed ? 'incomplete' : 'pass', exitCode: failed ? 3 : 0,
  diagnostics: failed ? [{code: 'INVALID_ARGUMENT', issues: [{code: 'conflict'}]}] : []});
const commandEvent = (id, command, output) => ({type: 'item.completed', item: {id, type: 'command_execution', command, aggregated_output: output, exit_code: 0}});
const decisionSummary = events => summarizeEvents([...events, {type: 'turn.completed'}].map(event => JSON.stringify(event)).join('\n'), 'D:/Terse/dist/cli.js').decisions;

test('correction evidence requires an observed warning followed by a full later check and independent cleanup', () => {
  const response = (hash, rules = []) => ({schemaVersion:1,command:'check',outputKind:'result',baselineHash:'base',snapshotHash:hash,
    status:rules.length ? 'needs-review' : 'pass',errors:[],verification:[{status:'passed'}],findings:rules.map(rule=>({rule,severity:'review',locations:[]}))});
  const summarize = (items, finish = true) => summarizeEvents([...items,...(finish ? [{type:'turn.completed'}] : [])].map(item=>JSON.stringify(item)).join('\n'),'D:/Terse/dist/cli.js').checks;
  const warned = response('start',['POSSIBLE_DUPLICATION']);
  const clean = response('end');
  const first = commandEvent('warning','node cli.js check --run r --summary --json',JSON.stringify(warned));
  const last = commandEvent('final','node cli.js check --run r --summary --json',JSON.stringify(clean));
  const options = {baselineHash:'base',startingHash:'start',finalHash:'end',targetRules:['POSSIBLE_DUPLICATION'],seeded:true,finalClean:true,verificationCount:1};
  const activity = summarize([first,last]);
  assert.equal(correctionEvidence(activity,options).observedCorrection,true);
  assert.equal(correctionEvidence(activity,options).warning.itemId,'warning');
  for (const changed of [{finalClean:false},{finalHash:'wrong'},{startingHash:'other'},{verificationCount:2},{baselineHash:'other'}]) {
    assert.equal(correctionEvidence(activity,{...options,...changed}).observedCorrection,false);
  }
  assert.equal(correctionEvidence(summarize([last,first]),options).observedCorrection,false);
  assert.equal(correctionEvidence(summarize([first,last],false),options).observedCorrection,false);
  const skipped = commandEvent('skipped','node cli.js check --run r',JSON.stringify({...clean,verification:[]}));
  assert.equal(correctionEvidence(summarize([first,skipped]),options).observedCorrection,false);
  const truncated = commandEvent('truncated','node cli.js check --run r','{"schemaVersion":1');
  assert.equal(correctionEvidence(summarize([first,truncated,last]),options).observedCorrection,false);
  const partial = commandEvent('partial','node cli.js check --run r; node cli.js check --run r',JSON.stringify(clean)+'\n{"schemaVersion":1');
  assert.equal(correctionEvidence(summarize([first,partial]),options).observedCorrection,false);
  const noOpportunity = correctionEvidence(summarize([last]),{...options,seeded:false});
  assert.equal(noOpportunity.warningObserved,false);
  assert.equal(noOpportunity.observedCorrection,false);
  const logs = [commandEvent('read','Get-Content report.json',JSON.stringify(warned)),commandEvent('git','git diff --check','')];
  assert.deepEqual(summarize(logs).reports,[]);
  assert.equal(summarize(logs).unknownCalls,0);
  const combined = summarize([commandEvent('combined','node cli.js check --run r; node cli.js check --run r',JSON.stringify(warned)+'\n'+JSON.stringify(clean))]);
  assert.equal(correctionEvidence(combined,options).observedCorrection,true);
  assert.equal(correctionEvidence(combined,options).finalCheck.responseIndex,1);
});

test('agent pairs require identical inherited starting work as well as baseline and tests', () => {
  const base={taskId:'repair',repetition:1,baselineHash:'base',acceptanceHash:'tests',protocolValid:true,correct:true,newDuplications:0,agentMs:1};
  assert.equal(pairedSummary([{...base,arm:'control',startingHash:'left'},{...base,arm:'terse',startingHash:'right'}])[0].comparable,false);
});

test('decision metrics exclude help and file names and distinguish retries from successful revisions', () => {
  const cli = 'node "D:\\\\Terse\\\\dist\\\\cli.js" decide ';
  const result = decisionSummary([
    commandEvent('help', cli + '--cwd project --help', 'Usage: decide --run <id>'),
    commandEvent('read', 'Get-Content .terse/decide-input.json', JSON.stringify(decisionResponse(false))),
    commandEvent('bad', cli + '--input input.json --candidate id', JSON.stringify(decisionResponse(true), null, 2)),
    commandEvent('fixed', cli + '--input input.json', JSON.stringify(decisionResponse(false))),
    commandEvent('revision', cli + '--input revised.json', JSON.stringify(decisionResponse(false))),
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.helpCalls, 1);
  assert.equal(result.attempts, 3);
  assert.equal(result.failedAttempts, 1);
  assert.equal(result.successfulWrites, 2);
  assert.equal(result.retries, 1);
  assert.equal(result.unrecoveredFailure, false);
  assert.deepEqual(result.evidence.map(item => item.itemId), ['bad', 'fixed', 'revision']);
  assert.deepEqual(result.evidence[0].diagnosticCodes, ['INVALID_ARGUMENT']);
});

test('decision metrics retain several CLI responses per tool event and unrecovered failures', () => {
  const command = 'node D:/Terse/dist/cli.js decide --input a; node D:/Terse/dist/cli.js decide --input b';
  const result = decisionSummary([commandEvent('combined', command, 'preamble\n' + JSON.stringify(decisionResponse(true)) + '\n' + JSON.stringify(decisionResponse(true)))]);
  assert.equal(result.failedAttempts, 2);
  assert.equal(result.retries, 1);
  assert.equal(result.unrecoveredFailure, true);
});

test('decision metrics recognize shell-escaped paths and variable-based CLI invocations', () => {
  const result = decisionSummary([
    commandEvent('escaped', `node "D:'"\\\\Terse\\\\dist\\\\cli.js\\" decide --input a`, JSON.stringify(decisionResponse(false))),
    commandEvent('variable', "$cli = 'D:/Terse/dist/cli.js'; node $cli decide --input b", JSON.stringify(decisionResponse(false))),
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.successfulWrites, 2);
  assert.equal(result.retries, 0);
});

test('decision metrics never convert truncated or failed sessions into zero retries', () => {
  const event = commandEvent('truncated', 'node D:/Terse/dist/cli.js decide --input a', '{"schemaVersion":1,"command":"decide"');
  const result = decisionSummary([event]);
  assert.equal(result.attempts, 1);
  assert.equal(result.complete, false);
  assert.equal(result.retries, null);
  assert.equal(result.evidence[0].outcome, 'unknown');
  const failed = summarizeEvents(JSON.stringify({type: 'turn.failed'}), 'D:/Terse/dist/cli.js').decisions;
  assert.equal(failed.retries, null);
});

test('agent comparison keeps incomplete or invalid pairs out of elapsed-time differences', () => {
  const control = {repetition: 1, arm: 'control', baselineHash: 'same', acceptanceHash: 'tests', protocolValid: true, agentMs: 100, correct: true, newDuplications: 2};
  const terse = {...control, arm: 'terse', agentMs: 140, newDuplications: 0};
  assert.equal(pairedSummary([control])[0].comparable, false);
  assert.equal(pairedSummary([control, terse])[0].terseMinusControlMs, 40);
  for (const invalid of [{...terse, protocolValid: false}, {...terse, baselineHash: 'changed'}, {...terse, acceptanceHash: 'different'}, {...terse, newDuplications: null}]) {
    assert.equal(pairedSummary([control, invalid])[0].terseMinusControlMs, null);
  }
});

test('published agent results bind task, tests, dependency lock and implementation patches', () => {
  const directory = new URL('../benchmarks/p-map/', import.meta.url);
  const read = file => fs.readFileSync(new URL(file, directory));
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const recorded of ['observed', 'commands-observed']) {
      const report = JSON.parse(read(`${recorded}/comparison.json`));
      assert.deepEqual(report.project, JSON.parse(read('project.json')));
      assert.equal(report.taskHash, hash(read('task.md')));
      assert.equal(report.acceptanceHash, hash(read('acceptance.mjs')));
      assert.equal(report.typeAcceptanceHash, hash(read('acceptance-types.mts')));
      assert.equal(report.dependencyLockHash, hash(gunzipSync(read(`${recorded}/dependency-lock.json.gz`))));
      assert.equal(report.results.length, report.repetitions * 2);
      assert.deepEqual(report.pairs, pairedSummary(report.results));
      for (const run of report.results) {
        assert.equal(hash(read(`${recorded}/${run.patch}`)), run.evidence.patchHash);
        const findings = JSON.parse(read(`${recorded}/${run.duplications}`));
        assert.equal(findings.length, run.newDuplications);
        assert.equal(run.correct, Object.values(run.checks).every(check => check.passed) && run.tampered.length === 0);
        assert(!Object.hasOwn(run.events, 'finalMessage'));
      }
      assert(!Object.hasOwn(report, 'artifactDirectory'));
    }
  });

  test('multi-task agent pairs never combine different tasks with the same repetition', () => {
    const base = {repetition: 1, baselineHash: 'same', acceptanceHash: 'same', protocolValid: true, agentMs: 10, correct: true, newDuplications: 0};
    const runs = [{...base, taskId: 'modify', arm: 'control'}, {...base, taskId: 'delete', arm: 'terse'},
      {...base, taskId: 'modify', arm: 'terse', agentMs: 20}];
    assert.deepEqual(pairedSummary(runs), [
      {taskId: 'modify', repetition: 1, comparable: true, correctness: {control: true, terse: true},
        duplicateGroups: {control: 0, terse: 0}, agentMs: {control: 10, terse: 20}, terseMinusControlMs: 10},
      {taskId: 'delete', repetition: 1, comparable: false, reason: 'Missing arm'},
    ]);
  });

  test('published p-queue experiment binds every task, shared oracle, lock and new/deleted file patch', () => {
    const directory = new URL('../benchmarks/p-queue/', import.meta.url);
    const read = file => fs.readFileSync(new URL(file, directory));
    const hash = value => createHash('sha256').update(value).digest('hex');
    for (const recorded of ['observed', 'optimized-observed']) {
    const report = JSON.parse(read(`${recorded}/comparison.json`));
    assert.equal(report.schemaVersion, 2);
    assert.deepEqual(report.project, JSON.parse(read('project.json')));
    assert.equal(report.dependencyLockHash, hash(gunzipSync(read(`${recorded}/dependency-lock.json.gz`))));
    assert.equal(report.results.length, report.tasks.length * report.repetitions * 2);
    assert.deepEqual(report.pairs, pairedSummary(report.results));
    assert.equal(report.preparation.kind, 'equivalent-flat-tsconfig');
    assert.equal(report.preparation.configuration.compilerOptions.strict, true);
    assert.equal(report.preflight.upstream.passed, true);
    assert.equal(report.preflight.build.passed, true);
    for (const task of report.tasks) {
      assert.equal(task.taskHash, hash(read(task.taskFile)));
      assert.equal(task.typeAcceptanceHash, hash(read(task.typeAcceptance)));
      const hashes = Object.fromEntries([task.acceptance, 'support.mjs'].sort().map(file => [file, hash(read(file))]));
      assert.deepEqual(task.acceptanceHashes, hashes);
      assert.equal(task.acceptanceHash, hash(JSON.stringify(hashes)));
      assert.equal(report.preflight.tasks.find(item => item.id === task.id).before.passed, false);
      for (const arm of ['control', 'terse']) {
        const runs = report.results.filter(run => run.taskId === task.id && run.arm === arm);
        assert.deepEqual(runs.map(run => run.repetition), [1, 2]);
        for (const run of runs) {
          assert.equal(run.acceptanceHash, task.acceptanceHash);
          assert.equal(hash(read(`${recorded}/${run.patch}`)), run.evidence.patchHash);
          const patch = read(`${recorded}/${run.patch}`).toString('utf8');
          for (const file of run.changed) assert(patch.includes(`diff --git a/${file} b/${file}`), `${run.artifactId}: missing patch for ${file}`);
          if (run.duplications) assert.equal(JSON.parse(read(`${recorded}/${run.duplications}`)).length, run.newDuplications);
          else assert.equal(run.newDuplications, null);
          assert.equal(run.correct, Object.values(run.checks).every(check => check.passed) && run.tampered.length === 0);
          assert.equal(run.checks.upstream.passed, run.checks.upstream.exitCode === 0 && !run.checks.upstream.error
            && JSON.stringify(run.checks.upstream.counts) === JSON.stringify(report.project.upstreamCounts));
          assert(!Object.hasOwn(run.events, 'finalMessage'));
          if (recorded === 'optimized-observed') {
            const decisions = run.events.decisions;
            assert.equal(decisions.attempts, decisions.evidence.length);
            assert.equal(decisions.successfulWrites, decisions.evidence.filter(item => item.outcome === 'saved').length);
            assert.equal(decisions.failedAttempts, decisions.evidence.filter(item => item.outcome === 'rejected').length);
            if (!decisions.complete) assert.equal(decisions.retries, null);
          }
        }
      }
    }
    assert(!Object.hasOwn(report, 'artifactDirectory'));
  }
  const before = JSON.parse(read('observed/comparison.json'));
  const after = JSON.parse(read('optimized-observed/comparison.json'));
  assert.equal(before.dependencyLockHash, after.dependencyLockHash);
  assert.deepEqual(before.tasks, after.tasks);
  assert.deepEqual(before.preparation, after.preparation);
  assert.equal(before.cliVersion, after.cliVersion);
  const history = JSON.parse(read('observed-decisions.json'));
  assert.equal(history.measurement, 'terse-decisions/1');
  assert.equal(history.reportHash, hash(read('observed/comparison.json')));
  assert.equal(history.results.length, before.results.length);
  for (const item of history.results) assert.equal(item.eventHash, before.results.find(run => run.artifactId === item.artifactId).evidence.eventHash);
});
