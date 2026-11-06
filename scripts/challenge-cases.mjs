import {cases} from './evaluation-cases.mjs';

const modify = cases.find(item => item.id === 'modify');
const deletion = cases.find(item => item.id === 'delete');
const existing = {path: 'src/orders.ts', symbol: 'exportOrders'};
// Seeded repairs are separate from naturally authored implementations. Apply only
// AFTER begin, otherwise historical-pair suppression would hide the known copy.
export const challenges = [
  {
    id: 'rewrite-resume', mode: 'seeded', candidate: existing,
    task: 'Finish the uncommitted paid-order download feature. Preserve defaults, owner isolation, amount validation and CSV encoding. Consolidate overlapping export responsibilities without losing the paid API or changing tests.',
    acceptance: 'examples/evaluation/modify.test.mjs',
    seed: modify.variants.find(item => item.id === 'rewritten-copy').edit,
    preflightPass: true, targetRules: ['POSSIBLE_DUPLICATION'],
  },
  {
    id: 'cleanup-resume', mode: 'seeded', candidate: existing,
    task: 'Finish the uncommitted migration away from src/legacy.ts. Retire that implementation and migrate every caller to the current exporter, preserving the download API and CSV behavior.',
    acceptance: 'examples/evaluation/delete.test.mjs', setup: deletion.setup,
    seed: deletion.variants.find(item => item.id === 'retained').edit,
    remove: deletion.remove, preflightPass: true, targetRules: ['REMOVAL_REMAINS', 'REMOVAL_REFERENCE_REMAINS'],
  },
  {
    id: 'stream-paid', mode: 'natural', candidate: existing,
    task: 'Add async streamPaidOrders(orders, ownerId, emit) in src/stream.ts. Await emit once for the CSV header then once per paid order visible to the owner, in input order, with backpressure. Retain customer quoting (including embedded newlines), two-decimal amounts and finite nonnegative amount validation. Reject an empty owner before emitting anything. Preserve exportOrders and downloadOrders, immutable inputs and a single owner for shared export rules; do not split a complete CSV by newline.',
    acceptance: 'examples/challenge/stream-paid.test.mjs', preflightPass: false,
    targetRules: ['POSSIBLE_DUPLICATION', 'NEW_DUPLICATION'],
  },
  {
    id: 'cleanup-indirect', mode: 'natural', candidate: existing,
    task: 'Retire src/legacy.ts and move every consumer to the current exporter. Preserve downloadOrders and the readArchiveCsv API, including imports through the providers barrel. Do not leave an obsolete implementation or dangling reference just because the download tests pass.',
    acceptance: 'examples/evaluation/delete.test.mjs', remove: deletion.remove,
    setup: p => {
      deletion.setup(p);
      p.write('providers.ts', "export {exportLegacyOrders as archiveExporter} from './legacy.ts';\n");
      p.write('archive.ts', "import {archiveExporter} from './providers.ts';\nimport type {Order} from './orders.ts';\nexport function readArchiveCsv(orders: Order[], ownerId: string) { return archiveExporter(orders, ownerId); }\n");
    },
    preflightPass: true, targetRules: ['REMOVAL_REMAINS', 'REMOVAL_REFERENCE_REMAINS'],
  },
];
