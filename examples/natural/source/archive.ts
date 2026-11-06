import {archiveExporter} from './providers.ts';
import type {Order} from './orders.ts';

export function readArchiveCsv(orders: readonly Order[], ownerId: string): string {
  return archiveExporter(orders, ownerId);
}
