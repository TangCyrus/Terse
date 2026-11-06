import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {naturalCases} from '../scripts/natural-cases.mjs';
import {prepareEvaluation,analyzeEvaluation} from '../scripts/lib/evaluation-project.mjs';
import {snapshot} from '../dist/project.js';
import {clones,indexSources} from '../dist/analyze.js';
import {invoke} from '../scripts/lib/workspace.mjs';

const env={...process.env}; delete env.NODE_TEST_CONTEXT;
function workspace(t) {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'terse-natural-'));
  t.after(()=>{
    const resolved=fs.realpathSync(parent);
    assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-natural-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return parent;
}
const files=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(item=>item.isDirectory()?files(path.join(directory,item.name)):[path.join(directory,item.name)]);
const verification=(project,config)=>{
  const result=spawnSync(process.execPath,config.verification[0].args,{cwd:project,env,encoding:'utf8',timeout:30_000});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);
  assert.match(result.stdout,/tests 3\b/);
  return result;
};

// Authored sanity implementations prove the fixture is attainable; they are
// never supplied as an agent draft or counted as real observations.
const batchReference=`import {exportOrders,type Order} from '../orders.ts';
import {selectCustomerOrders} from '../domain/selection.ts';
export async function streamCustomerBatches(orders:Order[],ownerId:string,options:any,emit:(batch:any)=>Promise<void>) {
  const visible=selectCustomerOrders(orders,ownerId,options.status);
  if(!Number.isInteger(options.size)||options.size<1||options.size>1000) throw Error('Invalid size');
  const seen=new Set<string>();
  for(const order of visible) {if(seen.has(order.id)) throw Error('Duplicate id'); seen.add(order.id);}
  let offset=0;
  if(options.afterId!==undefined) {const found=visible.findIndex(order=>order.id===options.afterId);if(found<0) throw Error('Unknown cursor');offset=found+1;}
  if(offset===visible.length) {await emit({csv:exportOrders([],ownerId),nextCursor:null});return;}
  while(offset<visible.length) {
    const selected=visible.slice(offset,offset+options.size);offset+=selected.length;
    await emit({csv:exportOrders(selected,ownerId),nextCursor:offset<visible.length?selected.at(-1)!.id:null});
  }
}`;
const auditReference=`import type {Order} from '../orders.ts';
import {csvCell,orderRecord} from '../reporting/csv.ts';
export async function streamAuditCsv(orders:Order[],authorization:any,emit:(row:string)=>Promise<void>) {
  if(authorization?.auditor!==true) throw Error('Auditor required');
  await emit('ownerId,id,customer,total,status');
  for(const order of orders) {
    if(authorization.owners&&!authorization.owners.includes(order.ownerId)) continue;
    if(authorization.statuses&&!authorization.statuses.includes(order.status)) continue;
    await emit(csvCell(order.ownerId)+','+orderRecord(order));
  }
}`;

