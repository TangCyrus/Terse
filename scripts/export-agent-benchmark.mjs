import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values } = parseArgs({ options: { input: {type: 'string'}, output: {type: 'string'} } });
assert(values.input && values.output, 'Pass --input <artifact directory> --output <new publication directory>');
const source = path.resolve(values.input);
const target = path.resolve(values.output);
const report = JSON.parse(fs.readFileSync(path.join(source, 'comparison.json'), 'utf8'));
assert.equal(report.kind, 'open-source-agent-comparison');
assert(report.results.length > 0);
fs.mkdirSync(target); // Never overwrite a previously published experiment.
const results = report.results.map(result => {
  const label = `pair-${result.repetition}-${result.arm}`;
  fs.copyFileSync(path.join(source, label, 'implementation.patch'), path.join(target, `${label}.patch`));
  if (fs.existsSync(path.join(source, label, 'duplications.json'))) {
    fs.copyFileSync(path.join(source, label, 'duplications.json'), path.join(target, `${label}.duplications.json`));
  }
  const { finalMessage, ...events } = result.events;
  events.errors = events.errors.map(message => /Under-development features/.test(message) ? 'Local configuration feature warning'
    : /Reconnecting/.test(message) ? 'Transport reconnect'
      : /Falling back/.test(message) ? 'Transport fallback'
        : 'Other CLI diagnostic; raw message retained locally');
  return { ...result, events, patch: `${label}.patch`, duplications: `${label}.duplications.json` };
});
const { artifactDirectory, ...portable } = report;
fs.writeFileSync(path.join(target, 'dependency-lock.json.gz'), gzipSync(fs.readFileSync(path.join(source, 'package-lock.json'))));
fs.writeFileSync(path.join(target, 'comparison.json'), JSON.stringify({ ...portable, results, exportedAt: new Date().toISOString(),
  publication: 'Raw event streams and process logs remain local; SHA-256 hashes identify those artifacts. Final agent prose and machine-local artifact paths are omitted. Patches and duplicate evidence are included.' }, null, 2) + '\n');
console.log(JSON.stringify({ output: target, runs: results.length }));
