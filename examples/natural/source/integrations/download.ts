import * as billing from '../legacy/billing.ts';
import type {Order} from '../orders.ts';

export function downloadBilling(orders: readonly Order[], ownerId: string, paidOnly = false) {
  return billing.createBillingCsv(orders, ownerId, paidOnly);
}
