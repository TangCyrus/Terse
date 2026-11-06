import {createBillingCsv} from '../legacy/billing.ts';
import type {Order} from '../orders.ts';

// A separate integration entry point; not imported by the download route.
export function manualDigest(orders: readonly Order[], ownerId: string) {
  return {kind: 'manual', csv: createBillingCsv(orders, ownerId)};
}
