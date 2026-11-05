// Authored tasks and independent behavioral tests; no model or semantic oracle is simulated.
const signature = 'export function exportOrders(orders: Order[], ownerId: string): string {';
const extended = "export function exportOrders(orders: Order[], ownerId: string, status?: 'paid'): string {";
const legacyRoute = source => source.replace('exportOrders, type Order', 'exportLegacyOrders as exportOrders, type Order').replace("'./orders.ts'", "'./legacy.ts'");
const setupLegacy = p => {
  p.write('legacy.ts', p.read('orders.ts').replace('function exportOrders', 'function exportLegacyOrders'));
  p.write('routes.ts', legacyRoute(p.read('routes.ts')));
};
const migrate = p => p.write('routes.ts', p.read('routes.ts').replace('exportLegacyOrders as exportOrders', 'exportOrders').replace("'./legacy.ts'", "'./orders.ts'"));
const variant = (id, strategy, status, duplicates, rules, verification, edit) => ({ id, strategy, expected: { status, duplicates, rules, verification }, edit });

export const cases = [
  {
    id: 'modify', task: 'Add a paid filter to the download route while preserving defaults, permissions and CSV encoding.',
    query: 'exportOrders downloadOrders', candidate: { path: 'src/orders.ts', symbol: 'exportOrders' },
    rationale: 'Payment selection belongs to the existing order export responsibility.',
    variants: [
      variant('copy', 'new', 'needs-review', true, ['NEW_DUPLICATION'], 'passed', p => {
        p.write('paid.ts', p.read('orders.ts').replace('function exportOrders', 'function exportPaidOrders')
          .replace('order.ownerId === ownerId);', "order.ownerId === ownerId && order.status === 'paid');"));
        p.write('routes.ts', "import { exportPaidOrders } from './paid.ts';\n" + p.read('routes.ts')
          .replace('return exportOrders(orders, ownerId);', "return status === 'paid' ? exportPaidOrders(orders, ownerId) : exportOrders(orders, ownerId);"));
      }),
      {...variant('rewritten-copy', 'new', 'pass', false, [], 'passed', p => {
        p.write('paid.ts', `import type {Order} from './orders.ts';
export function exportPaidOrders(input: Order[], user: string): string {
  if (user.length === 0) throw Error('ownerId is required');
  let csv = 'id,customer,total,status';
  for (const item of input) {
    if (item.ownerId !== user || item.status !== 'paid') continue;
    if (item.total < 0 || !Number.isFinite(item.total)) throw Error('Invalid total');
    const escaped = '"' + item.customer.split('"').join('""') + '"';
    csv += '\\n' + item.id + ',' + escaped + ',' + Number(item.total).toFixed(2) + ',' + item.status;
  }
  return csv;
}
`);
        p.write('routes.ts', "import {exportPaidOrders} from './paid.ts';\n" + p.read('routes.ts')
          .replace('return exportOrders(orders, ownerId);', "return status === 'paid' ? exportPaidOrders(orders, ownerId) : exportOrders(orders, ownerId);"));
      }), review: {functional: false, reason: 'A second owner filter, amount validator and CSV encoder uses different tokens; no token finding does not prove responsibility reuse.'}},
      variant('reuse', 'modify', 'pass', false, [], 'passed', p => {
        p.write('orders.ts', p.read('orders.ts').replace(signature, extended)
          .replace('order.ownerId === ownerId);', 'order.ownerId === ownerId && (status === undefined || order.status === status));'));
        p.write('routes.ts', p.read('routes.ts').replace('exportOrders(orders, ownerId)', 'exportOrders(orders, ownerId, status)'));
      }),
    ],
  },
  {
    id: 'delete', task: 'Retire src/legacy.ts and migrate the download caller without changing exported CSV behavior.',
    query: 'exportOrders exportLegacyOrders', candidate: { path: 'src/orders.ts', symbol: 'exportOrders' },
    rationale: 'The current exporter replaces the legacy copy; the old file must be removed and consumers migrated.',
    remove: [{ path: 'src/legacy.ts' }], setup: setupLegacy,
    variants: [
      variant('retained', 'refactor', 'fail', false, ['REMOVAL_REMAINS'], 'passed', migrate),
      variant('dangling', 'refactor', 'fail', false, ['REMOVAL_REFERENCE_REMAINS', 'VERIFICATION_FAILED'], 'failed', p => p.remove('legacy.ts')),
      variant('cleanup', 'refactor', 'pass', false, [], 'passed', p => { migrate(p); p.remove('legacy.ts'); }),
    ],
  },
  {
    id: 'refactor', task: 'Move CSV implementation into reporting.ts while preserving the orders.ts public facade and download behavior.',
    query: 'exportOrders downloadOrders', candidate: { path: 'src/orders.ts', symbol: 'exportOrders' },
    rationale: 'Relocate the existing implementation and retain a compatibility export rather than keeping two bodies.',
    variants: [
      variant('copy', 'refactor', 'needs-review', true, ['NEW_DUPLICATION'], 'passed', p => {
        p.write('reporting.ts', p.read('orders.ts'));
        p.write('routes.ts', p.read('routes.ts').replace("'./orders.ts'", "'./reporting.ts'"));
      }),
      variant('reuse', 'refactor', 'pass', false, [], 'passed', p => {
        const original = p.read('orders.ts');
        p.write('reporting.ts', original);
        p.write('orders.ts', original.slice(0, original.indexOf('// 订单导出')) + "export { exportOrders } from './reporting.ts';\n");
        p.write('routes.ts', p.read('routes.ts').replace("'./orders.ts'", "'./reporting.ts'"));
      }),
    ],
  },
  {
    id: 'add', task: 'Add an immutable, idempotent notification queue; order exporting has no suitable implementation.',
    query: 'enqueueNotification', rationale: 'Queue identity, retries and message validation are independent of CSV export.',
    variants: [variant('new', 'new', 'pass', false, [], 'passed', p => p.write('notifications.ts', `
interface Notification { id: string; to: string; message: string }
export function enqueueNotification(pending: Notification[], item: Notification): Notification[] {
  if (!item.id.trim() || !item.to.trim() || !item.message.trim()) throw new Error('Invalid notification');
  if (pending.some(entry => entry.id === item.id)) return [...pending];
  return [...pending, { ...item }];
}
`.trimStart()))],
  },
  {
    id: 'independent', task: 'Add an auditor-only, cross-owner export with an independent authorization contract.',
    query: 'exportOrders', candidate: { path: 'src/orders.ts', symbol: 'exportOrders' },
    rationale: 'Auditors may see all owners; the customer exporter must retain owner isolation. Token similarity needs semantic review, not automatic merging.',
    variants: [variant('review', 'new', 'needs-review', true, ['NEW_DUPLICATION'], 'passed', p => {
      p.write('audit.ts', p.read('orders.ts').replace(signature, 'export function exportAuditOrders(orders: Order[], isAuditor: boolean): string {')
        .replace("if (!ownerId) throw new Error('ownerId is required');", "if (!isAuditor) throw new Error('auditor permission is required');")
        .replace('orders.filter(order => order.ownerId === ownerId)', 'orders'));
    })],
  },
  {
    id: 'dynamic', task: 'Remove the legacy exporter but retain a runtime-selected plugin loader for current exporters.',
    query: 'exportOrders exportLegacyOrders', candidate: { path: 'src/orders.ts', symbol: 'exportOrders' },
    rationale: 'Runtime selection passes behavior tests but cannot prove all dynamic consumers have migrated.',
    setup: p => {
      setupLegacy(p);
      p.write('plugin.ts', "import * as exporter from './legacy.ts';\nexport async function loadExporter(name: string) { return exporter; }\n");
    },
    remove: [{ path: 'src/legacy.ts' }],
    variants: [variant('review', 'refactor', 'needs-review', false, ['REMOVAL_REFERENCE_UNRESOLVED'], 'passed', p => {
      migrate(p); p.remove('legacy.ts');
      p.write('plugin.ts', 'export async function loadExporter(name: string) { return import(`./${name}.ts`); }\n');
    })],
  },
];
