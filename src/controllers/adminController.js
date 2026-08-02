import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { formatDisplayOrderReference } from '../utils/orderReference.js';
import {
  createAdminDiscountOrder,
  getManualTransferProofViewUrlByReference,
  markOrderPaidByReference,
  resendOrderPaymentConfirmationByReference,
} from '../services/orderService.js';
import {
  buildStoredTransferProof,
  createTransferProofUploadTarget,
  isValidReceiptObjectKey,
} from '../services/storageService.js';
import {
  sendOrderFulfillmentCompletedEmail,
  sendOrderPaymentResolutionEmail,
  sendOrderReadyNoticeEmail,
} from '../services/emailService.js';
import { sendWhatsAppTextMessage } from '../services/messagingService.js';
import { retrieveStripePaymentIntent } from '../services/paymentService.js';
import { DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME } from '../constants/systemSalesItems.js';

function isOrderPaidLike(order) {
  return (
    order.paymentStatus === 'PAID' ||
    order.paymentStatus === 'SUCCEEDED' ||
    order.status === 'CONFIRMED' ||
    order.status === 'PAID' ||
    Boolean(order.paidAt)
  );
}

function escapeCsv(value) {
  const stringValue = String(value ?? '');
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function isSameOrAfter(date, boundary) {
  if (!date || !boundary) {
    return false;
  }
  return date.getTime() >= boundary.getTime();
}

function getFulfillmentStatusLabel(status) {
  if (!status) {
    return 'Unknown';
  }

  return status
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getDisplayPaymentStatus(order) {
  const resolutionAction = order?.payment?.providerPayloadJson?.adminResolution?.action;
  if (resolutionAction === 'REFUNDED' || resolutionAction === 'CANCELLED') {
    return resolutionAction;
  }

  if (order?.paymentMethod === 'STRIPE_CARD') {
    return isOrderPaidLike(order) ? 'PAID' : 'PENDING_PAYMENT';
  }

  if (order?.paymentMethod === 'INTERAC_E_TRANSFER') {
    if (isOrderPaidLike(order)) return 'PAID';
    if (order?.paymentStatus === 'PENDING_REVIEW') return 'PENDING_REVIEW';
    return 'PENDING_PAYMENT';
  }

  return order?.paymentStatus || 'UNKNOWN';
}

function parseOrderNotes(notes) {
  if (!notes) {
    return null;
  }

  try {
    return JSON.parse(notes);
  } catch {
    return null;
  }
}

function formatPickupNoticeStatus(value) {
  return value?.sentAt ? 'SENT' : 'NOT_SENT';
}

function buildFallbackSnapshotItem(order) {
  return {
    salesItemId: order.salesItem?.id || order.salesItemId,
    name: order.salesItem?.name || 'Order items',
    quantity: order.quantity,
    lineTotal: order.subtotal || order.totalAmount,
    fulfillmentMethod: order.fulfillmentMethod,
    fulfillmentStatus: order.fulfillmentStatus,
    batchNumber: order.salesItem?.batchNumber || '',
    location: order.salesItem?.pickupInstructions || '',
    saleType: order.salesItem?.saleType || 'NORMAL_SALE',
    bundleItems: [],
  };
}

function formatPickupNoticeItemSummary(items = []) {
  return items
    .map((item) => `${item.name} x${item.quantity}`)
    .join(', ');
}

function buildPickupNoticeMessageText({
  firstName,
  displayOrderReference,
  itemsSummary,
  fulfillmentMethod,
  address,
  readyDate,
  timeWindow,
  contactName,
  contactPhone,
  note,
}) {
  const isDelivery = fulfillmentMethod === 'DELIVERY';

  return [
    `Hello ${firstName},`,
    '',
    isDelivery
      ? 'Your paid order is now ready for delivery coordination.'
      : 'Your paid order is now ready for pickup.',
    '',
    `Order reference: ${displayOrderReference}`,
    `Items: ${itemsSummary}`,
    `${isDelivery ? 'Dispatch / meeting address' : 'Pickup address'}: ${address}`,
    `Date: ${readyDate}`,
    `Time: ${timeWindow}`,
    contactName ? `Contact name: ${contactName}` : null,
    contactPhone ? `Contact phone: ${contactPhone}` : null,
    note ? `Instructions: ${note}` : null,
    '',
    'Regards,',
    'EazziBulkBuy.',
  ].filter(Boolean).join('\n');
}

function getOrderSnapshotItems(order) {
  const snapshot = parseOrderNotes(order.notes);
  return Array.isArray(snapshot?.items) ? snapshot.items : [];
}

function getDiscountOrderMeta(order) {
  const snapshot = parseOrderNotes(order.notes);
  return snapshot?.meta?.discountOrder ? snapshot.meta : null;
}

function getOrderSalesItemIds(order) {
  const snapshotItems = getOrderSnapshotItems(order);
  const ids = snapshotItems
    .map((item) => item?.salesItemId)
    .filter(Boolean);

  if (!ids.length && order.salesItemId) {
    ids.push(order.salesItemId);
  }

  return [...new Set(ids)];
}

function getOrderBatchNumbers(order) {
  const snapshotItems = getOrderSnapshotItems(order);
  const batchNumbers = snapshotItems
    .map((item) => item?.batchNumber)
    .filter(Boolean);

  if (!batchNumbers.length && order.salesItem?.batchNumber) {
    batchNumbers.push(order.salesItem.batchNumber);
  }

  return [...new Set(batchNumbers)];
}

function includesInsensitive(value, query) {
  return String(value || '').toLowerCase().includes(String(query || '').toLowerCase());
}

function parseBatchNumberFilters(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function orderMatchesBatchNumber(order, batchNumber) {
  const batchFilters = parseBatchNumberFilters(batchNumber);

  if (!batchFilters.length) {
    return true;
  }

  return getOrderBatchNumbers(order).some((value) => batchFilters.some((batch) => includesInsensitive(value, batch)));
}

function orderMatchesSalesItemId(order, salesItemId) {
  if (!salesItemId) {
    return true;
  }

  return getOrderSalesItemIds(order).includes(salesItemId);
}

function orderMatchesTextQuery(order, query) {
  if (!query) {
    return true;
  }

  const fulfillmentItems = normalizeFulfillmentItems(order);
  const haystack = [
    order.orderReference,
    formatDisplayOrderReference({
      createdAt: order.createdAt,
      batchNumber: order.salesItem?.batchNumber,
      orderSequence: order.orderSequence,
    }),
    order.user?.name,
    order.user?.email,
    order.user?.phone,
    order.salesItem?.name,
    ...getOrderBatchNumbers(order),
    ...fulfillmentItems.map((item) => item.name),
    ...fulfillmentItems.map((item) => item.bundleName),
  ];

  return haystack.some((value) => includesInsensitive(value, query));
}

function orderMatchesFulfillmentFilters(order, { fulfillmentMethod, fulfillmentStatus }) {
  if (!fulfillmentMethod && !fulfillmentStatus) {
    return true;
  }

  const fulfillmentItems = normalizeFulfillmentItems(order);
  return fulfillmentItems.some((item) => {
    if (fulfillmentMethod && item.fulfillmentMethod !== fulfillmentMethod) {
      return false;
    }

    if (fulfillmentStatus && item.fulfillmentStatus !== fulfillmentStatus) {
      return false;
    }

    return true;
  });
}

function orderMatchesDateRange(order, { startDate, endDate }) {
  if (!startDate && !endDate) {
    return true;
  }

  const effectiveDate = order.paidAt || order.createdAt;
  if (!effectiveDate) {
    return false;
  }

  const effectiveTime = new Date(effectiveDate).getTime();
  if (Number.isNaN(effectiveTime)) {
    return false;
  }

  if (startDate) {
    const startTime = new Date(startDate).getTime();
    if (!Number.isNaN(startTime) && effectiveTime < startTime) {
      return false;
    }
  }

  if (endDate) {
    const endTime = new Date(endDate).getTime();
    if (!Number.isNaN(endTime) && effectiveTime > endTime) {
      return false;
    }
  }

  return true;
}

function getDefaultItemFulfillmentStatus(order, item = {}) {
  if (item.fulfillmentStatus) {
    return item.fulfillmentStatus;
  }
  const fulfillmentMethod = item.fulfillmentMethod || order.fulfillmentMethod;
  return fulfillmentMethod === 'DELIVERY' ? 'PENDING_DELIVERY' : 'PENDING_PICKUP';
}

function buildBundleFulfillmentChildren(order, item) {
  const lineFulfillmentMethod = item.fulfillmentMethod || order.fulfillmentMethod;
  const savedChildren = Array.isArray(item.fulfillmentChildren) ? item.fulfillmentChildren : [];

  if (savedChildren.length) {
    return savedChildren.map((child) => ({
      ...child,
      fulfillmentMethod: child.fulfillmentMethod || lineFulfillmentMethod,
      fulfillmentStatus: child.fulfillmentStatus || getDefaultItemFulfillmentStatus(order, child),
    }));
  }

  const bundleItems = Array.isArray(item.bundleItems) ? item.bundleItems : [];
  return bundleItems.map((bundleItem) => ({
    name: bundleItem.name,
      quantity: (Number(bundleItem.quantity) || 0) * (Number(item.quantity) || 0),
      lineTotal: null,
      bundleLineTotal: item.lineTotal ?? null,
      fulfillmentMethod: lineFulfillmentMethod,
      fulfillmentStatus: getDefaultItemFulfillmentStatus(order, { fulfillmentMethod: lineFulfillmentMethod }),
      parentBundleName: item.name,
  }));
}

function normalizeFulfillmentItems(order) {
  const snapshot = parseOrderNotes(order.notes);
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

  if (!items.length) {
    return [
      {
        itemIndex: 0,
        salesItemId: order.salesItem?.id || order.salesItemId,
        name: order.salesItem?.name || 'Order items',
        quantity: order.quantity,
        lineTotal: order.subtotal || order.totalAmount,
        fulfillmentMethod: order.fulfillmentMethod,
        fulfillmentStatus: order.fulfillmentStatus,
        fulfillmentStatusLabel: getFulfillmentStatusLabel(order.fulfillmentStatus),
        batchNumber: order.salesItem?.batchNumber || '',
        location: order.salesItem?.pickupInstructions || '',
        pickupNotice: null,
      },
    ];
  }

  const flattenedItems = [];
  let itemIndex = 0;

  items.forEach((item, sourceIndex) => {
    const fulfillmentMethod = item.fulfillmentMethod || order.fulfillmentMethod;
    const isBundleSale = item.saleType === 'BUNDLE_DISCOUNTED_SALE';
    const bundleChildren = isBundleSale ? buildBundleFulfillmentChildren(order, item) : [];

    if (isBundleSale && bundleChildren.length) {
      bundleChildren.forEach((bundleChild, bundleItemIndex) => {
        const fulfillmentStatus = bundleChild.fulfillmentStatus || getDefaultItemFulfillmentStatus(order, bundleChild);
        flattenedItems.push({
          itemIndex: itemIndex++,
          sourceIndex,
          bundleItemIndex,
          salesItemId: item.salesItemId,
          name: bundleChild.name,
          quantity: bundleChild.quantity,
          lineTotal: bundleChild.lineTotal ?? null,
          bundleLineTotal: bundleChild.bundleLineTotal ?? item.lineTotal ?? null,
          fulfillmentMethod: bundleChild.fulfillmentMethod || fulfillmentMethod,
          fulfillmentStatus,
          fulfillmentStatusLabel: getFulfillmentStatusLabel(fulfillmentStatus),
          batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
          location: item.location || order.salesItem?.pickupInstructions || '',
          saleType: item.saleType || null,
          bundleItems: [],
          isBundleComponent: true,
          bundleName: bundleChild.parentBundleName || item.name,
          pickupNotice: bundleChild.pickupNotice || null,
        });
      });
      return;
    }

    const fulfillmentStatus = getDefaultItemFulfillmentStatus(order, item);
    flattenedItems.push({
      itemIndex: itemIndex++,
      sourceIndex,
      salesItemId: item.salesItemId,
      name: item.name,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
      bundleLineTotal: null,
      fulfillmentMethod,
      fulfillmentStatus,
      fulfillmentStatusLabel: getFulfillmentStatusLabel(fulfillmentStatus),
      batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
      location: item.location || order.salesItem?.pickupInstructions || '',
      saleType: item.saleType || null,
      bundleItems: Array.isArray(item.bundleItems) ? item.bundleItems : [],
      isBundleComponent: false,
      bundleName: null,
      pickupNotice: item.pickupNotice || null,
    });
  });

  return flattenedItems;
}

function orderItemMatchesReportFilters(item, query) {
  if (!item) {
    return false;
  }

  if (query.salesItemId && item.salesItemId !== query.salesItemId) {
    return false;
  }

  const batchFilters = parseBatchNumberFilters(query.batchNumber);
  if (batchFilters.length && !batchFilters.some((batch) => includesInsensitive(item.batchNumber, batch))) {
    return false;
  }

  if (query.fulfillmentMethod && item.fulfillmentMethod !== query.fulfillmentMethod) {
    return false;
  }

  if (query.fulfillmentStatus && item.fulfillmentStatus !== query.fulfillmentStatus) {
    return false;
  }

  return true;
}

function sumReportItemAmounts(items) {
  const countedBundleSources = new Set();

  return items.reduce((sum, item) => {
    if (item.isBundleComponent) {
      const bundleKey = `${item.salesItemId || 'bundle'}:${item.sourceIndex ?? item.itemIndex}`;
      if (countedBundleSources.has(bundleKey)) {
        return sum;
      }

      countedBundleSources.add(bundleKey);
      return sum + (item.bundleLineTotal ?? 0);
    }

    return sum + (item.lineTotal || 0);
  }, 0);
}

function getOrderBatchSummary(order) {
  const batches = [...new Set(normalizeFulfillmentItems(order).map((item) => item.batchNumber).filter(Boolean))];
  return batches.join(', ');
}

function getOrderItemSummary(order) {
  const groupedItems = new Map();

  normalizeFulfillmentItems(order).forEach((item) => {
    const itemName = item?.name || 'Order items';
    const quantity = Number(item?.quantity) || 0;
    groupedItems.set(itemName, (groupedItems.get(itemName) || 0) + quantity);
  });

  return [...groupedItems.entries()]
    .map(([name, quantity]) => `${name} x${quantity}`)
    .join(' + ');
}

function deriveAggregateFulfillmentStatus(order, fulfillmentItems) {
  const methods = [...new Set(fulfillmentItems.map((item) => item.fulfillmentMethod || order.fulfillmentMethod))];
  const isDelivery = methods.every((method) => method === 'DELIVERY');

  if (isDelivery) {
    return fulfillmentItems.every((item) => item.fulfillmentStatus === 'DELIVERED') ? 'DELIVERED' : 'PENDING_DELIVERY';
  }

  return fulfillmentItems.every((item) => item.fulfillmentStatus === 'PICKED_UP') ? 'PICKED_UP' : 'PENDING_PICKUP';
}

function buildPaidBatchSalesComparison(paidOrders) {
  const batchMap = new Map();

  for (const order of paidOrders) {
    const paidDate = order.paidAt || order.createdAt;

    for (const item of order.itemDetails || []) {
      const batchNumber = item.batchNumber || order.salesItem?.batchNumber || '';
      if (!batchNumber) {
        continue;
      }

      const saleType = item.saleType || order.salesItem?.saleType || 'NORMAL_SALE';
      const quantity = Number(item.quantity) || 0;
      const existing = batchMap.get(batchNumber) || {
        batchNumber,
        latestPaidAt: paidDate,
        normalPaidItems: 0,
        bundlePaidItems: 0,
      };

      if (!existing.latestPaidAt || (paidDate && paidDate > existing.latestPaidAt)) {
        existing.latestPaidAt = paidDate;
      }

      if (saleType === 'BUNDLE_DISCOUNTED_SALE') {
        existing.bundlePaidItems += quantity;
      } else {
        existing.normalPaidItems += quantity;
      }

      batchMap.set(batchNumber, existing);
    }
  }

  return Array.from(batchMap.values())
    .sort((a, b) => new Date(b.latestPaidAt).getTime() - new Date(a.latestPaidAt).getTime())
    .slice(0, 5)
    .sort((a, b) => new Date(a.latestPaidAt).getTime() - new Date(b.latestPaidAt).getTime())
    .map((entry) => ({
      batchNumber: entry.batchNumber,
      normalPaidItems: entry.normalPaidItems,
      bundlePaidItems: entry.bundlePaidItems,
      latestPaidAt: entry.latestPaidAt,
    }));
}

const batchNumberSchema = z
  .string()
  .trim()
  .length(3, 'Batch number must be exactly 3 characters.')
  .regex(/^[A-Za-z0-9]{3}$/, 'Batch number must contain only letters and numbers.')
  .transform((value) => value.toUpperCase());

const bundleItemSchema = z.object({
  name: z.string().trim().min(2).max(120),
  quantity: z.number().int().min(1).max(999),
});

const salesItemTypeSchema = z.enum(['NORMAL_SALE', 'BUNDLE_DISCOUNTED_SALE']);

const createSalesItemSchema = z.object({
  name: z.string().min(2).max(120),
  saleType: salesItemTypeSchema.default('NORMAL_SALE'),
  batchNumber: batchNumberSchema,
  pricePerUnit: z.number().int().positive(),
  closingDate: z.string().datetime(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  pickupInstructions: z.string().max(500).optional(),
  description: z.string().max(500).optional(),
  bundleItems: z.array(bundleItemSchema).optional(),
  deliveryEnabled: z.boolean().optional(),
  deliveryBaseRangeMax: z.number().int().min(1).optional(),
  deliveryBasePrice: z.number().int().min(0).optional(),
  deliveryAdditionalUnitPrice: z.number().int().min(0).optional(),
}).superRefine((payload, ctx) => {
  if (payload.saleType === 'BUNDLE_DISCOUNTED_SALE') {
    if (!payload.bundleItems || payload.bundleItems.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bundleItems'],
        message: 'Bundle discounted sales require at least two bundled items.',
      });
    }
  }
});

const updateSalesItemSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  saleType: salesItemTypeSchema.optional(),
  batchNumber: batchNumberSchema.optional(),
  pricePerUnit: z.number().int().positive().optional(),
  closingDate: z.string().datetime().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  pickupInstructions: z.string().max(500).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  bundleItems: z.array(bundleItemSchema).nullable().optional(),
  deliveryEnabled: z.boolean().optional(),
  deliveryBaseRangeMax: z.number().int().min(1).optional(),
  deliveryBasePrice: z.number().int().min(0).optional(),
  deliveryAdditionalUnitPrice: z.number().int().min(0).optional(),
}).superRefine((payload, ctx) => {
  const bundleMode = payload.saleType === 'BUNDLE_DISCOUNTED_SALE'
    || (payload.saleType === undefined && payload.bundleItems !== undefined && payload.bundleItems !== null);
  if (bundleMode && payload.bundleItems && payload.bundleItems.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bundleItems'],
      message: 'Bundle discounted sales require at least two bundled items.',
    });
  }
});

const listSalesItemsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  sortBy: z.enum(['createdAt', 'closingDate', 'name', 'batchNumber', 'pricePerUnit', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const listCustomersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(3).optional(),
  hasOrders: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'email']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updateCustomerSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(255).nullable().optional(),
  isActive: z.boolean(),
});

const createAdminCustomerSchema = z.object({
  title: z.enum(['Mr', 'Mrs', 'Miss']).optional(),
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  phone: z.string().trim().regex(/^\d{10}$/, 'Phone number must be exactly 10 digits.'),
  address: z.string().trim().min(5).max(255),
  city: z.string().trim().min(2).max(120),
  province: z.string().trim().min(2).max(120),
  postalCode: z.string().trim().min(3).max(20),
});

const reviewCustomerUpdateRequestSchema = z.object({
  requestId: z.string().uuid(),
});

const discountOrderItemSchema = z.object({
  sourceType: z.enum(['SALES_EVENT', 'CUSTOM']),
  salesItemId: z.string().uuid().optional(),
  customName: z.string().trim().max(120).optional(),
  customDescription: z.string().trim().max(500).optional(),
  customLocation: z.string().trim().max(255).optional(),
  quantity: z.number().int().min(1).max(500),
  discountedUnitPrice: z.number().int().positive(),
}).superRefine((item, ctx) => {
  if (item.sourceType === 'SALES_EVENT' && !item.salesItemId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['salesItemId'],
      message: 'Select a sales event item.',
    });
  }

  if (item.sourceType === 'CUSTOM' && (!item.customName || item.customName.trim().length < 2)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customName'],
      message: 'Enter the item name.',
    });
  }
});

const createDiscountOrderSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(discountOrderItemSchema).min(1).max(25),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).default('PICKUP'),
  paymentMethod: z.enum(['INTERAC_E_TRANSFER']).default('INTERAC_E_TRANSFER'),
  discountReason: z.string().trim().min(3).max(240),
  adminComment: z.string().trim().max(500).optional(),
}).superRefine((payload, ctx) => {
  const hasCustomItems = payload.items.some((item) => item.sourceType === 'CUSTOM');
  if (payload.fulfillmentMethod === 'DELIVERY' && hasCustomItems) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fulfillmentMethod'],
      message: 'Custom discount items currently support pickup only.',
    });
  }
});

const listDiscountOrdersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  paymentStatus: z
    .enum(['PENDING_PAYMENT', 'REQUIRES_ACTION', 'PENDING_REVIEW', 'SUCCEEDED', 'PAID', 'FAILED'])
    .optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const adminIncompleteOrderUploadSchema = z.object({
  orderReference: z.string().uuid(),
  fileName: z.string().trim().min(3).max(180),
  contentType: z.string().trim().regex(/^image\/[a-zA-Z0-9.+-]+$/),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
});

