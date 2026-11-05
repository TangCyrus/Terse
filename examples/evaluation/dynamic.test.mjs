import assert from 'node:assert/strict';
import test from 'node:test';
import { loadExporter } from '../src/plugin.ts';

test('dynamic adapter selects a current exporter at runtime', async () => {
  const selected = await loadExporter('orders');
  assert.equal(selected.exportOrders([], 'team'), 'id,customer,total,status');
});
