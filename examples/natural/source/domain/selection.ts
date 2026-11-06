import type {Order} from '../orders.ts';

// Customer visibility is separate from serialization and delivery transport.
export function selectCustomerOrders(orders: readonly Order[], ownerId: string, status?: Order['status']): Order[] {
  if (!ownerId) throw new Error('ownerId is required');
  return orders.filter(order => order.ownerId === ownerId && (status === undefined || order.status === status));
}