const adminIncompleteOrderReviewSchema = z.object({
  orderReference: z.string().uuid(),
  comment: z.string().trim().min(3).max(500),
  transferProof: z.object({
    fileName: z.string().trim().min(3).max(180),
    contentType: z.string().trim().regex(/^image\/[a-zA-Z0-9.+-]+$/),
    sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
    objectKey: z.string().trim().min(10).max(300),
  }),
});

const adminPaymentResolutionSchema = z.object({
  orderReference: z.string().uuid(),
  action: z.enum(['CANCELLED', 'REFUNDED']),
  comment: z.string().trim().min(3).max(500),
  notifyBuyer: z.boolean().default(false),
});

const listOrdersQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(120).optional(),
  paidOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  status: z
    .enum(['PENDING_PAYMENT', 'AWAITING_MANUAL_PAYMENT', 'PAID', 'CONFIRMED', 'CANCELLED'])
    .optional(),
  paymentStatus: z
    .enum(['PENDING_PAYMENT', 'REQUIRES_ACTION', 'PENDING_REVIEW', 'SUCCEEDED', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'])
    .optional(),
  paymentMethod: z
    .enum(['STRIPE_CARD', 'INTERAC_E_TRANSFER', 'MANUAL_BANK_TRANSFER', 'OTHER_CA_GATEWAY'])
    .optional(),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
  fulfillmentStatus: z.enum(['PENDING_PICKUP', 'PICKED_UP', 'PENDING_DELIVERY', 'DELIVERED']).optional(),
  sortBy: z.enum(['createdAt', 'paidAt', 'totalAmount', 'status', 'paymentStatus', 'fulfillmentStatus']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const adminReportsQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  salesItemId: z.string().uuid().optional(),
  batchNumber: z.string().trim().max(120).optional(),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
  fulfillmentStatus: z.enum(['PENDING_PICKUP', 'PICKED_UP', 'PENDING_DELIVERY', 'DELIVERED']).optional(),
  reportType: z
    .enum(['orderReady', 'supplierOrders', 'salesDetails'])
    .default('orderReady'),
});

const listPickupNoticesQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(120).optional(),
  location: z.string().trim().max(255).optional(),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
  noticeStatus: z.enum(['NOT_SENT', 'SENT']).optional(),
  sortBy: z.enum(['paidAt', 'createdAt', 'batchNumber', 'location', 'buyer']).default('paidAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

const sendPickupNoticesSchema = z.object({
  items: z.array(z.object({
    orderReference: z.string().uuid(),
    itemIndex: z.number().int().min(0),
  })).min(1).max(200),
  channels: z.array(z.enum(['EMAIL', 'WHATSAPP'])).min(1),
  address: z.string().trim().min(3).max(255),
  readyDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeWindow: z.string().trim().min(3).max(120),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  note: z.string().trim().max(500).optional(),
});

async function findConflictingActiveBatchNumber(batchNumber, excludeSalesItemId) {
  if (!batchNumber) {
    return null;
  }

  return prisma.salesItem.findFirst({
    where: {
      batchNumber,
      status: 'ACTIVE',
      closingDate: { gt: new Date() },
      ...(excludeSalesItemId ? { id: { not: excludeSalesItemId } } : {}),
    },
    select: {
      id: true,
      name: true,
      batchNumber: true,
    },
  });
}

export async function createSalesItemHandler(req, res, next) {
  try {
    const payload = createSalesItemSchema.parse(req.body);
    const conflictingItem = await findConflictingActiveBatchNumber(payload.batchNumber);

    if (conflictingItem) {
      return res.status(409).json({
        message: `Batch number ${payload.batchNumber} is already in use by an active sales event.`,
      });
    }

    const item = await prisma.salesItem.create({
      data: {
        name: payload.name,
        saleType: payload.saleType,
        batchNumber: payload.batchNumber,
        bundleItemsJson: payload.saleType === 'BUNDLE_DISCOUNTED_SALE' ? payload.bundleItems || [] : null,
        pricePerUnit: payload.pricePerUnit,
        closingDate: new Date(payload.closingDate),
        status: payload.status,
        pickupInstructions: payload.pickupInstructions,
        description: payload.description,
        deliveryEnabled: payload.deliveryEnabled ?? false,
        deliveryBaseRangeMax: payload.deliveryBaseRangeMax ?? 10,
        deliveryBasePrice: payload.deliveryBasePrice ?? 0,
        deliveryAdditionalUnitPrice: payload.deliveryAdditionalUnitPrice ?? 0,
      },
    });

    res.status(201).json(item);
  } catch (error) {
    next(error);
  }
}

export async function listSalesItemsHandler(req, res, next) {
  try {
    const query = listSalesItemsQuerySchema.parse(req.query);

    const where = {
      name: { not: DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME },
      ...(query.status ? { status: query.status } : {}),
      ...(query.batchNumber ? { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { batchNumber: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const skip = (query.page - 1) * query.limit;
    const take = query.limit;

    const [items, total, orders] = await Promise.all([
      prisma.salesItem.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        include: {
          _count: {
            select: {
              orders: true,
            },
          },
        },
        skip,
        take,
      }),
      prisma.salesItem.count({ where }),
      prisma.order.findMany({
        select: {
          salesItemId: true,
          notes: true,
        },
      }),
    ]);

    const targetItemIds = new Set(items.map((item) => item.id));
    const orderCountsBySalesItemId = new Map();

    for (const order of orders) {
      const relatedSalesItemIds = getOrderSalesItemIds(order).filter((salesItemId) => targetItemIds.has(salesItemId));

      for (const salesItemId of relatedSalesItemIds) {
        orderCountsBySalesItemId.set(salesItemId, (orderCountsBySalesItemId.get(salesItemId) || 0) + 1);
      }
    }

    const normalizedItems = items.map((item) => ({
      ...item,
      _count: {
        ...item._count,
        orders: orderCountsBySalesItemId.get(item.id) || 0,
      },
    }));

    res.json({
      items: normalizedItems,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error) {
    next(error);
  }
}

export async function updateSalesItemHandler(req, res, next) {
  try {
    const salesItemId = req.params.salesItemId;
    const payload = updateSalesItemSchema.parse(req.body);
    const existingItem = await prisma.salesItem.findUnique({
      where: { id: salesItemId },
    });

    if (!existingItem) {
      return res.status(404).json({ message: 'Sales item not found.' });
    }

    if (existingItem.status !== 'ACTIVE' || new Date() >= existingItem.closingDate) {
      return res.status(409).json({
        message: 'Inactive or expired sales cannot be edited.',
      });
    }

    const nextStatus = payload.status ?? existingItem.status;
    const nextBatchNumber = payload.batchNumber ?? existingItem.batchNumber;
    const willRemainActive = nextStatus === 'ACTIVE' && new Date(existingItem.closingDate) > new Date();

    if (willRemainActive) {
      const conflictingItem = await findConflictingActiveBatchNumber(nextBatchNumber, salesItemId);
      if (conflictingItem) {
        return res.status(409).json({
          message: `Batch number ${nextBatchNumber} is already in use by an active sales event.`,
        });
      }
    }

    const data = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.saleType !== undefined ? { saleType: payload.saleType } : {}),
      ...(payload.batchNumber !== undefined ? { batchNumber: payload.batchNumber } : {}),
      ...(payload.bundleItems !== undefined ? { bundleItemsJson: payload.bundleItems || null } : {}),
      ...(payload.pricePerUnit !== undefined ? { pricePerUnit: payload.pricePerUnit } : {}),
      ...(payload.closingDate !== undefined ? { closingDate: new Date(payload.closingDate) } : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      ...(payload.pickupInstructions !== undefined ? { pickupInstructions: payload.pickupInstructions } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.deliveryEnabled !== undefined ? { deliveryEnabled: payload.deliveryEnabled } : {}),
      ...(payload.deliveryBaseRangeMax !== undefined ? { deliveryBaseRangeMax: payload.deliveryBaseRangeMax } : {}),
      ...(payload.deliveryBasePrice !== undefined ? { deliveryBasePrice: payload.deliveryBasePrice } : {}),
      ...(payload.deliveryAdditionalUnitPrice !== undefined
        ? { deliveryAdditionalUnitPrice: payload.deliveryAdditionalUnitPrice }
        : {}),
    };

    const item = await prisma.salesItem.update({
      where: { id: salesItemId },
      data,
    });

    res.json(item);
  } catch (error) {
    next(error);
  }
}

export async function deleteSalesItemHandler(req, res, next) {
  try {
    const salesItemId = req.params.salesItemId;
    const existingItem = await prisma.salesItem.findUnique({
      where: { id: salesItemId },
    });

    if (!existingItem) {
      return res.status(404).json({ message: 'Sales item not found.' });
    }

    if (existingItem.status !== 'ACTIVE' || new Date() >= existingItem.closingDate) {
      return res.status(409).json({
        message: 'Only active sales that have not expired can be deleted.',
      });
    }

    const orderCount = await prisma.order.count({
      where: { salesItemId },
    });

    if (orderCount > 0) {
      return res.status(409).json({
        message: 'Cannot delete sales item once buyers have placed orders. Set status to INACTIVE instead.',
      });
    }

    await prisma.salesItem.delete({ where: { id: salesItemId } });
    return res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function adminReportsHandler(req, res, next) {
  try {
    const query = adminReportsQuerySchema.parse(req.query);
    const data = await buildAdminReportsData(query);

    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function buildAdminReportsData(query) {
    const orders = await prisma.order.findMany({
      include: {
        salesItem: true,
        user: {
          select: {
            name: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
          },
        },
        payment: {
          select: {
            providerReference: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const reconciledOrders = await Promise.all(
      orders.map(async (order) => {
        const needsStripeSync =
          order.paymentMethod === 'STRIPE_CARD' &&
          !isOrderPaidLike(order) &&
          Boolean(order.payment?.providerReference);

        if (!needsStripeSync) {
          return order;
        }

        try {
          const paymentIntent = await retrieveStripePaymentIntent(order.payment.providerReference);
          if (paymentIntent?.status !== 'succeeded') {
            return order;
          }

          const updated = await markOrderPaidByReference({
            orderReference: order.orderReference,
            providerReference: paymentIntent.id,
            payload: paymentIntent,
          });

          return {
            ...order,
            status: updated.status,
            paymentStatus: updated.paymentStatus,
            paidAt: updated.paidAt,
          };
        } catch (syncError) {
          console.error('Failed to reconcile Stripe report payment status', {
            orderReference: order.orderReference,
            error: syncError?.message,
          });
          return order;
        }
      }),
    );

    const salesItems = await prisma.salesItem.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        saleType: true,
        batchNumber: true,
        status: true,
        closingDate: true,
        pickupInstructions: true,
      },
    });

    const [overviewOrders, overviewSalesEvents, recentCustomers] = await Promise.all([
      prisma.order.findMany({
        select: {
          id: true,
          createdAt: true,
          paidAt: true,
          totalAmount: true,
          status: true,
          paymentStatus: true,
        },
      }),
      prisma.salesItem.findMany({
        select: {
          id: true,
          name: true,
          saleType: true,
          batchNumber: true,
          status: true,
          createdAt: true,
          closingDate: true,
        },
      }),
      prisma.user.findMany({
        where: { role: 'USER' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          address: true,
          city: true,
          province: true,
          postalCode: true,
          isActive: true,
          createdAt: true,
        },
      }),
    ]);

    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const paidOverviewOrders = overviewOrders.filter((order) => isOrderPaidLike(order));
    const liveSalesEvents = overviewSalesEvents
      .filter((item) => item.status === 'ACTIVE' && item.closingDate > now)
      .sort((a, b) => a.closingDate.getTime() - b.closingDate.getTime());
    const nextLiveEvent = liveSalesEvents[0] || null;

    const totalOrdersYtd = overviewOrders.filter((order) => isSameOrAfter(order.createdAt, yearStart)).length;
    const totalOrdersMtd = overviewOrders.filter((order) => isSameOrAfter(order.createdAt, monthStart)).length;
    const paidOrdersYtd = paidOverviewOrders.filter((order) => isSameOrAfter(order.paidAt || order.createdAt, yearStart)).length;
    const paidOrdersMtd = paidOverviewOrders.filter((order) => isSameOrAfter(order.paidAt || order.createdAt, monthStart)).length;
    const pendingPaymentOrders = overviewOrders.filter((order) => !isOrderPaidLike(order)).length;
    const totalSalesYtd = paidOverviewOrders
      .filter((order) => isSameOrAfter(order.paidAt || order.createdAt, yearStart))
      .reduce((sum, order) => sum + order.totalAmount, 0);
    const totalSalesMtd = paidOverviewOrders
      .filter((order) => isSameOrAfter(order.paidAt || order.createdAt, monthStart))
      .reduce((sum, order) => sum + order.totalAmount, 0);
    const activeNormalSales = liveSalesEvents.filter((item) => item.saleType === 'NORMAL_SALE').length;
    const activeBundleSales = liveSalesEvents.filter((item) => item.saleType === 'BUNDLE_DISCOUNTED_SALE').length;
    const salesEventsYtd = overviewSalesEvents.filter((item) => isSameOrAfter(item.createdAt, yearStart)).length;
    const salesEventsMtd = overviewSalesEvents.filter((item) => isSameOrAfter(item.createdAt, monthStart)).length;

    const normalizedOrders = reconciledOrders.map((order) => {
      const fulfillmentItems = normalizeFulfillmentItems(order);
      const aggregateFulfillmentStatus = deriveAggregateFulfillmentStatus(order, fulfillmentItems);
      const itemDetails = fulfillmentItems.map((item) => ({
        salesItemId: item.salesItemId || order.salesItemId,
        sourceIndex: item.sourceIndex ?? null,
        bundleItemIndex: item.bundleItemIndex ?? null,
        name: item.name,
        quantity: item.quantity,
        lineTotal: item.lineTotal || 0,
        fulfillmentMethod: item.fulfillmentMethod,
        fulfillmentStatus: item.fulfillmentStatus,
        fulfillmentStatusLabel: getFulfillmentStatusLabel(item.fulfillmentStatus),
        batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
        saleType: item.saleType || order.salesItem?.saleType || 'NORMAL_SALE',
        bundleItems: Array.isArray(item.bundleItems) ? item.bundleItems : [],
        isBundleComponent: Boolean(item.isBundleComponent),
        bundleName: item.bundleName || null,
        bundleLineTotal: item.bundleLineTotal ?? null,
      }));

      return {
        ...order,
        displayOrderReference: formatDisplayOrderReference({
          createdAt: order.createdAt,
          batchNumber: order.salesItem?.batchNumber,
          orderSequence: order.orderSequence,
        }),
        aggregateFulfillmentStatus,
        itemDetails,
        reportItemDetails: itemDetails.filter((item) => orderItemMatchesReportFilters(item, query)),
      };
    }).filter((order) =>
      orderMatchesDateRange(order, {
        startDate: query.startDate,
        endDate: query.endDate,
      }) &&
      order.reportItemDetails.length > 0,
    );

    const paidOrders = normalizedOrders.filter((order) => isOrderPaidLike(order));
    const paidBatchSalesComparison = buildPaidBatchSalesComparison(paidOrders);

    const orderReadyRows = paidOrders.map((order) => ({
      id: order.id,
      orderReference: order.orderReference,
      displayOrderReference: order.displayOrderReference,
      batchNumber: order.salesItem?.batchNumber || '',
      items: order.reportItemDetails.map((item) => item.name).join(', '),
      quantities: order.reportItemDetails.map((item) => `${item.name}: ${item.quantity}`).join(', '),
    }));

    const supplierAggregation = new Map();
    for (const order of paidOrders) {
      const bundleComponentTotals = new Map();
      for (const item of order.reportItemDetails) {
        if (!item.isBundleComponent) {
          continue;
        }

        const groupKey = [item.batchNumber, item.bundleName || item.name, item.bundleLineTotal ?? 0].join('::');
        bundleComponentTotals.set(groupKey, (bundleComponentTotals.get(groupKey) || 0) + item.quantity);
      }

      for (const item of order.reportItemDetails) {
        if (item.isBundleComponent) {
          const supplierKey = [item.batchNumber, item.saleType, item.name].join('::');
          const current = supplierAggregation.get(supplierKey) || {
            id: supplierKey,
            batchNumber: item.batchNumber,
            salesType: 'Bundle Discounted Sale',
            itemName: item.name,
            totalQuantity: 0,
            totalAmount: 0,
          };
          const bundleGroupKey = [item.batchNumber, item.bundleName || item.name, item.bundleLineTotal ?? 0].join('::');
          const bundleUnits = bundleComponentTotals.get(bundleGroupKey) || item.quantity || 1;
          const allocatedAmount = Math.round(((item.bundleLineTotal ?? 0) * item.quantity) / bundleUnits);
          current.totalQuantity += item.quantity;
          current.totalAmount += allocatedAmount;
          supplierAggregation.set(supplierKey, current);
        } else if (item.saleType === 'BUNDLE_DISCOUNTED_SALE' && item.bundleItems.length) {
          for (const bundleItem of item.bundleItems) {
            const supplierKey = [item.batchNumber, item.saleType, bundleItem.name].join('::');
            const current = supplierAggregation.get(supplierKey) || {
              id: supplierKey,
              batchNumber: item.batchNumber,
              salesType: 'Bundle Discounted Sale',
              itemName: bundleItem.name,
              totalQuantity: 0,
              totalAmount: 0,
            };
            current.totalQuantity += (Number(bundleItem.quantity) || 0) * item.quantity;
            current.totalAmount += item.lineTotal || 0;
            supplierAggregation.set(supplierKey, current);
          }
        } else {
          const supplierKey = [item.batchNumber, item.saleType, item.name].join('::');
          const current = supplierAggregation.get(supplierKey) || {
            id: supplierKey,
            batchNumber: item.batchNumber,
            salesType: item.saleType === 'BUNDLE_DISCOUNTED_SALE' ? 'Bundle Discounted Sale' : 'Normal Sale',
            itemName: item.name,
            totalQuantity: 0,
            totalAmount: 0,
          };
          current.totalQuantity += item.quantity;
          current.totalAmount += item.lineTotal || 0;
          supplierAggregation.set(supplierKey, current);
        }
      }
    }

    const supplierOrderRows = Array.from(supplierAggregation.values()).sort((a, b) => {
      if (a.batchNumber === b.batchNumber) {
        return a.itemName.localeCompare(b.itemName);
      }
      return a.batchNumber.localeCompare(b.batchNumber);
    });

    const salesDetailRows = paidOrders.map((order) => {
      const orderDetails = [
        order.user?.name || 'Unknown buyer',
        order.reportItemDetails.map((item) => `${item.name} x${item.quantity}`).join(', '),
      ].filter(Boolean).join(' · ');

      const fulfillment = order.reportItemDetails
        .map((item) => `${item.name}: ${item.fulfillmentStatusLabel}`)
        .join(', ');

      return {
        id: order.id,
        orderReference: order.orderReference,
        displayOrderReference: order.displayOrderReference,
        batchNumber: order.salesItem?.batchNumber || '',
        orderDetails,
        fulfillment,
        totalAmount: sumReportItemAmounts(order.reportItemDetails),
      };
    });

    return {
      filters: {
        startDate: query.startDate || null,
        endDate: query.endDate || null,
        salesItemId: query.salesItemId || null,
        batchNumber: query.batchNumber || null,
        fulfillmentMethod: query.fulfillmentMethod || null,
        fulfillmentStatus: query.fulfillmentStatus || null,
        reportType: query.reportType,
      },
      filterOptions: {
        salesItems: salesItems.map((item) => ({
          id: item.id,
          name: item.name,
          saleType: item.saleType,
          batchNumber: item.batchNumber,
          status: item.status,
          closingDate: item.closingDate,
        })),
      },
      summary: {
        totalOrders: normalizedOrders.length,
        paidOrders: paidOrders.length,
        totalRevenue: paidOrders.reduce((sum, order) => sum + order.totalAmount, 0),
        overview: {
          totalOrdersYtd,
          totalOrdersMtd,
          paidOrdersYtd,
          paidOrdersMtd,
          pendingPaymentOrders,
          totalSalesYtd,
          totalSalesMtd,
          activeNormalSales,
          activeBundleSales,
          salesEventsYtd,
          salesEventsMtd,
          paidBatchSalesComparison,
          nextLiveEvent: nextLiveEvent
            ? {
                name: nextLiveEvent.name,
                batchNumber: nextLiveEvent.batchNumber,
                saleType: nextLiveEvent.saleType,
                closingDate: nextLiveEvent.closingDate,
              }
            : null,
          recentCustomers: recentCustomers.map((customer) => ({
            ...customer,
            addressLine: [customer.address, customer.city, customer.province, customer.postalCode]
              .filter(Boolean)
              .join(', '),
          })),
        },
      },
      orderReadyRows,
      supplierOrderRows,
      salesDetailRows,
    };
}

function sortPickupNoticeRows(rows, query) {
  const sortDirection = query.sortOrder === 'asc' ? 1 : -1;

  return [...rows].sort((left, right) => {
    if (query.sortBy === 'batchNumber') {
      return sortDirection * String(left.batchNumber || '').localeCompare(String(right.batchNumber || ''));
    }

    if (query.sortBy === 'location') {
      return sortDirection * String(left.location || '').localeCompare(String(right.location || ''));
    }

    if (query.sortBy === 'buyer') {
      return sortDirection * String(left.user?.name || '').localeCompare(String(right.user?.name || ''));
    }

    const leftTime = new Date(query.sortBy === 'createdAt' ? left.createdAt : (left.paidAt || left.createdAt)).getTime();
    const rightTime = new Date(query.sortBy === 'createdAt' ? right.createdAt : (right.paidAt || right.createdAt)).getTime();
    return sortDirection * (leftTime - rightTime);
  });
}

async function buildPickupNoticeRows(query) {
  const orders = await prisma.order.findMany({
    include: {
      user: {
        select: {
          id: true,
          name: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          address: true,
          city: true,
          province: true,
          postalCode: true,
        },
      },
      salesItem: {
        select: {
          id: true,
          name: true,
          batchNumber: true,
          pickupInstructions: true,
          saleType: true,
        },
      },
      payment: {
        select: {
          providerReference: true,
          providerPayloadJson: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const reconciledOrders = await Promise.all(
    orders.map(async (order) => {
      const needsStripeSync =
        order.paymentMethod === 'STRIPE_CARD' &&
        !isOrderPaidLike(order) &&
        Boolean(order.payment?.providerReference);

      if (!needsStripeSync) {
        return order;
      }

      try {
        const paymentIntent = await retrieveStripePaymentIntent(order.payment.providerReference);
        if (paymentIntent?.status !== 'succeeded') {
          return order;
        }

        const updated = await markOrderPaidByReference({
          orderReference: order.orderReference,
          providerReference: paymentIntent.id,
          payload: paymentIntent,
        });

        return {
          ...order,
          status: updated.status,
          paymentStatus: updated.paymentStatus,
          paidAt: updated.paidAt,
        };
      } catch {
        return order;
      }
    }),
  );

  const filteredRows = reconciledOrders
    .filter((order) => isOrderPaidLike(order))
    .filter((order) => orderMatchesDateRange(order, { startDate: query.startDate, endDate: query.endDate }))
    .flatMap((order) => normalizeFulfillmentItems(order).map((item) => ({
      ...order,
      ...item,
      displayOrderReference: formatDisplayOrderReference({
        createdAt: order.createdAt,
        batchNumber: order.salesItem?.batchNumber,
        orderSequence: order.orderSequence,
      }),
      noticeStatus: formatPickupNoticeStatus(item.pickupNotice),
      noticeSentAt: item.pickupNotice?.sentAt || null,
      noticeChannels: item.pickupNotice?.lastResults || {},
    })))
    .filter((row) => row.fulfillmentStatus === 'PENDING_PICKUP' || row.fulfillmentStatus === 'PENDING_DELIVERY')
    .filter((row) => !query.fulfillmentMethod || row.fulfillmentMethod === query.fulfillmentMethod)
    .filter((row) => !query.noticeStatus || row.noticeStatus === query.noticeStatus)
    .filter((row) => !query.location || includesInsensitive(row.location, query.location))
    .filter((row) => !query.batchNumber || parseBatchNumberFilters(query.batchNumber).some((batch) => includesInsensitive(row.batchNumber, batch)))
    .filter((row) => {
      if (!query.q) {
        return true;
      }

      return [
        row.orderReference,
        row.displayOrderReference,
        row.user?.name,
        row.user?.email,
        row.user?.phone,
        row.batchNumber,
        row.name,
        row.location,
      ].some((value) => includesInsensitive(value, query.q));
    });

  const rows = sortPickupNoticeRows(filteredRows, query);
  const locations = [...new Set(rows.map((row) => row.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  return {
    rows,
    filterOptions: {
      locations,
    },
  };
}

export async function listPickupNoticesHandler(req, res, next) {
  try {
    const query = listPickupNoticesQuerySchema.parse(req.query);
    const { rows, filterOptions } = await buildPickupNoticeRows(query);
    const skip = (query.page - 1) * query.limit;
    const pagedRows = rows.slice(skip, skip + query.limit);

    return res.json({
      items: pagedRows,
      filterOptions,
      page: query.page,
      limit: query.limit,
      total: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / query.limit)),
    });
  } catch (error) {
    next(error);
  }
}

export async function sendPickupNoticesHandler(req, res, next) {
  try {
    const payload = sendPickupNoticesSchema.parse(req.body);
    const orderReferences = [...new Set(payload.items.map((item) => item.orderReference))];
    const orders = await prisma.order.findMany({
      where: { orderReference: { in: orderReferences } },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            firstName: true,
            email: true,
            phone: true,
          },
        },
        salesItem: {
          select: {
            id: true,
            name: true,
            batchNumber: true,
            pickupInstructions: true,
            saleType: true,
          },
        },
      },
    });

    const results = [];

    for (const orderReference of orderReferences) {
      const order = orders.find((entry) => entry.orderReference === orderReference);
      if (!order || !isOrderPaidLike(order)) {
        continue;
      }

      const snapshot = parseOrderNotes(order.notes);
      const rawItems = Array.isArray(snapshot?.items) && snapshot.items.length
        ? snapshot.items
        : [buildFallbackSnapshotItem(order)];
      const flattenedItems = normalizeFulfillmentItems({
        ...order,
        notes: JSON.stringify({
          ...(snapshot || {}),
          items: rawItems,
        }),
      });

      const selectedForOrder = payload.items.filter((item) => item.orderReference === orderReference);
      const selectedIndices = new Set(selectedForOrder.map((item) => item.itemIndex));
      const selectedRows = flattenedItems.filter((item) => selectedIndices.has(item.itemIndex));

      if (!selectedRows.length) {
        continue;
      }

      const itemsSummary = formatPickupNoticeItemSummary(selectedRows);
      const firstName = order.user?.firstName || order.user?.name || 'Customer';
      const displayOrderReference = formatDisplayOrderReference({
        createdAt: order.createdAt,
        batchNumber: order.salesItem?.batchNumber,
        orderSequence: order.orderSequence,
      });
      const messageText = buildPickupNoticeMessageText({
        firstName,
        displayOrderReference,
        itemsSummary,
        fulfillmentMethod: order.fulfillmentMethod,
        address: payload.address,
        readyDate: payload.readyDate,
        timeWindow: payload.timeWindow,
        contactName: payload.contactName,
        contactPhone: payload.contactPhone,
        note: payload.note,
      });

      const nowIso = new Date().toISOString();
      const channelResults = {};

      if (payload.channels.includes('EMAIL')) {
        if (order.user?.email) {
          try {
            await sendOrderReadyNoticeEmail({
              email: order.user.email,
              firstName,
              displayOrderReference,
              itemsSummary,
              fulfillmentMethod: order.fulfillmentMethod,
              address: payload.address,
              readyDate: payload.readyDate,
              timeWindow: payload.timeWindow,
              contactName: payload.contactName,
              contactPhone: payload.contactPhone,
              note: payload.note,
            });
            channelResults.email = { status: 'sent', sentAt: nowIso };
          } catch (error) {
            channelResults.email = { status: 'failed', sentAt: nowIso, reason: error?.message || 'Email send failed.' };
          }
        } else {
          channelResults.email = { status: 'skipped', sentAt: nowIso, reason: 'Buyer email is not available.' };
        }
      }

      if (payload.channels.includes('WHATSAPP')) {
        const whatsappResult = await sendWhatsAppTextMessage({
          to: order.user?.phone || '',
          text: messageText,
        });

        channelResults.whatsapp = {
          status: whatsappResult.status,
          sentAt: nowIso,
          reason: whatsappResult.reason || null,
        };
      }

      const sentSuccessfully = Object.values(channelResults).some((result) => result?.status === 'sent');
      const nextItems = rawItems.map((item, sourceIndex) => {
        const matchedRow = selectedRows.find((row) => row.sourceIndex === sourceIndex && row.bundleItemIndex === undefined);
        const matchedBundleRows = selectedRows.filter((row) => row.sourceIndex === sourceIndex && row.bundleItemIndex !== undefined);

        if (matchedBundleRows.length) {
          const nextChildren = buildBundleFulfillmentChildren(order, item).map((child, childIndex) => {
            const bundleMatch = matchedBundleRows.find((row) => row.bundleItemIndex === childIndex);
            if (!bundleMatch) {
              return child;
            }

            const previous = child.pickupNotice || {};
            return {
              ...child,
              pickupNotice: {
                ...previous,
                address: payload.address,
                readyDate: payload.readyDate,
                timeWindow: payload.timeWindow,
                contactName: payload.contactName || '',
                contactPhone: payload.contactPhone || '',
                note: payload.note || '',
                sentAt: sentSuccessfully ? nowIso : previous.sentAt || null,
                lastSentAt: nowIso,
                sendCount: Number(previous.sendCount || 0) + 1,
                lastResults: channelResults,
                sentByUserId: req.admin.userId,
              },
            };
          });

          return {
            ...item,
            fulfillmentChildren: nextChildren,
          };
        }

        if (!matchedRow) {
          return item;
        }

        const previous = item.pickupNotice || {};
        return {
          ...item,
          pickupNotice: {
            ...previous,
            address: payload.address,
            readyDate: payload.readyDate,
            timeWindow: payload.timeWindow,
            contactName: payload.contactName || '',
            contactPhone: payload.contactPhone || '',
            note: payload.note || '',
            sentAt: sentSuccessfully ? nowIso : previous.sentAt || null,
            lastSentAt: nowIso,
            sendCount: Number(previous.sendCount || 0) + 1,
            lastResults: channelResults,
            sentByUserId: req.admin.userId,
          },
        };
      });

      await prisma.order.update({
        where: { orderReference },
        data: {
          notes: JSON.stringify({
            ...(snapshot || {}),
            items: nextItems,
          }),
        },
      });

      results.push({
        orderReference,
        displayOrderReference,
        itemsSummary,
        channelResults,
        sentSuccessfully,
      });
    }

    const sentCount = results.filter((entry) => entry.sentSuccessfully).length;

    return res.json({
      message: sentCount
        ? `Pickup notice sent for ${sentCount} order${sentCount === 1 ? '' : 's'}.`
        : 'No pickup notices were sent. Check channel availability or buyer contact details.',
      results,
    });
  } catch (error) {
    next(error);
  }
}

export async function exportReportsHandler(req, res, next) {
  try {
    const query = adminReportsQuerySchema.parse(req.query);
    const reports = await buildAdminReportsData(query);

    const reportType = reports.filters.reportType || 'orderReady';
    const reportRows =
      reportType === 'supplierOrders'
        ? reports.supplierOrderRows || []
        : reportType === 'salesDetails'
          ? reports.salesDetailRows || []
          : reports.orderReadyRows || [];

    const columns =
      reportType === 'supplierOrders'
        ? [
            ['Batch No', (row) => row.batchNumber],
            ['Sales Type', (row) => row.salesType],
            ['Items', (row) => row.itemName],
            ['Total Quantity', (row) => row.totalQuantity],
          ]
        : reportType === 'salesDetails'
          ? [
              ['Order No', (row) => row.displayOrderReference],
              ['Order Details', (row) => row.orderDetails],
              ['Fulfilment', (row) => row.fulfillment],
              ['Total Amount (CAD)', (row) => ((row.totalAmount || 0) / 100).toFixed(2)],
            ]
          : [
              ['Order Number', (row) => row.displayOrderReference],
              ['Items', (row) => row.items],
              ['Quantities', (row) => row.quantities],
            ];

    const csvRows = [
      columns.map(([label]) => escapeCsv(label)).join(','),
      ...reportRows.map((row) => columns.map(([, getter]) => escapeCsv(getter(row))).join(',')),
    ].join('\n');

    const fileBase =
      reportType === 'supplierOrders'
        ? 'items-to-order-from-supplier-paid-report'
        : reportType === 'salesDetails'
          ? 'sales-details-report'
          : 'order-ready-paid-report';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(csvRows);
  } catch (error) {
    next(error);
  }
}

export async function resendPaymentConfirmationHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const outcome = await resendOrderPaymentConfirmationByReference({ orderReference });
    return res.json({
      message: 'Payment confirmation email resent successfully.',
      orderReference: outcome.orderReference,
      paymentMethod: outcome.paymentMethod,
      paymentStatus: outcome.paymentStatus,
      paidAt: outcome.paidAt,
    });
  } catch (error) {
    next(error);
  }
}

export async function resolvePaymentHandler(req, res, next) {
  try {
    const payload = adminPaymentResolutionSchema.parse({
      ...req.body,
      orderReference: req.params.orderReference,
    });

    const order = await prisma.order.findUnique({
      where: { orderReference: payload.orderReference },
      include: {
        user: true,
        salesItem: true,
        payment: true,
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    const isPendingReview = order.paymentStatus === 'PENDING_REVIEW';
    const isPaid = isOrderPaidLike(order);
    if (!isPendingReview && !isPaid) {
      return res.status(409).json({ message: 'Only pending review or paid orders can be cancelled or refunded.' });
    }

    const existingPayload = order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object'
      ? order.payment.providerPayloadJson
      : {};
    const resolvedAt = new Date().toISOString();
    const adminResolution = {
      action: payload.action,
      comment: payload.comment,
      notifyBuyer: payload.notifyBuyer,
      resolvedAt,
      resolvedByUserId: req.admin.userId,
      previousPaymentStatus: order.paymentStatus,
      previousOrderStatus: order.status,
    };

    const updatedOrder = await prisma.order.update({
      where: { orderReference: payload.orderReference },
      data: {
        status: 'CANCELLED',
        paymentStatus: 'FAILED',
        payment: {
          update: {
            status: 'FAILED',
            providerPayloadJson: {
              ...existingPayload,
              adminResolution,
            },
          },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            title: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
          },
        },
        salesItem: {
          select: {
            id: true,
            name: true,
            batchNumber: true,
            pickupInstructions: true,
          },
        },
        payment: {
          select: {
            status: true,
            providerPayloadJson: true,
            providerReference: true,
            updatedAt: true,
          },
        },
      },
    });

    let emailSent = false;
    if (payload.notifyBuyer && updatedOrder.user?.email) {
      try {
        await sendOrderPaymentResolutionEmail({
          email: updatedOrder.user.email,
          firstName: updatedOrder.user.firstName || updatedOrder.user.name?.split(' ').filter(Boolean)[0] || 'Customer',
          displayOrderReference: formatDisplayOrderReference({
            createdAt: updatedOrder.createdAt,
            batchNumber: updatedOrder.salesItem?.batchNumber,
            orderSequence: updatedOrder.orderSequence,
          }),
          action: payload.action,
          reason: payload.comment,
        });
        emailSent = true;
      } catch (error) {
        console.error('Failed to send payment resolution email', {
          orderReference: updatedOrder.orderReference,
          action: payload.action,
          error: error?.message,
        });
      }
    }

    return res.json({
      message: `${payload.action === 'REFUNDED' ? 'Refund' : 'Cancellation'} saved successfully.`,
      emailSent,
      order: updatedOrder,
    });
  } catch (error) {
    next(error);
  }
}

export async function paymentProofViewUrlHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const outcome = await getManualTransferProofViewUrlByReference({ orderReference });
    return res.json(outcome);
  } catch (error) {
    next(error);
  }
}

export async function listCustomersHandler(req, res, next) {
  try {
    const query = listCustomersQuerySchema.parse(req.query);
    const orderRelationFilter = query.batchNumber
      ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } }
      : {};

    const where = {
      role: 'USER',
      ...(query.hasOrders === true ? { orders: { some: orderRelationFilter } } : {}),
      ...(query.hasOrders === false ? { orders: { none: orderRelationFilter } } : {}),
      ...(query.hasOrders === undefined && query.batchNumber ? { orders: { some: orderRelationFilter } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q } },
              { address: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const skip = (query.page - 1) * query.limit;
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip,
        take: query.limit,
        select: {
          id: true,
          name: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          address: true,
          city: true,
          province: true,
          postalCode: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);

    const userIds = users.map((user) => user.id);
    const pendingUpdateRequests = await prisma.customerUpdateRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        phone: true,
        address: true,
        city: true,
        province: true,
        postalCode: true,
        status: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (userIds.length === 0) {
      return res.json({
        items: [],
        pendingUpdateRequests: pendingUpdateRequests.map((request) => ({
          id: request.id,
          status: request.status,
          createdAt: request.createdAt,
          phone: request.phone,
          address: request.address,
          city: request.city,
          province: request.province,
          postalCode: request.postalCode,
          customer: request.user,
        })),
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      });
    }

    const [allOrdersAgg, paidOrdersAgg, latestOrders] = await Promise.all([
      prisma.order.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          ...(query.batchNumber ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } } : {}),
        },
        _count: { _all: true },
      }),
      prisma.order.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          paymentStatus: 'PAID',
          ...(query.batchNumber ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } } : {}),
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.order.findMany({
        where: {
          userId: { in: userIds },
          ...(query.batchNumber ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          userId: true,
          createdAt: true,
        },
      }),
    ]);

    const totalOrdersByUserId = new Map(
      allOrdersAgg.map((row) => [row.userId, row._count._all]),
    );
    const paidStatsByUserId = new Map(
      paidOrdersAgg.map((row) => [
        row.userId,
        {
          paidOrders: row._count._all,
          totalPaidAmount: row._sum.totalAmount || 0,
        },
      ]),
    );

    const lastOrderByUserId = new Map();
    for (const row of latestOrders) {
      if (!lastOrderByUserId.has(row.userId)) {
        lastOrderByUserId.set(row.userId, row.createdAt);
      }
    }

    return res.json({
      items: users.map((user) => {
        const paidStats = paidStatsByUserId.get(user.id) || {
          paidOrders: 0,
          totalPaidAmount: 0,
        };
        return {
          ...user,
          totalOrders: totalOrdersByUserId.get(user.id) || 0,
          paidOrders: paidStats.paidOrders,
          totalPaidAmount: paidStats.totalPaidAmount,
          lastOrderAt: lastOrderByUserId.get(user.id) || null,
        };
      }),
      pendingUpdateRequests: pendingUpdateRequests.map((request) => ({
        id: request.id,
        status: request.status,
        createdAt: request.createdAt,
        phone: request.phone,
        address: request.address,
        city: request.city,
        province: request.province,
        postalCode: request.postalCode,
        customer: request.user,
      })),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCustomerHandler(req, res, next) {
  try {
    const customerId = z.string().uuid().parse(req.params.customerId);
    const payload = updateCustomerSchema.parse(req.body);

    const existingCustomer = await prisma.user.findUnique({
      where: { id: customerId },
      select: { id: true, role: true, email: true },
    });

    if (!existingCustomer || existingCustomer.role !== 'USER') {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    if (payload.email !== existingCustomer.email) {
      const emailConflict = await prisma.user.findUnique({
        where: { email: payload.email },
        select: { id: true },
      });

      if (emailConflict && emailConflict.id !== customerId) {
        return res.status(409).json({ message: 'Another customer already uses this email address.' });
      }
    }

    const updatedCustomer = await prisma.user.update({
      where: { id: customerId },
      data: {
        name: payload.name,
        email: payload.email,
        phone: payload.phone || null,
        address: payload.address || null,
        isActive: payload.isActive,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({
      message: 'Customer updated successfully.',
      customer: updatedCustomer,
    });
  } catch (error) {
    next(error);
  }
}

export async function createAdminCustomerHandler(req, res, next) {
  try {
    const payload = createAdminCustomerSchema.parse(req.body);
    const existingCustomer = await prisma.user.findUnique({
      where: { email: payload.email },
      select: { id: true },
    });

    if (existingCustomer) {
      return res.status(409).json({ message: 'A customer with this email already exists.' });
    }

    const fullName = [payload.title, payload.firstName, payload.lastName].filter(Boolean).join(' ').trim();

    const customer = await prisma.user.create({
      data: {
        name: fullName,
        title: payload.title || null,
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        role: 'USER',
        phone: payload.phone,
        address: payload.address,
        city: payload.city,
        province: payload.province,
        postalCode: payload.postalCode,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        city: true,
        province: true,
        postalCode: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.status(201).json({
      message: 'Customer created successfully.',
      customer,
    });
  } catch (error) {
    next(error);
  }
}

export async function approveCustomerUpdateRequestHandler(req, res, next) {
  try {
    const { requestId } = reviewCustomerUpdateRequestSchema.parse(req.params);

    const existingRequest = await prisma.customerUpdateRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        userId: true,
        phone: true,
        address: true,
        city: true,
        province: true,
        postalCode: true,
      },
    });

    if (!existingRequest) {
      return res.status(404).json({ message: 'Customer update request not found.' });
    }

    if (existingRequest.status !== 'PENDING') {
      return res.status(409).json({ message: 'This customer update request has already been reviewed.' });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: existingRequest.userId },
        data: {
          phone: existingRequest.phone,
          address: existingRequest.address,
          city: existingRequest.city,
          province: existingRequest.province,
          postalCode: existingRequest.postalCode,
        },
      }),
      prisma.customerUpdateRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedByUserId: req.admin.userId,
        },
      }),
    ]);

    return res.json({ message: 'Customer update approved successfully.' });
  } catch (error) {
    next(error);
  }
}

export async function declineCustomerUpdateRequestHandler(req, res, next) {
  try {
    const { requestId } = reviewCustomerUpdateRequestSchema.parse(req.params);

    const existingRequest = await prisma.customerUpdateRequest.findUnique({
      where: { id: requestId },
      select: { id: true, status: true },
    });

    if (!existingRequest) {
      return res.status(404).json({ message: 'Customer update request not found.' });
    }

    if (existingRequest.status !== 'PENDING') {
      return res.status(409).json({ message: 'This customer update request has already been reviewed.' });
    }

    await prisma.customerUpdateRequest.update({
      where: { id: requestId },
      data: {
        status: 'DECLINED',
        reviewedAt: new Date(),
        reviewedByUserId: req.admin.userId,
      },
    });

    return res.json({ message: 'Customer update declined successfully.' });
  } catch (error) {
    next(error);
  }
}

export async function listDiscountOrdersHandler(req, res, next) {
  try {
    const query = listDiscountOrdersQuerySchema.parse(req.query);
    const orders = await prisma.order.findMany({
      where: {
        notes: { contains: '"discountOrder":true' },
        ...(query.paymentStatus && !['CANCELLED', 'REFUNDED'].includes(query.paymentStatus) ? { paymentStatus: query.paymentStatus } : {}),
      },
      orderBy: { createdAt: query.sortOrder },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        salesItem: {
          select: {
            id: true,
            name: true,
            batchNumber: true,
            pickupInstructions: true,
          },
        },
        payment: {
          select: {
            status: true,
            providerPayloadJson: true,
            updatedAt: true,
          },
        },
      },
    });

    const filteredOrders = orders.filter((order) => {
      const discountMeta = getDiscountOrderMeta(order);
      if (!discountMeta) {
        return false;
      }

      if (!query.q) {
        return true;
      }

      const haystack = [
        order.user?.name,
        order.user?.email,
        order.user?.phone,
        order.salesItem?.name,
        order.salesItem?.batchNumber,
        order.orderReference,
        formatDisplayOrderReference({
          createdAt: order.createdAt,
          batchNumber: order.salesItem?.batchNumber,
          orderSequence: order.orderSequence,
        }),
        discountMeta.discountReason,
        ...getOrderSnapshotItems(order).map((item) => item?.name),
        ...getOrderSnapshotItems(order).map((item) => item?.batchNumber),
      ];

      return haystack.some((value) => includesInsensitive(value, query.q));
    });

    const total = filteredOrders.length;
    const skip = (query.page - 1) * query.limit;
    const pagedOrders = filteredOrders.slice(skip, skip + query.limit).map((order) => ({
      ...order,
      displayOrderReference: formatDisplayOrderReference({
        createdAt: order.createdAt,
        batchNumber: order.salesItem?.batchNumber,
        orderSequence: order.orderSequence,
      }),
      discountMeta: getDiscountOrderMeta(order),
      cartItems: getOrderSnapshotItems(order),
    }));

    return res.json({
      items: pagedOrders,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error) {
    next(error);
  }
}

export async function createDiscountOrderHandler(req, res, next) {
  try {
    const payload = createDiscountOrderSchema.parse(req.body);
    const order = await createAdminDiscountOrder({
      ...payload,
      adminUserId: req.admin.userId,
    });

    return res.status(201).json({
      message: 'Discount order created successfully.',
      order,
    });
  } catch (error) {
    next(error);
  }
}

export async function exportCustomersHandler(req, res, next) {
  try {
    const query = listCustomersQuerySchema.parse({
      ...req.query,
      page: 1,
      limit: 5000,
    });

    const orderRelationFilter = query.batchNumber
      ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } }
      : {};

    const where = {
      role: 'USER',
      ...(query.hasOrders === true ? { orders: { some: orderRelationFilter } } : {}),
      ...(query.hasOrders === false ? { orders: { none: orderRelationFilter } } : {}),
      ...(query.hasOrders === undefined && query.batchNumber ? { orders: { some: orderRelationFilter } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q } },
              { address: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const customers = await prisma.user.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortOrder },
      select: {
        name: true,
        email: true,
        phone: true,
        address: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const rows = [
      ['Name', 'Email', 'Phone', 'Address', 'Status', 'Created At', 'Updated At'].map(escapeCsv).join(','),
      ...customers.map((customer) => [
        customer.name || '',
        customer.email || '',
        customer.phone || '',
        customer.address || '',
        customer.isActive ? 'Active' : 'Inactive',
        customer.createdAt?.toISOString() || '',
        customer.updatedAt?.toISOString() || '',
      ].map(escapeCsv).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(rows);
  } catch (error) {
    next(error);
  }
}

export async function listOrdersHandler(req, res, next) {
  try {
    const query = listOrdersQuerySchema.parse(req.query);

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.paymentStatus && !['CANCELLED', 'REFUNDED'].includes(query.paymentStatus) ? { paymentStatus: query.paymentStatus } : {}),
    };

    const orders = await prisma.order.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortOrder },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            title: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
          },
        },
        salesItem: {
          select: {
            id: true,
            name: true,
            batchNumber: true,
            pickupInstructions: true,
          },
        },
        payment: {
          select: {
            status: true,
            providerPayloadJson: true,
            providerReference: true,
            updatedAt: true,
          },
        },
      },
    });

    const reconciledOrders = await Promise.all(
      orders.map(async (order) => {
        const needsStripeSync =
          order.paymentMethod === 'STRIPE_CARD' &&
          !isOrderPaidLike(order) &&
          Boolean(order.payment?.providerReference);

        if (!needsStripeSync) {
          return order;
        }

        try {
          const paymentIntent = await retrieveStripePaymentIntent(order.payment.providerReference);
          if (paymentIntent?.status !== 'succeeded') {
            return order;
          }

          const updated = await markOrderPaidByReference({
            orderReference: order.orderReference,
            providerReference: paymentIntent.id,
            payload: paymentIntent,
          });

          return {
            ...updated,
            displayOrderReference: formatDisplayOrderReference({
              createdAt: updated.createdAt,
              batchNumber: order.salesItem?.batchNumber,
              orderSequence: updated.orderSequence,
            }),
            user: order.user,
            salesItem: order.salesItem,
            payment: {
              ...order.payment,
              status: 'PAID',
              providerReference: paymentIntent.id,
            },
          };
        } catch (syncError) {
          console.error('Failed to reconcile Stripe order payment status', {
            orderReference: order.orderReference,
            error: syncError?.message,
          });
          return order;
        }
      }),
    );

    const normalizedOrders = reconciledOrders.map((order) => {
      const fulfillmentItems = normalizeFulfillmentItems(order);
      const aggregateFulfillmentStatus = deriveAggregateFulfillmentStatus(order, fulfillmentItems);

      return {
        ...order,
        fulfillmentStatus: aggregateFulfillmentStatus,
        displayOrderReference: order.displayOrderReference || formatDisplayOrderReference({
          createdAt: order.createdAt,
          batchNumber: order.salesItem?.batchNumber,
          orderSequence: order.orderSequence,
        }),
        fulfillmentItems,
      };
    }).filter((order) =>
      orderMatchesDateRange(order, {
        startDate: query.startDate,
        endDate: query.endDate,
      }) &&
      (query.paidOnly === true ? isOrderPaidLike(order) : true) &&
      (query.paymentStatus ? getDisplayPaymentStatus(order) === query.paymentStatus : true) &&
      orderMatchesBatchNumber(order, query.batchNumber) &&
      orderMatchesTextQuery(order, query.q) &&
      orderMatchesFulfillmentFilters(order, {
        fulfillmentMethod: query.fulfillmentMethod,
        fulfillmentStatus: query.fulfillmentStatus,
      }),
    );

    const total = normalizedOrders.length;
    const skip = (query.page - 1) * query.limit;
    const pagedOrders = normalizedOrders.slice(skip, skip + query.limit);

    return res.json({
      items: pagedOrders,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error) {
    next(error);
  }
}

export async function exportOrdersHandler(req, res, next) {
  try {
    const query = listOrdersQuerySchema
      .omit({ page: true, limit: true })
      .parse(req.query);

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.paymentStatus && !['CANCELLED', 'REFUNDED'].includes(query.paymentStatus) ? { paymentStatus: query.paymentStatus } : {}),
    };

    const orders = await prisma.order.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortOrder },
      include: {
        user: {
          select: {
            name: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
          },
        },
        salesItem: {
          select: {
            name: true,
            batchNumber: true,
            pickupInstructions: true,
          },
        },
      },
    });

    const normalizedOrders = orders.map((order) => {
      const fulfillmentItems = normalizeFulfillmentItems(order);
      const aggregateFulfillmentStatus = deriveAggregateFulfillmentStatus(order, fulfillmentItems);
      return {
        ...order,
        fulfillmentItems,
        fulfillmentStatus: aggregateFulfillmentStatus,
      };
    });

    const filteredOrders = normalizedOrders.filter((order) =>
      orderMatchesDateRange(order, {
        startDate: query.startDate,
        endDate: query.endDate,
      }) &&
      (query.paidOnly === true ? isOrderPaidLike(order) : true) &&
      (query.paymentStatus ? getDisplayPaymentStatus(order) === query.paymentStatus : true) &&
      orderMatchesBatchNumber(order, query.batchNumber) &&
      orderMatchesTextQuery(order, query.q) &&
      orderMatchesFulfillmentFilters(order, {
        fulfillmentMethod: query.fulfillmentMethod,
        fulfillmentStatus: query.fulfillmentStatus,
      }),
    );

    const rows = [
      [
        'Order Reference',
        'Batch Number',
        'Items',
        'Buyer Name',
        'Buyer Email',
        'Buyer Phone',
        'Address',
        'City',
        'Province',
        'Postal Code',
        'Quantity',
        'Payment Method',
        'Payment Status',
        'Order Status',
        'Fulfillment Method',
        'Fulfillment Status',
        'Total Amount (CAD)',
        'Created At',
        'Paid At',
        'Location of Sales',
      ].map(escapeCsv).join(','),
      ...filteredOrders.map((order) => [
        formatDisplayOrderReference({
          createdAt: order.createdAt,
          batchNumber: order.salesItem?.batchNumber,
          orderSequence: order.orderSequence,
        }),
        getOrderBatchSummary(order),
        getOrderItemSummary(order),
        order.user?.name || '',
        order.user?.email || '',
        order.user?.phone || '',
        order.user?.address || '',
        order.user?.city || '',
        order.user?.province || '',
        order.user?.postalCode || '',
        order.quantity,
        order.paymentMethod,
        getDisplayPaymentStatus(order),
        order.status,
        order.fulfillmentMethod,
        order.fulfillmentStatus,
        (order.totalAmount / 100).toFixed(2),
        order.createdAt?.toISOString() || '',
        order.paidAt?.toISOString() || '',
        order.salesItem?.pickupInstructions || '',
      ].map(escapeCsv).join(',')),
    ].join('\n');

    const exportTarget = query.fulfillmentMethod === 'DELIVERY' ? 'delivery-orders' : 'orders';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exportTarget}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(rows);
  } catch (error) {
    next(error);
  }
}

