import {selectCustomerOrders} from './domain/selection.ts';
import {renderOrderCsv} from './reporting/csv.ts';

export interface Order {
  id: string;
  ownerId: string;
  customer: string;
  total: number;
  status: 'paid' | 'pending';
}

export function exportOrders(orders: readonly Order[], ownerId: string): string {
  return renderOrderCsv(selectCustomerOrders(orders, ownerId));
}
