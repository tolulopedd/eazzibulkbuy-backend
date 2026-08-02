export const DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME = '__SYSTEM_DISCOUNT_ORDER__';
export const DISCOUNT_ORDER_SYSTEM_BATCH_NUMBER = 'ADM';
export const DISCOUNT_ORDER_SYSTEM_LOCATION = 'Admin discount orders';

export function isSystemDiscountSalesItemName(name) {
  return String(name || '').trim() === DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME;
}