export async function updateFulfillmentStatusHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const payload = z.object({
      fulfillmentStatus: z.enum(['PENDING_PICKUP', 'PICKED_UP', 'PENDING_DELIVERY', 'DELIVERED']),
      itemIndex: z.number().int().min(0).optional(),
    }).parse(req.body);

    const order = await prisma.order.findUnique({
      where: { orderReference },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (!isOrderPaidLike(order)) {
      return res.status(409).json({ message: 'Only paid orders can be updated for pickup or delivery.' });
    }

    const snapshot = parseOrderNotes(order.notes);
    const rawItems = Array.isArray(snapshot?.items) ? snapshot.items : [];

    if (rawItems.length > 0 && payload.itemIndex === undefined) {
      return res.status(409).json({ message: 'Choose the specific order item you want to confirm.' });
    }

    const normalizedItems = rawItems.length
      ? rawItems.map((item) => {
          const normalizedItem = {
            ...item,
            fulfillmentMethod: item.fulfillmentMethod || order.fulfillmentMethod,
            fulfillmentStatus: getDefaultItemFulfillmentStatus(order, item),
          };

          if (normalizedItem.saleType === 'BUNDLE_DISCOUNTED_SALE') {
            normalizedItem.fulfillmentChildren = buildBundleFulfillmentChildren(order, normalizedItem);
          }

          return normalizedItem;
        })
      : null;

    const flattenedItems = normalizedItems
      ? normalizeFulfillmentItems({
          ...order,
          notes: JSON.stringify({
            ...(snapshot || {}),
            items: normalizedItems,
          }),
        })
      : null;

    const targetItem = flattenedItems
      ? flattenedItems[payload.itemIndex]
      : null;

    const targetMethod = targetItem
      ? targetItem.fulfillmentMethod
      : order.fulfillmentMethod;

    if (normalizedItems && !targetItem) {
      return res.status(404).json({ message: 'Order item not found.' });
    }

    if (!targetMethod) {
      return res.status(404).json({ message: 'Order item not found.' });
    }

    const pickupStatuses = ['PENDING_PICKUP', 'PICKED_UP'];
    const deliveryStatuses = ['PENDING_DELIVERY', 'DELIVERED'];
    const allowedStatuses = targetMethod === 'DELIVERY' ? deliveryStatuses : pickupStatuses;

    if (!allowedStatuses.includes(payload.fulfillmentStatus)) {
      return res.status(409).json({
        message: targetMethod === 'DELIVERY'
          ? 'Delivery orders can only be marked pending delivery or delivered.'
          : 'Pickup orders can only be marked pending pickup or picked up.',
      });
    }

    let nextNotes = order.notes;
    let aggregateFulfillmentStatus = payload.fulfillmentStatus;

    if (normalizedItems) {
      const nextItems = normalizedItems.map((item, index) =>
        index === targetItem?.sourceIndex
          ? targetItem?.bundleItemIndex !== undefined
            ? {
                ...item,
                fulfillmentChildren: buildBundleFulfillmentChildren(order, item).map((child, childIndex) =>
                  childIndex === targetItem.bundleItemIndex
                    ? {
                        ...child,
                        fulfillmentStatus: payload.fulfillmentStatus,
                        fulfilledAt: payload.fulfillmentStatus === 'PICKED_UP' || payload.fulfillmentStatus === 'DELIVERED'
                          ? new Date().toISOString()
                          : null,
                      }
                    : child,
                ),
              }
            : {
                ...item,
                fulfillmentStatus: payload.fulfillmentStatus,
                fulfilledAt: payload.fulfillmentStatus === 'PICKED_UP' || payload.fulfillmentStatus === 'DELIVERED'
                  ? new Date().toISOString()
                  : null,
              }
          : item,
      );

      const nextFlattenedItems = normalizeFulfillmentItems({
        ...order,
        notes: JSON.stringify({
          ...(snapshot || {}),
          items: nextItems,
        }),
      });

      aggregateFulfillmentStatus = deriveAggregateFulfillmentStatus(order, nextFlattenedItems);
      nextNotes = JSON.stringify({
        ...(snapshot || {}),
        items: nextItems,
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { orderReference },
      data: {
        fulfillmentStatus: aggregateFulfillmentStatus,
        notes: nextNotes,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            title: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
          },
        },
        salesItem: {
          select: {
            id: true,
            name: true,
            batchNumber: true,
            pickupInstructions: true,
          },
        },
        payment: {
          select: {
            status: true,
            providerPayloadJson: true,
            providerReference: true,
            updatedAt: true,
          },
        },
      },
    });

    const fulfillmentItems = normalizeFulfillmentItems(updatedOrder);
    const completedItem = payload.itemIndex !== undefined
      ? fulfillmentItems.find((item) => item.itemIndex === payload.itemIndex)
      : fulfillmentItems[0];

    let fulfillmentEmailSent = false;

    if (
      completedItem &&
      updatedOrder.user?.email &&
      (payload.fulfillmentStatus === 'PICKED_UP' || payload.fulfillmentStatus === 'DELIVERED')
    ) {
      try {
        await sendOrderFulfillmentCompletedEmail({
          email: updatedOrder.user.email,
          firstName: updatedOrder.user.firstName || updatedOrder.user.name || 'Customer',
          displayOrderReference: formatDisplayOrderReference({
            createdAt: updatedOrder.createdAt,
            batchNumber: updatedOrder.salesItem?.batchNumber,
            orderSequence: updatedOrder.orderSequence,
          }),
          itemName: completedItem.name,
          quantity: completedItem.quantity,
          fulfillmentMethod: completedItem.fulfillmentMethod,
        });
        fulfillmentEmailSent = true;
      } catch (error) {
        console.error('Failed to send fulfilment completion email', {
          orderReference: updatedOrder.orderReference,
          itemIndex: completedItem.itemIndex,
          error: error?.message,
        });
      }
    }

    return res.json({
      message: payload.fulfillmentStatus === 'PICKED_UP'
        ? 'Pickup confirmed successfully.'
        : payload.fulfillmentStatus === 'DELIVERED'
          ? 'Delivery confirmed successfully.'
          : 'Fulfilment status updated successfully.',
      emailSent: fulfillmentEmailSent,
      order: {
        ...updatedOrder,
        fulfillmentItems,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function confirmInteracPaymentHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const order = await prisma.order.findUnique({
      where: { orderReference },
      include: { payment: true },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.paymentMethod !== 'INTERAC_E_TRANSFER') {
      return res.status(409).json({ message: 'Only Interac e-Transfer orders can be confirmed here.' });
    }

    if (order.paymentStatus !== 'PENDING_REVIEW') {
      return res.status(409).json({ message: 'Only transfer submissions awaiting review can be confirmed.' });
    }

    const confirmedOrder = await markOrderPaidByReference({
      orderReference,
      providerReference: `admin-interac-confirmation:${req.admin.userId}`,
      payload: {
        ...((order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object')
          ? order.payment.providerPayloadJson
          : {}),
        adminConfirmation: {
          confirmedByUserId: req.admin.userId,
          confirmedAt: new Date().toISOString(),
        },
      },
    });

    return res.json({
      message: 'Interac payment confirmed successfully.',
      orderReference: confirmedOrder.orderReference,
      paidAt: confirmedOrder.paidAt,
      status: confirmedOrder.status,
      paymentStatus: confirmedOrder.paymentStatus,
      emailSent: Boolean(confirmedOrder.paymentConfirmationEmailSent),
    });
  } catch (error) {
    next(error);
  }
}

export async function createAdminIncompleteOrderUploadHandler(req, res, next) {
  try {
    const payload = adminIncompleteOrderUploadSchema.parse({
      orderReference: req.params.orderReference,
      fileName: req.body.fileName,
      contentType: req.body.contentType,
      sizeBytes: req.body.sizeBytes,
    });

    const order = await prisma.order.findUnique({
      where: { orderReference: payload.orderReference },
      select: {
        orderReference: true,
        paymentMethod: true,
        paymentStatus: true,
        status: true,
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (isOrderPaidLike(order)) {
      return res.status(409).json({ message: 'This order has already been paid and cannot accept a recovery receipt.' });
    }

    if (order.paymentStatus !== 'PENDING_PAYMENT') {
      return res.status(409).json({ message: 'Only incomplete orders can accept an admin-uploaded Interac receipt.' });
    }

    if (order.paymentMethod !== 'INTERAC_E_TRANSFER') {
      return res.status(409).json({ message: 'Admin receipt upload is only available for incomplete Interac e-Transfer orders.' });
    }

    const uploadTarget = await createTransferProofUploadTarget({
      orderReference: payload.orderReference,
      fileName: payload.fileName,
      contentType: payload.contentType,
    });

    return res.json({
      ...uploadTarget,
      fileName: payload.fileName,
      contentType: payload.contentType,
      sizeBytes: payload.sizeBytes,
    });
  } catch (error) {
    next(error);
  }
}

export async function markIncompleteOrderPendingReviewHandler(req, res, next) {
  try {
    const payload = adminIncompleteOrderReviewSchema.parse({
      orderReference: req.params.orderReference,
      comment: req.body.comment,
      transferProof: req.body.transferProof,
    });

    const order = await prisma.order.findUnique({
      where: { orderReference: payload.orderReference },
      include: {
        payment: true,
        salesItem: true,
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (isOrderPaidLike(order)) {
      return res.status(409).json({ message: 'This order has already been paid and cannot be moved to pending review.' });
    }

    if (order.paymentStatus !== 'PENDING_PAYMENT') {
      return res.status(409).json({ message: 'Only incomplete orders can be moved to pending review.' });
    }

    if (order.paymentMethod !== 'INTERAC_E_TRANSFER') {
      return res.status(409).json({ message: 'Only incomplete Interac e-Transfer orders can be moved to pending review.' });
    }

    if (!isValidReceiptObjectKey(payload.orderReference, payload.transferProof.objectKey)) {
      return res.status(409).json({ message: 'Uploaded receipt does not match this order.' });
    }

    const existingPayload = order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object'
      ? order.payment.providerPayloadJson
      : {};

    const storedTransferProof = buildStoredTransferProof(payload.transferProof);

    await prisma.order.update({
      where: { orderReference: payload.orderReference },
      data: {
        status: 'AWAITING_MANUAL_PAYMENT',
        paymentStatus: 'PENDING_REVIEW',
        payment: {
          update: {
            status: 'PENDING_REVIEW',
            providerPayloadJson: {
              ...existingPayload,
              transferProof: storedTransferProof,
              adminRecovery: {
                comment: payload.comment,
                updatedByUserId: req.admin.userId,
                updatedAt: new Date().toISOString(),
              },
            },
          },
        },
      },
    });

    return res.json({
      message: 'Incomplete order moved to pending review successfully.',
      orderReference: order.orderReference,
      displayOrderReference: formatDisplayOrderReference({
        createdAt: order.createdAt,
        batchNumber: order.salesItem?.batchNumber,
        orderSequence: order.orderSequence,
      }),
      status: 'AWAITING_MANUAL_PAYMENT',
      paymentStatus: 'PENDING_REVIEW',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteIncompleteOrderHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);

    const order = await prisma.order.findUnique({
      where: { orderReference },
      select: {
        id: true,
        orderReference: true,
        paymentStatus: true,
        status: true,
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (isOrderPaidLike(order) || order.paymentStatus === 'PENDING_REVIEW') {
      return res.status(409).json({ message: 'Only incomplete orders can be deleted here.' });
    }

    await prisma.order.delete({
      where: { orderReference },
    });

    return res.json({
      message: 'Incomplete order deleted successfully.',
      orderReference,
    });
  } catch (error) {
    next(error);
  }
}
