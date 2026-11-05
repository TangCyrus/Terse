import { exportOrders, type Order } from './orders.ts';

// Application entry point: preserve the public contract while changing its implementation.
export function downloadOrders(orders: Order[], ownerId: string, status?: 'paid'): string {
  return exportOrders(orders, ownerId);
}
