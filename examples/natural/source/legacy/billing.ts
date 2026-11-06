import {exportOrders, type Order} from '../orders.ts';

// Supported historical API; retiring it is a new migration request, not a defect.
export function createBillingCsv(orders: readonly Order[], ownerId: string, paidOnly = false): string {
  const selected = paidOnly ? orders.filter(order => order.status === 'paid') : orders;
  return exportOrders(selected, ownerId);
}
