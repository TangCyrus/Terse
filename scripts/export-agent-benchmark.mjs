import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import {createHash} from 'node:crypto';
import {validateFunctionalReviews} from './lib/benchmark-project.mjs';
import {repository} from './lib/workspace.mjs';

const { values } = parseArgs({ options: { input: {type: 'string'}, output: {type: 'string'} } });
assert(values.input && values.output, 'Pass --input <artifact directory> --output <new publication directory>');
const source = path.resolve(values.input);
const target = path.resolve(values.output);
const report = JSON.parse(fs.readFileSync(path.join(source, 'comparison.json'), 'utf8'));
assert(['open-source-agent-comparison', 'controlled-agent-comparison'].includes(report.kind));
assert(report.results.length > 0);
const reviews = report.kind === 'controlled-agent-comparison'
  ? JSON.parse(fs.readFileSync(path.join(source, 'functional-reviews.json'), 'utf8')) : null;
const functionalSummary = reviews ? validateFunctionalReviews(report.results, reviews) : null;
// Keep measured byte hashes, and publish a separate LF hash for cross-platform source checks.
const fixtureCanonicalHashes = reviews ? Object.fromEntries(Object.entries(report.fixtureHashes ?? {}).map(([file, expected]) => {
  const bytes = fs.readFileSync(path.join(repository, file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Fixture changed after the observed run');
  return [file, createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex')];
})) : null;
if (reviews) for (const result of report.results) assert.equal(
  createHash('sha256').update(fs.readFileSync(path.join(source, result.artifactId, 'implementation.patch'))).digest('hex'),
  result.evidence.patchHash, 'Reviewed patch bytes changed after grading');
for (const result of report.results) if (Object.hasOwn(result, 'possibleDuplications') && result.possibleDuplications !== null) {
  assert(Number.isInteger(result.possibleDuplications) && result.possibleDuplications >= 0);
  const evidence = JSON.parse(fs.readFileSync(path.join(source, result.artifactId, 'similarities.json'), 'utf8'));
  assert(Array.isArray(evidence));
  assert.equal(evidence.length, result.possibleDuplications, 'Similarity count must match saved evidence');
  assert(evidence.every(item => item.rule === 'POSSIBLE_DUPLICATION' && item.similarity?.algorithm === result.similarityAlgorithm));
}
fs.mkdirSync(target); // Never overwrite a previously published experiment.
const results = report.results.map(result => {
  const label = result.artifactId ?? `pair-${result.repetition}-${result.arm}`;
  assert(/^[a-z0-9-]+$/.test(label), 'Artifact label must be a single portable directory name');
  fs.copyFileSync(path.join(source, label, 'implementation.patch'), path.join(target, `${label}.patch`));
  const hasDuplications = fs.existsSync(path.join(source, label, 'duplications.json'));
  if (hasDuplications) {
    fs.copyFileSync(path.join(source, label, 'duplications.json'), path.join(target, `${label}.duplications.json`));
  }
  const hasSimilarities = fs.existsSync(path.join(source, label, 'similarities.json'));
  if (hasSimilarities) fs.copyFileSync(path.join(source, label, 'similarities.json'), path.join(target, `${label}.similarities.json`));
  const { finalMessage, ...events } = result.events;
  events.errors = events.errors.map(message => /Under-development features/.test(message) ? 'Local configuration feature warning'
    : /Reconnecting/.test(message) ? 'Transport reconnect'
      : /Falling back/.test(message) ? 'Transport fallback'
        : 'Other CLI diagnostic; raw message retained locally');
  return { ...result, events, patch: `${label}.patch`, duplications: hasDuplications ? `${label}.duplications.json` : null,
    ...(Object.hasOwn(result, 'possibleDuplications') ? {similarities: hasSimilarities ? `${label}.similarities.json` : null} : {}) };
});
const { artifactDirectory, ...portable } = report;
if (report.kind === 'open-source-agent-comparison') fs.writeFileSync(path.join(target, 'dependency-lock.json.gz'), gzipSync(fs.readFileSync(path.join(source, 'package-lock.json'))));
if (reviews) fs.writeFileSync(path.join(target, 'functional-reviews.json'), JSON.stringify(reviews, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'comparison.json'), JSON.stringify({ ...portable, results, exportedAt: new Date().toISOString(),
  ...(reviews ? {functionalSummary, fixtureCanonicalHashes, reviewHash: createHash('sha256').update(JSON.stringify(reviews)).digest('hex')} : {}),
  publication: 'Raw event streams and process logs remain local; SHA-256 hashes identify those artifacts. Final agent prose and machine-local artifact paths are omitted. Patches and duplicate evidence are included.' }, null, 2) + '\n');
console.log(JSON.stringify({ output: target, runs: results.length }));
