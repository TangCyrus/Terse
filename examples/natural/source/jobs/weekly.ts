import {createBillingCsv as build} from '../legacy/billing.ts';
import type {Order} from '../orders.ts';

export function weeklyDigest(orders: readonly Order[], ownerId: string) {
  return {kind: 'weekly', csv: build(orders, ownerId, true)};
}
