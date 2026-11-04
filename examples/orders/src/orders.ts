export interface Order {
  id: string;
  ownerId: string;
  customer: string;
  total: number;
  status: 'paid' | 'pending';
}

// 订单导出：权限过滤、金额校验、CSV 转义共用同一条处理路径。
export function exportOrders(orders: Order[], ownerId: string): string {
  if (!ownerId) throw new Error('ownerId is required');
  const visible = orders.filter(order => order.ownerId === ownerId);
  const rows = visible.map(order => {
    if (!Number.isFinite(order.total) || order.total < 0) {
      throw new Error(`Invalid total for ${order.id}`);
    }
    const customer = `"${order.customer.replaceAll('"', '""')}"`;
    return [order.id, customer, order.total.toFixed(2), order.status].join(',');
  });
  return ['id,customer,total,status', ...rows].join('\n');
}
