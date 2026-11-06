import type {Order} from '../orders.ts';

export const ORDER_HEADER = 'id,customer,total,status';

export function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// Shared order record: customer quoting, finite nonnegative totals and precision.
export function orderRecord(order: Order): string {
  if (!Number.isFinite(order.total) || order.total < 0) {
    throw new Error(`Invalid total for ${order.id}`);
  }
  const customer = csvCell(order.customer);
  const amount = order.total.toFixed(2);
  const fields = [order.id, customer, amount, order.status];
  return fields.join(',');
}

export function renderOrderCsv(orders: readonly Order[]): string {
  const records: string[] = [];
  for (const order of orders) records.push(orderRecord(order));
  return [ORDER_HEADER, ...records].join('\n');
}
