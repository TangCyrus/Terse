import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueNotification } from '../src/notifications.ts';

test('new queue responsibility validates, deduplicates and preserves input', () => {
  const pending = [{ id: 'existing', to: 'a@example.com', message: 'old' }];
  const item = { id: 'new', to: 'b@example.com', message: 'ready' };
  const result = enqueueNotification(pending, item);
  assert.deepEqual(result, [...pending, item]);
  assert.equal(pending.length, 1);
  assert.notEqual(result[1], item);
  assert.deepEqual(enqueueNotification(result, { ...item, message: 'retry' }), result);
  for (const invalid of [{ ...item, id: '' }, { ...item, to: '' }, { ...item, message: '' }]) {
    assert.throws(() => enqueueNotification(pending, invalid), /notification/);
  }
});
