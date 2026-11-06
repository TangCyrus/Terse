import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {repository} from './lib/workspace.mjs';
import {hash, hashFiles, write, skillSummary, skillWorkflow} from './lib/skill-evidence.mjs';

export function exportSkillBenchmark(source, target, archiveDirectory) {
  const report = JSON.parse(fs.readFileSync(path.join(source, 'report.json'), 'utf8'));
  assert.equal(report.kind, 'agent-skill-integration');assert(report.results.length > 0);
  assert.match(report.terseRevision, /^[0-9a-f]{40}$/);
  assert.equal(report.results.length, report.tasks.length * report.repetitions);
  assert.equal(new Set(report.results.map(item => item.artifactId)).size, report.results.length);
  for (const task of report.tasks) for (let repetition = 1; repetition <= report.repetitions; repetition++) {
    const matches = report.results.filter(item => item.taskId === task.id && item.repetition === repetition);
    assert.equal(matches.length, 1);assert.equal(matches[0].promptHash, task.promptHash);
  }
  const reviews = JSON.parse(fs.readFileSync(path.join(source, 'reviews.json'), 'utf8'));
  const summary = skillSummary(report.results, reviews);
  const files = Object.fromEntries(Object.entries(report.fixtureHashes).map(([file, expected]) => {
    const input = fs.readFileSync(path.join(repository, file), 'utf8');
    assert.equal(hash(input), expected, `Input changed after running: ${file}`);return [file, input];
  }));
  const copies = [];
  const results = report.results.map(result => {
    assert(/^[a-z0-9-]+$/.test(result.artifactId));
    const directory = path.join(source, result.artifactId);
    for (const [file, key] of [['implementation.patch', 'patchHash'], ['observations.json', 'observationsHash'], ['analysis.json', 'analysisHash']]) {
      assert.equal(hash(fs.readFileSync(path.join(directory, file))), result.evidence[key]);
      copies.push([path.join(directory, file), `${result.artifactId}.${file}`]);
    }
    const observations = JSON.parse(fs.readFileSync(path.join(directory, 'observations.json'), 'utf8'));
    assert.deepEqual(result.workflow, skillWorkflow(observations, {initialHash: result.baselineHash, finalHash: result.snapshotHash,
      verification: result.verification, removals: report.tasks.find(item => item.id === result.taskId).remove,
      traceComplete: result.events.completed && !result.observationErrors.length}));
    for (const [file, key] of [['agent.jsonl', 'eventHash'], ['prompt.txt', 'promptHash'], ['initialization.json', 'initializationHash']]) {
      assert.equal(hash(fs.readFileSync(path.join(directory, file))), result.evidence[key]);
    }
    assert.equal(result.evidence.promptHash, result.promptHash);
    const {finalMessage, errors, ...events} = result.events;
    return {...result, events: {...events, errors: errors.map(() => 'CLI diagnostic; raw detail retained locally')},
      observationErrors: result.observationErrors.map(() => 'Observation error; raw detail retained locally'),
      patch: `${result.artifactId}.implementation.patch`, observations: `${result.artifactId}.observations.json`, analysis: `${result.artifactId}.analysis.json`};
  });
  // Preflight both destinations before writing. Existing cohorts are immutable.
  const archive = path.join(archiveDirectory, `${report.terseRevision}.json.gz`);
  assert(!fs.existsSync(target));assert(!fs.existsSync(archive));
  fs.mkdirSync(target, {recursive: true});fs.mkdirSync(archiveDirectory, {recursive: true});
  for (const [from, to] of copies) fs.copyFileSync(from, path.join(target, to), fs.constants.COPYFILE_EXCL);
  write(path.join(target, 'reviews.json'), reviews);
  write(path.join(target, 'report.json'), {...report, results, summary,
    fixtureCanonicalHashes: Object.fromEntries(Object.entries(files).map(([file, input]) => [file, hash(input.replaceAll('\r\n', '\n'))])),
    publication: 'Raw event streams, command outputs, prompts and local initialization paths remain local, identified by SHA-256. Published patches, observations and source review are separate from automatic workflow counts. No control arm or causal improvement claim.'});
  fs.writeFileSync(archive, gzipSync(Buffer.from(JSON.stringify({schemaVersion: 1, revision: report.terseRevision, files,
    publicationHashes: hashFiles(target, fs.readdirSync(target).sort())}))), {flag: 'wx'});
  return {output: target, summary, archive};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {input: {type: 'string'}, output: {type: 'string'}, archive: {type: 'string'}}});
  assert(values.input && values.output && values.archive, 'Pass --input <raw folder> --output <new publication> --archive <archive folder>');
  console.log(JSON.stringify(exportSkillBenchmark(path.resolve(values.input), path.resolve(values.output), path.resolve(values.archive)), null, 2));
}