test('complex natural tasks have healthy supported behavior and attainable shared implementations', async t=>{
  const parent=workspace(t);
  for(const scenario of naturalCases) await t.test(scenario.id,async()=>{
    assert.equal(scenario.mode,'natural');assert.equal(scenario.seed,undefined);
    const {project,sources,config}=prepareEvaluation(parent,scenario.id,scenario);
    const before=snapshot(project);
    assert.equal(Object.keys(before.files).length,12);
    assert.deepEqual(indexSources(before,project).errors,[]);
    assert.equal((await clones(before)).length,0);
    execFileSync(process.execPath,['--test','test/orders.test.mjs','test/routes.test.mjs'],{cwd:project,env,stdio:'pipe'});
    execFileSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';
      import {readArchiveCsv,weeklyDigest,downloadBilling,billingCsv} from './src/api.ts';
      import {manualDigest} from './src/jobs/manual.ts';import {loadBilling} from './src/plugins.ts';
      for(const fn of [readArchiveCsv,downloadBilling,billingCsv,(await loadBilling()).createBillingCsv]) assert.equal(fn([],'a'),'id,customer,total,status');
      assert.equal(weeklyDigest([],'a').kind,'weekly');assert.equal(manualDigest([],'a').kind,'manual');`],{cwd:project,env,stdio:'pipe'});
    if(scenario.id==='customer-batches') sources.write('reports/batches.ts',batchReference);
    else if(scenario.id==='audit-delivery') sources.write('reports/audit.ts',auditReference);
    else {
      sources.write('reports/billing.ts',sources.read('legacy/billing.ts'));
      for(const file of files(path.join(project,'src'))) {
        const relative=path.relative(path.join(project,'src'),file);
        if(relative.replaceAll('\\','/')==='legacy/billing.ts') continue;
        sources.write(relative,fs.readFileSync(file,'utf8').replaceAll('legacy/billing.ts','reports/billing.ts'));
      }
      sources.remove('legacy/billing.ts');
    }
    const log=execFileSync(process.execPath,config.verification[0].args,{cwd:project,env,encoding:'utf8'});
    assert.match(log,/tests 3\b/);
    const analysis=await analyzeEvaluation(project,before,scenario.remove??[]);
    assert.equal(analysis.duplicationError,null);
    assert.equal(analysis.newDuplications,0);
    assert.equal(analysis.possibleDuplications,0);
    assert.deepEqual(analysis.cleanup,[]);
  });
});

test('complex natural preflight starts without injected work and with unmet new requirements',()=>{
  const script=fileURLToPath(new URL('../scripts/benchmark-reuse.mjs',import.meta.url));
  const output=JSON.parse(execFileSync(process.execPath,[script,'--suite','natural-complex','--preflight-only','--codex',process.execPath],{encoding:'utf8',timeout:60_000}));
  assert.equal(output.preflight.length,3);
  assert(output.preflight.every(item=>!item.verification.passed));
  const plan=JSON.parse(fs.readFileSync(path.join(output.output,'plan.json'),'utf8'));
  assert.equal(plan.suite,'natural-complex');
  assert(plan.tasks.every(item=>item.mode==='natural'));
});

test('empty cursor acceptance rejects truthiness shortcuts in both lookup and nextCursor',async t=>{
  const parent=workspace(t), scenario=naturalCases.find(item=>item.id==='customer-batches');
  for(const [name,source] of [
    ['omitted-empty-input',batchReference.replace('if(options.afterId!==undefined)','if(options.afterId)')],
    ['collapsed-empty-output',batchReference.replace('selected.at(-1)!.id:null','(selected.at(-1)!.id || null):null')],
  ]) await t.test(name,()=>{
    assert.notEqual(source,batchReference);
    const {project,sources,config}=prepareEvaluation(parent,name,scenario);
    sources.write('reports/batches.ts',source);
    const result=verification(project,config);
    assert.equal(result.status,1,result.stdout+result.stderr);
    assert.match(result.stdout,/fail 1\b/);
  });
});

test('current behavior acceptance catches historical boundary defects without regrading the old cohort',async t=>{
  const parent=workspace(t);
  const publication=fileURLToPath(new URL('../benchmarks/reuse/natural-observed/',import.meta.url));
  const report=JSON.parse(fs.readFileSync(path.join(publication,'comparison.json'),'utf8'));
  const failures=new Set([
    'customer-batches-pair-1-terse/draft','customer-batches-pair-1-terse/final',
    'billing-migration-pair-1-terse/draft','billing-migration-pair-1-terse/final',
    'billing-migration-pair-2-terse/draft','billing-migration-pair-2-terse/final',
    'billing-migration-pair-1-control/draft',
  ]);
  let rejected=0,accepted=0;
  for(const run of report.results.filter(item=>['customer-batches','billing-migration'].includes(item.taskId))) {
    for(const phase of ['draft','final']) await t.test(`${run.artifactId}/${phase}`,()=>{
      const scenario=naturalCases.find(item=>item.id===run.taskId);
      const {project,config}=prepareEvaluation(parent,`${run.artifactId}-${phase}`,scenario);
      execFileSync('git',['add','.'],{cwd:project,stdio:'pipe'});
      // Verify one real failure of each boundary through the unchanged full CLI.
      const throughCli=run.arm==='terse'&&run.repetition===1&&phase==='final';
      let begun;
      if(throughCli) {
        begun=invoke(project,['begin','--task','Verify stronger behavior acceptance','--query',scenario.candidate.symbol]);
        const candidate=begun.context.candidates.find(item=>item.path===scenario.candidate.path&&item.symbol===scenario.candidate.symbol);
        assert(candidate);
        invoke(project,['decide','--run',begun.run,'--strategy','refactor','--rationale','Reuse the existing exporter and preserve compatibility.',
          '--candidate',candidate.candidateId,...(scenario.remove??[]).flatMap(item=>['--remove',item.path])]);
      }
      const patch=path.join(publication,phase==='draft'?run.draftPatch:run.patch);
      const expectedHash=phase==='draft'?run.evidence.draftPatchHash:run.evidence.patchHash;
      assert.equal(createHash('sha256').update(fs.readFileSync(patch)).digest('hex'),expectedHash);
      execFileSync('git',['apply','--',patch],{cwd:project,stdio:'pipe'});
      const result=verification(project,config), shouldFail=failures.has(`${run.artifactId}/${phase}`);
      assert.equal(result.status,shouldFail?1:0,result.stdout+result.stderr);
      if(shouldFail) rejected++;else accepted++;
      if(throughCli) {
        const checked=invoke(project,['check','--run',begun.run,'--summary'],1);
        assert.equal(checked.verification.length,config.verification.length);
        assert.equal(checked.verification[0].status,'failed');
        assert(checked.findings.some(item=>item.rule==='VERIFICATION_FAILED'));
        assert.deepEqual(checked.errors,[]);
      }
    });
  }
  assert.equal(rejected,7);assert.equal(accepted,9);
  // Historical scores stay tied to their frozen acceptance, not today's tests.
  assert.equal(report.functionalSummary.control.behaviorCorrect,6);
  assert.equal(report.functionalSummary.terse.behaviorCorrect,6);
});
