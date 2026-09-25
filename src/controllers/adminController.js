import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { getDisplayOrderReference } from '../utils/orderReference.js';
import {
  createAdminDiscountOrder,
  getManualTransferProofViewUrlByReference,
  markOrderPaidByReference,
  resendOrderPaymentConfirmationByReference,
} from '../services/orderService.js';
import {
  buildStoredTransferProof,
  createScopedTransferProofUploadTarget,
  createTransferProofUploadTarget,
  isValidReceiptObjectKey,
  isValidScopedReceiptObjectKey,
} from '../services/storageService.js';
import {
  sendOrderFulfillmentCompletedEmail,
  sendOrderCancellationEmail,
  sendOrderRefundEmail,
  sendOrderStoreCreditEmail,
  sendOrderReadyNoticeEmail,
  sendMail,
} from '../services/emailService.js';
import { retrieveStripePaymentIntent } from '../services/paymentService.js';
import { DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME } from '../constants/systemSalesItems.js';
import { getActivePickupLocationNames, getAllPickupLocationNames, hasActivePickupLocation } from '../services/pickupLocationService.js';
import { getCentralDateParts, startOfCentralMonth, startOfCentralYear } from '../utils/centralTime.js';
import { findActivePickupNoticeTemplateById } from './pickupNoticeTemplateController.js';
import { issueStoreCredit } from '../services/storeCreditService.js';

function getAdminResolutionAction(order) {
  return order?.payment?.providerPayloadJson?.adminResolution?.action || '';
}

function isOrderResolvedAwayFromPaid(order) {
  const action = getAdminResolutionAction(order);
  return action === 'CANCELLED' || action === 'REFUNDED' || action === 'STORE_CREDIT';
}

function isOrderPaidLike(order) {
  if (isOrderResolvedAwayFromPaid(order)) {
    return false;
  }

  return (
    order.paymentStatus === 'PAID' ||
    order.paymentStatus === 'SUCCEEDED' ||
    order.status === 'CONFIRMED' ||
    order.status === 'PAID' ||
    Boolean(order.paidAt)
  );
}

function isOrderPaidForOverview(order) {
  if (isOrderResolvedAwayFromPaid(order)) {
    return false;
  }

  return order?.paymentStatus === 'PAID';
}

function isOrderPendingPaymentForOverview(order) {
  if (isOrderResolvedAwayFromPaid(order)) {
    return false;
  }

  return ['PENDING_PAYMENT', 'REQUIRES_ACTION', 'PENDING_REVIEW'].includes(order?.paymentStatus);
}

function buildCustomerListWhere(query = {}) {
  const orderRelationFilter = query.batchNumber
    ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } }
    : {};

  return {
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
  if (resolutionAction === 'REFUNDED' || resolutionAction === 'CANCELLED' || resolutionAction === 'STORE_CREDIT') {
    return resolutionAction;
  }

  const resolvedItems = getResolvedOrderSnapshotItems(order);
  if (resolvedItems.length) {
    const hasRefunded = resolvedItems.some((item) => item.paymentResolution?.action === 'REFUNDED');
    const hasCancelled = resolvedItems.some((item) => item.paymentResolution?.action === 'CANCELLED');
    const hasStoreCredit = resolvedItems.some((item) => item.paymentResolution?.action === 'STORE_CREDIT');

    if ([hasRefunded, hasCancelled, hasStoreCredit].filter(Boolean).length > 1) {
      return 'PARTIALLY_RESOLVED';
    }
    if (hasRefunded) {
      return 'PARTIALLY_REFUNDED';
    }
    if (hasStoreCredit) {
      return 'PARTIALLY_STORE_CREDIT';
    }
    if (hasCancelled) {
      return 'PARTIALLY_CANCELLED';
    }
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

function isResolvedSnapshotItem(item) {
  const action = item?.paymentResolution?.action;
  return action === 'CANCELLED' || action === 'REFUNDED' || action === 'STORE_CREDIT';
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
    preferredPickupLocation: order.preferredPickupLocation || null,
    saleType: order.salesItem?.saleType || 'NORMAL_SALE',
    bundleItems: [],
  };
}

function formatPickupNoticeItemSummary(items = []) {
  return items
    .map((item) => `${item.name} x${item.quantity}`)
    .join(', ');
}

function compactOptionalNoticeLines(lines) {
  return lines.filter((line) => line !== null && line !== undefined);
}

const PICKUP_NOTICE_INSTRUCTIONS = [
  'IMPORTANT PICK-UP INSTRUCTIONS',
  '',
  '1. Please bring a valid means of identification.',
  '2. Your Order Number, exact name and email address used to place your order will be required for verification.',
  '3. If you ordered half of any item, please bring a suitable bag for proper packaging.',
  '4. Kindly park only in the designated driveway/parking lot of the advised address or permitted roadside parking spots. Do not obstruct neighbouring driveways or traffic.',
  '5. Please pick up your items and drive out of the location immediately to ease traffic and to create space for others to pick up.',
  '6. Do not litter the location with boxes.',
  '7. Please adhere strictly to the advised pick-up window, as we will not be available to attend to pickups afterwards. We will also not be responsible for any deterioration or damage to produce that is not picked up within the assigned time.',
];

function buildPickupNoticeMessageText({
  firstName,
  displayOrderReference,
  itemsSummary,
  fulfillmentMethod,
  address,
  preferredPickupLocation,
  readyDate,
  timeWindow,
  contactName,
  contactPhone,
  note,
}) {
  const isDelivery = fulfillmentMethod === 'DELIVERY';

  return compactOptionalNoticeLines([
    `Hello ${firstName},`,
    '',
    '',
    isDelivery
      ? 'Your paid order is now ready for delivery coordination.'
      : 'Your paid order is now ready for pickup.',
    '',
    '',
    `Order reference: ${displayOrderReference}`,
    `Items: ${itemsSummary}`,
    '',
    !isDelivery && preferredPickupLocation ? `Preferred pickup location: ${preferredPickupLocation}` : null,
    !isDelivery && preferredPickupLocation ? '' : null,
    `${isDelivery ? 'Dispatch / meeting address' : 'Pickup address'}: ${address}`,
    `Date: ${readyDate}`,
    `Time: ${timeWindow}`,
    contactName ? `Contact name: ${contactName}` : null,
    contactPhone ? `Contact phone: ${contactPhone}` : null,
    '',
    isDelivery
      ? (note ? `Instructions: ${note}` : null)
      : compactOptionalNoticeLines([...PICKUP_NOTICE_INSTRUCTIONS, note ? '' : null, note ? `Additional instruction: ${note}` : null]).join('\n'),
    '',
    'Regards,',
    'EazziBulkBuy.',
  ]).join('\n');
}

function getOrderSnapshotItems(order) {
  const snapshot = parseOrderNotes(order.notes);
  return Array.isArray(snapshot?.items) ? snapshot.items : [];
}

function getActiveOrderSnapshotItems(order) {
  return getOrderSnapshotItems(order).filter((item) => !isResolvedSnapshotItem(item));
}

function getResolvedOrderSnapshotItems(order, action = '') {
  return getOrderSnapshotItems(order).filter((item) => {
    if (!isResolvedSnapshotItem(item)) {
      return false;
    }

    if (!action) {
      return true;
    }

    return item.paymentResolution?.action === action;
  });
}

function summarizeSnapshotItems(items = []) {
  const groupedItems = new Map();

  items.forEach((item) => {
    const name = item?.name || 'Order items';
    const quantity = Number(item?.quantity) || 0;
    groupedItems.set(name, (groupedItems.get(name) || 0) + quantity);
  });

  return [...groupedItems.entries()]
    .map(([name, quantity]) => `${name} x${quantity}`)
    .join(' + ');
}

function sumSnapshotItemQuantity(items = []) {
  return items.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0);
}

function sumSnapshotItemLineTotals(items = []) {
  return items.reduce((sum, item) => sum + (Number(item?.lineTotal) || 0), 0);
}

function getDiscountOrderMeta(order) {
  const snapshot = parseOrderNotes(order.notes);
  return snapshot?.meta?.discountOrder ? snapshot.meta : null;
}

function pickCustomerAuditFields(customer = {}) {
  return {
    name: customer.name || null,
    title: customer.title || null,
    firstName: customer.firstName || null,
    lastName: customer.lastName || null,
    email: customer.email || null,
    phone: customer.phone || null,
    address: customer.address || null,
    city: customer.city || null,
    province: customer.province || null,
    postalCode: customer.postalCode || null,
    isActive: customer.isActive ?? null,
  };
}

function getCustomerChangedFields(before = {}, after = {}) {
  return Object.keys(after).filter((key) => String(before[key] ?? '') !== String(after[key] ?? ''));
}

function getOrderSalesItemIds(order) {
  const snapshotItems = getActiveOrderSnapshotItems(order);
  const ids = snapshotItems
    .map((item) => item?.salesItemId)
    .filter(Boolean);

  if (!ids.length && order.salesItemId) {
    ids.push(order.salesItemId);
  }

  return [...new Set(ids)];
}

function getOrderBatchNumbers(order) {
  const snapshotItems = getActiveOrderSnapshotItems(order);
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

function normalizePickupLocationText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOCATION_NOT_SET_FILTER = '__LOCATION_NOT_SET__';

function getPickupNoticeLocationValue(row) {
  if (row?.fulfillmentMethod === 'PICKUP') {
    return row.preferredPickupLocation || row.location || '';
  }

  return row?.location || '';
}

function getPickupNoticeLocationPresenceValue(row) {
  if (row?.fulfillmentMethod === 'PICKUP') {
    return row.preferredPickupLocation || '';
  }

  return row?.location || '';
}

function pickupNoticeLocationMatchesFilter(row, location, activeLocations = []) {
  if (!location) {
    return true;
  }

  const rowLocation = normalizePickupLocationText(row.pickupLocationFilterValue);

  if (location === LOCATION_NOT_SET_FILTER) {
    const assignedLocation = normalizePickupLocationText(getPickupNoticeLocationPresenceValue(row));
    if (!assignedLocation || rowLocation === 'winnipeg manitoba') {
      return true;
    }

    return !activeLocations.some((activeLocation) => {
      const normalizedActiveLocation = normalizePickupLocationText(activeLocation);
      return rowLocation.includes(normalizedActiveLocation) || normalizedActiveLocation.includes(rowLocation);
    });
  }

  return rowLocation.includes(normalizePickupLocationText(location));
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
    getDisplayOrderReference(order),
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

function orderMatchesFulfillmentFilters(order, { fulfillmentMethod, fulfillmentStatus, pickupLocation }) {
  if (!fulfillmentMethod && !fulfillmentStatus && !pickupLocation) {
    return true;
  }

  const normalizedPickupLocation = normalizePickupLocationText(pickupLocation);
  const fulfillmentItems = normalizeFulfillmentItems(order);
  return fulfillmentItems.some((item) => {
    if (fulfillmentMethod && item.fulfillmentMethod !== fulfillmentMethod) {
      return false;
    }

    if (fulfillmentStatus && item.fulfillmentStatus !== fulfillmentStatus) {
      return false;
    }

    if (
      normalizedPickupLocation &&
      !normalizePickupLocationText(item.preferredPickupLocation || order.preferredPickupLocation).includes(normalizedPickupLocation)
    ) {
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
  const items = getOrderSnapshotItems(order)
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .filter(({ item }) => !isResolvedSnapshotItem(item));

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
          preferredPickupLocation: order.preferredPickupLocation || null,
          pickupNotice: null,
          fulfilledAt: order.fulfilledAt || null,
          fulfilledByUserId: null,
          fulfilledByEmail: null,
          fulfilledByRole: null,
        },
      ];
  }

  const flattenedItems = [];
  let itemIndex = 0;

  items.forEach(({ item, sourceIndex }) => {
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
          preferredPickupLocation: item.preferredPickupLocation || order.preferredPickupLocation || null,
          saleType: item.saleType || null,
          bundleItems: [],
          isBundleComponent: true,
          bundleName: bundleChild.parentBundleName || item.name,
          pickupNotice: bundleChild.pickupNotice || null,
          fulfilledAt: bundleChild.fulfilledAt || null,
          fulfilledByUserId: bundleChild.fulfilledByUserId || null,
          fulfilledByEmail: bundleChild.fulfilledByEmail || null,
          fulfilledByRole: bundleChild.fulfilledByRole || null,
        });
      });
      return;
    }

    const fulfillmentStatus = getDefaultItemFulfillmentStatus(order, item);
    const baseQuantity = Number(item.quantity) || 0;
    const partialFulfillments = getPartialFulfillments(item);
    const partialFulfilledQuantity = fulfillmentStatus === getCompletedStatusForMethod(fulfillmentMethod)
      ? 0
      : Math.min(baseQuantity, getPartialFulfilledQuantity(item));

    partialFulfillments.forEach((partialFulfillment, partialIndex) => {
      const partialQuantity = Math.max(0, Number(partialFulfillment.quantity) || 0);
      if (!partialQuantity) {
        return;
      }

      const partialStatus = partialFulfillment.fulfillmentStatus || getCompletedStatusForMethod(fulfillmentMethod);
      flattenedItems.push({
        itemIndex: itemIndex++,
        sourceIndex,
        partialIndex,
        salesItemId: item.salesItemId,
        name: item.name,
        quantity: partialQuantity,
        originalQuantity: baseQuantity,
        lineTotal: getProRatedLineTotal(item.lineTotal, partialQuantity, baseQuantity),
        bundleLineTotal: null,
        fulfillmentMethod,
        fulfillmentStatus: partialStatus,
        fulfillmentStatusLabel: getFulfillmentStatusLabel(partialStatus),
        batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
        location: item.location || order.salesItem?.pickupInstructions || '',
        preferredPickupLocation: item.preferredPickupLocation || order.preferredPickupLocation || null,
        saleType: item.saleType || null,
        bundleItems: Array.isArray(item.bundleItems) ? item.bundleItems : [],
        isBundleComponent: false,
        isPartialFulfillment: true,
        bundleName: null,
        pickupNotice: item.pickupNotice || null,
        fulfilledAt: partialFulfillment.fulfilledAt || null,
        fulfilledByUserId: partialFulfillment.fulfilledByUserId || null,
        fulfilledByEmail: partialFulfillment.fulfilledByEmail || null,
        fulfilledByRole: partialFulfillment.fulfilledByRole || null,
      });
    });

    const displayQuantity = fulfillmentStatus === getCompletedStatusForMethod(fulfillmentMethod)
      ? baseQuantity
      : Math.max(0, baseQuantity - partialFulfilledQuantity);

    if (!displayQuantity) {
      return;
    }

    flattenedItems.push({
      itemIndex: itemIndex++,
      sourceIndex,
      salesItemId: item.salesItemId,
      name: item.name,
      quantity: displayQuantity,
      originalQuantity: baseQuantity,
      lineTotal: getProRatedLineTotal(item.lineTotal, displayQuantity, baseQuantity),
      bundleLineTotal: null,
      fulfillmentMethod,
      fulfillmentStatus,
      fulfillmentStatusLabel: getFulfillmentStatusLabel(fulfillmentStatus),
      batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
      location: item.location || order.salesItem?.pickupInstructions || '',
      preferredPickupLocation: item.preferredPickupLocation || order.preferredPickupLocation || null,
      saleType: item.saleType || null,
      bundleItems: Array.isArray(item.bundleItems) ? item.bundleItems : [],
      isBundleComponent: false,
      isPartialFulfillment: false,
      bundleName: null,
      pickupNotice: item.pickupNotice || null,
      fulfilledAt: item.fulfilledAt || null,
      fulfilledByUserId: item.fulfilledByUserId || null,
      fulfilledByEmail: item.fulfilledByEmail || null,
      fulfilledByRole: item.fulfilledByRole || null,
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

  if (query.pickupLocation) {
    const normalizedPickupLocation = normalizePickupLocationText(query.pickupLocation);
    const normalizedPreferredPickupLocation = normalizePickupLocationText(item.preferredPickupLocation);
    const normalizedItemLocation = normalizePickupLocationText(item.location);
    if (
      !normalizedPreferredPickupLocation.includes(normalizedPickupLocation) &&
      !normalizedItemLocation.includes(normalizedPickupLocation)
    ) {
      return false;
    }
  }

  return true;
}

function isCompletedFulfillmentItem(item) {
  return item?.fulfillmentStatus === 'PICKED_UP' || item?.fulfillmentStatus === 'DELIVERED';
}

function getCompletedStatusForMethod(fulfillmentMethod) {
  return fulfillmentMethod === 'DELIVERY' ? 'DELIVERED' : 'PICKED_UP';
}

function getPendingStatusForMethod(fulfillmentMethod) {
  return fulfillmentMethod === 'DELIVERY' ? 'PENDING_DELIVERY' : 'PENDING_PICKUP';
}

function getPartialFulfillments(item) {
  return Array.isArray(item?.partialFulfillments) ? item.partialFulfillments : [];
}

function getPartialFulfilledQuantity(item) {
  return getPartialFulfillments(item).reduce((sum, entry) => sum + Math.max(0, Number(entry?.quantity) || 0), 0);
}

function getProRatedLineTotal(lineTotal, quantity, totalQuantity) {
  const baseLineTotal = Number(lineTotal) || 0;
  const baseQuantity = Number(totalQuantity) || 0;
  const rowQuantity = Number(quantity) || 0;

  if (!baseLineTotal || !baseQuantity || !rowQuantity) {
    return baseLineTotal;
  }

  return Math.round((baseLineTotal * rowQuantity) / baseQuantity);
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

function getOrderPaymentSummary(order) {
  const activeSummary = summarizeSnapshotItems(getActiveOrderSnapshotItems(order));
  const resolvedItems = getResolvedOrderSnapshotItems(order);

  if (!resolvedItems.length) {
    return activeSummary;
  }

  const resolvedSummary = summarizeSnapshotItems(resolvedItems);
  const resolvedLabel = getDisplayPaymentStatus(order)
    .replace(/^PARTIALLY_/, 'Partially ')
    .toLowerCase();

  return `${activeSummary} | ${resolvedLabel}: ${resolvedSummary}`;
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

function getFulfillmentLocationName(item) {
  if (item.fulfillmentMethod === 'DELIVERY') {
    return 'Delivery';
  }

  const location = item.preferredPickupLocation || item.location;

  return String(location || '').trim() || 'Location not set';
}

function getCanonicalFulfillmentLocationName(item, pickupLocationNames = []) {
  const location = getFulfillmentLocationName(item);
  const normalizedLocation = normalizePickupLocationText(location);
  const matchedPickupLocation = pickupLocationNames.find((pickupLocation) => {
    const normalizedPickupLocation = normalizePickupLocationText(pickupLocation);
    return normalizedLocation === normalizedPickupLocation ||
      normalizedLocation.includes(normalizedPickupLocation) ||
      normalizedPickupLocation.includes(normalizedLocation);
  });

  return matchedPickupLocation || location;
}

function formatShortReportLocation(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }

  return normalized.split(' ').slice(0, 2).join(' ');
}

function buildFulfillmentLocationAnalytics(paidOrders, pickupLocationNames = []) {
  const locationMap = new Map();

  for (const order of paidOrders) {
    for (const item of order.itemDetails || []) {
      const location = getCanonicalFulfillmentLocationName(item, pickupLocationNames);
      const existing = locationMap.get(location) || {
        location,
        pendingOrders: new Set(),
        fulfilledOrders: new Set(),
        totalOrders: new Set(),
        pendingItems: 0,
        fulfilledItems: 0,
        totalItems: 0,
      };
      const orderKey = order.displayOrderReference || order.orderReference || order.id;
      const quantity = Number(item.quantity) || 0;

      existing.totalOrders.add(orderKey);
      existing.totalItems += quantity;

      if (isCompletedFulfillmentItem(item)) {
        existing.fulfilledOrders.add(orderKey);
        existing.fulfilledItems += quantity;
      } else {
        existing.pendingOrders.add(orderKey);
        existing.pendingItems += quantity;
      }

      locationMap.set(location, existing);
    }
  }

  return Array.from(locationMap.values())
    .map((entry) => {
      const percentageFulfilled = entry.totalItems > 0
        ? Number(((entry.fulfilledItems / entry.totalItems) * 100).toFixed(1))
        : 0;

      return {
        location: entry.location,
        pendingOrders: entry.pendingOrders.size,
        fulfilledOrders: entry.fulfilledOrders.size,
        totalOrders: entry.totalOrders.size,
        pendingItems: entry.pendingItems,
        fulfilledItems: entry.fulfilledItems,
        totalItems: entry.totalItems,
        percentageFulfilled,
      };
    })
    .sort((a, b) => {
      if (b.pendingItems !== a.pendingItems) {
        return b.pendingItems - a.pendingItems;
      }
      return a.location.localeCompare(b.location);
    });
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
  limit: z.coerce.number().int().min(1).max(500).default(20),
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

const customerStatementParamsSchema = z.object({
  customerId: z.string().uuid(),
});

const createCustomerNoteSchema = z.object({
  note: z.string().trim().min(1).max(4000),
  orderId: z.string().uuid().optional().nullable(),
  orderIds: z.array(z.string().uuid()).max(25).optional().default([]),
  orderReference: z.string().trim().max(80).optional().nullable(),
  messageType: z.string().trim().max(80).optional().nullable(),
});

const markCustomerNoteNotificationsReadSchema = z.object({
  noteIds: z.array(z.string().uuid()).max(100).optional().default([]),
});

const listCustomerMessagesQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(''),
  status: z.enum(['', 'UNREAD', 'READ']).optional().default(''),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const replyCustomerMessageSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(1).max(4000),
});

const sendGeneralNoticesSchema = z.object({
  customerIds: z.array(z.string().uuid()).max(200).optional().default([]),
  selectAllMatching: z.coerce.boolean().optional().default(false),
  q: z.string().trim().max(120).optional(),
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(1).max(4000),
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
  preferredPickupLocation: z.string().trim().max(180).optional(),
  paymentMethod: z.enum(['INTERAC_E_TRANSFER']).default('INTERAC_E_TRANSFER'),
  discountReason: z.string().trim().min(3).max(240),
  adminComment: z.string().trim().max(500).optional(),
  transferProof: z.object({
    fileName: z.string().trim().min(3).max(180),
    contentType: z.string().trim().regex(/^image\/[a-zA-Z0-9.+-]+$/),
    sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
    objectKey: z.string().trim().min(10).max(300),
  }),
}).superRefine((payload, ctx) => {
  const hasCustomItems = payload.items.some((item) => item.sourceType === 'CUSTOM');
  if (payload.fulfillmentMethod === 'DELIVERY' && hasCustomItems) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fulfillmentMethod'],
      message: 'Custom discount items currently support pickup only.',
    });
  }

  if (payload.fulfillmentMethod === 'PICKUP' && !payload.preferredPickupLocation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preferredPickupLocation'],
      message: 'Select pickup location.',
    });
  }

  if (payload.paymentMethod === 'INTERAC_E_TRANSFER' && !payload.transferProof) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transferProof'],
      message: 'Upload the Interac receipt before creating this discount order.',
    });
  }
});

const adminDiscountOrderUploadSchema = z.object({
  fileName: z.string().trim().min(3).max(180),
  contentType: z.string().trim().regex(/^image\/[a-zA-Z0-9.+-]+$/),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
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
  }).optional(),
});

const adminPaymentResolutionSchema = z.object({
  orderReference: z.string().uuid(),
  action: z.enum(['CANCELLED', 'REFUNDED', 'STORE_CREDIT']),
  comment: z.string().trim().min(3).max(500),
  notifyBuyer: z.boolean().default(false),
  sourceIndexes: z.array(z.number().int().min(0)).min(1).max(50),
});

const listOrdersQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(120).optional(),
  pickupLocation: z.string().trim().max(180).optional(),
  paidOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  status: z
    .enum(['PENDING_PAYMENT', 'AWAITING_MANUAL_PAYMENT', 'PAID', 'CONFIRMED', 'CANCELLED'])
    .optional(),
  paymentStatus: z
    .enum(['PENDING_PAYMENT', 'REQUIRES_ACTION', 'PENDING_REVIEW', 'SUCCEEDED', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED', 'STORE_CREDIT', 'PARTIALLY_CANCELLED', 'PARTIALLY_REFUNDED', 'PARTIALLY_STORE_CREDIT', 'PARTIALLY_RESOLVED'])
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
  pickupLocation: z.string().trim().max(180).optional(),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
  fulfillmentStatus: z.enum(['PENDING_PICKUP', 'PICKED_UP', 'PENDING_DELIVERY', 'DELIVERED']).optional(),
  reportType: z
    .enum(['orderReady', 'supplierOrders', 'salesDetails', 'fulfilledOrders', 'fulfillmentByProduct', 'allocatedPendingFulfillment', 'pendingFulfillment'])
    .default('orderReady'),
});

const listPickupNoticesQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(120).optional(),
  location: z.string().trim().max(255).optional(),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
  fulfillmentStatus: z.enum(['PENDING_PICKUP', 'PICKED_UP', 'PENDING_DELIVERY', 'DELIVERED']).optional(),
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
  channels: z.array(z.enum(['EMAIL'])).min(1),
  templateId: z.string().uuid().optional(),
  address: z.string().trim().min(3).max(255).optional(),
  readyDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timeWindow: z.string().trim().min(3).max(120).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  note: z.string().trim().max(2000).optional(),
});

const previewPickupAllocationSchema = z.object({
  availableItems: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    batchNumber: z.string().trim().max(20).optional(),
    quantity: z.coerce.number().int().min(1).max(100000),
  })).min(1).max(100),
  filters: z.object({
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    q: z.string().trim().max(120).optional(),
    batchNumber: z.string().trim().max(120).optional(),
    location: z.string().trim().max(255).optional(),
    noticeStatus: z.enum(['NOT_SENT', 'SENT']).or(z.literal('')).optional(),
    fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
  }).optional(),
});

const pickupAllocationPendingSummaryQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(120).optional(),
  location: z.string().trim().max(255).optional(),
  noticeStatus: z.enum(['NOT_SENT', 'SENT']).or(z.literal('')).optional(),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
});

const updatePreferredPickupLocationSchema = z.object({
  preferredPickupLocation: z.string().trim().min(2).max(180),
});

const updateOrderFulfillmentMethodSchema = z.object({
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']),
  preferredPickupLocation: z.string().trim().min(2).max(180).nullable().optional(),
  reason: z.string().trim().min(3).max(500),
});

const partialFulfillmentSchema = z.object({
  itemIndex: z.number().int().min(0),
  quantity: z.coerce.number().int().min(1).max(100000),
});

const undoPartialFulfillmentSchema = z.object({
  itemIndex: z.number().int().min(0),
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

    const nextStatus = payload.status ?? existingItem.status;
    const nextBatchNumber = payload.batchNumber ?? existingItem.batchNumber;
    const nextClosingDate = payload.closingDate ? new Date(payload.closingDate) : existingItem.closingDate;
    const willBeActive = nextStatus === 'ACTIVE' && nextClosingDate > new Date();

    if (willBeActive) {
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
          !isOrderResolvedAwayFromPaid(order) &&
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

    const [salesItems, pickupLocationNames] = await Promise.all([
      prisma.salesItem.findMany({
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
      }),
      getAllPickupLocationNames(),
    ]);

    const [overviewOrders, overviewSalesEvents, recentCustomers] = await Promise.all([
      prisma.order.findMany({
        select: {
          id: true,
          createdAt: true,
          paidAt: true,
          totalAmount: true,
          status: true,
          paymentStatus: true,
          payment: {
            select: {
              providerPayloadJson: true,
            },
          },
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
    const yearStart = startOfCentralYear(now);
    const monthStart = startOfCentralMonth(now);

    const paidOverviewOrders = overviewOrders.filter((order) => isOrderPaidForOverview(order));
    const liveSalesEvents = overviewSalesEvents
      .filter((item) => item.status === 'ACTIVE' && item.closingDate > now)
      .sort((a, b) => a.closingDate.getTime() - b.closingDate.getTime());
    const nextLiveEvent = liveSalesEvents[0] || null;

    const totalOrdersYtd = overviewOrders.filter((order) => isSameOrAfter(order.createdAt, yearStart)).length;
    const totalOrdersMtd = overviewOrders.filter((order) => isSameOrAfter(order.createdAt, monthStart)).length;
    const paidOrdersYtd = paidOverviewOrders.filter((order) => isSameOrAfter(order.paidAt, yearStart)).length;
    const paidOrdersMtd = paidOverviewOrders.filter((order) => isSameOrAfter(order.paidAt, monthStart)).length;
    const pendingPaymentOrders = overviewOrders.filter((order) => isOrderPendingPaymentForOverview(order)).length;
    const totalSalesYtd = paidOverviewOrders
      .filter((order) => isSameOrAfter(order.paidAt, yearStart))
      .reduce((sum, order) => sum + order.totalAmount, 0);
    const totalSalesMtd = paidOverviewOrders
      .filter((order) => isSameOrAfter(order.paidAt, monthStart))
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
        partialIndex: item.partialIndex ?? null,
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
        isPartialFulfillment: Boolean(item.isPartialFulfillment),
        bundleName: item.bundleName || null,
        bundleLineTotal: item.bundleLineTotal ?? null,
        preferredPickupLocation: item.preferredPickupLocation || order.preferredPickupLocation || null,
        location: item.location || order.salesItem?.pickupInstructions || '',
        pickupNotice: item.pickupNotice || null,
        fulfilledAt: item.fulfilledAt || null,
        fulfilledByEmail: item.fulfilledByEmail || null,
        fulfilledByRole: item.fulfilledByRole || null,
      }));

      return {
        ...order,
        displayOrderReference: getDisplayOrderReference(order),
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
    const dashboardPaidOrders = normalizedOrders.filter((order) => isOrderPaidForOverview(order));
    const paidBatchSalesComparison = buildPaidBatchSalesComparison(dashboardPaidOrders);
    const fulfillmentByLocation = buildFulfillmentLocationAnalytics(dashboardPaidOrders, pickupLocationNames);

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
      const supplierReportItemDetails = order.reportItemDetails.filter((item) => !isCompletedFulfillmentItem(item));
      const bundleComponentTotals = new Map();
      for (const item of supplierReportItemDetails) {
        if (!item.isBundleComponent) {
          continue;
        }

        const groupKey = [item.batchNumber, item.bundleName || item.name, item.bundleLineTotal ?? 0].join('::');
        bundleComponentTotals.set(groupKey, (bundleComponentTotals.get(groupKey) || 0) + item.quantity);
      }

      for (const item of supplierReportItemDetails) {
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

    const fulfilledOrderRows = paidOrders.flatMap((order) =>
      order.reportItemDetails
        .filter((item) => isCompletedFulfillmentItem(item))
        .map((item) => ({
          id: [
            order.id,
            item.sourceIndex ?? 'order',
            item.partialIndex ?? 'partial',
            item.bundleItemIndex ?? 'item',
          ].join(':'),
          orderReference: order.orderReference,
          displayOrderReference: order.displayOrderReference,
          batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
          itemName: item.name,
          quantity: item.quantity,
          buyerName: order.user?.name || 'Unknown buyer',
          buyerEmail: order.user?.email || '',
          buyerPhone: order.user?.phone || '',
          fulfillmentMethod: item.fulfillmentMethod,
          fulfillmentStatus: item.fulfillmentStatus,
          fulfillmentStatusLabel: item.fulfillmentStatusLabel,
          preferredPickupLocation: formatShortReportLocation(item.preferredPickupLocation),
          location: formatShortReportLocation(item.location),
          fulfilledAt: item.fulfilledAt || null,
          fulfilledByEmail: item.fulfilledByEmail || '',
          fulfilledByRole: item.fulfilledByRole || '',
          totalAmount: item.isBundleComponent ? (item.bundleLineTotal ?? 0) : (item.lineTotal || 0),
        }))
    );

    const allocatedPendingFulfillmentRows = paidOrders.flatMap((order) =>
      order.reportItemDetails
        .filter((item) => item.pickupNotice?.sentAt && !isCompletedFulfillmentItem(item))
        .map((item) => ({
          id: [
            order.id,
            item.sourceIndex ?? 'order',
            item.bundleItemIndex ?? 'item',
            'allocated',
          ].join(':'),
          orderReference: order.orderReference,
          displayOrderReference: order.displayOrderReference,
          batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
          itemName: item.name,
          quantity: item.quantity,
          buyerName: order.user?.name || 'Unknown buyer',
          buyerEmail: order.user?.email || '',
          buyerPhone: order.user?.phone || '',
          fulfillmentMethod: item.fulfillmentMethod,
          fulfillmentStatus: item.fulfillmentStatus,
          fulfillmentStatusLabel: item.fulfillmentStatusLabel,
          preferredPickupLocation: formatShortReportLocation(item.preferredPickupLocation),
          pickupAddress: formatShortReportLocation(item.pickupNotice?.address),
          readyDate: item.pickupNotice?.readyDate || '',
          timeWindow: item.pickupNotice?.timeWindow || '',
          noticeSentAt: item.pickupNotice?.sentAt || null,
          templateName: item.pickupNotice?.templateName || '',
        }))
    );

    const pendingFulfillmentRows = paidOrders.flatMap((order) =>
      order.reportItemDetails
        .filter((item) => !isCompletedFulfillmentItem(item))
        .map((item) => ({
          id: [
            order.id,
            item.sourceIndex ?? 'order',
            item.bundleItemIndex ?? 'item',
            'pending',
          ].join(':'),
          orderReference: order.orderReference,
          displayOrderReference: order.displayOrderReference,
          batchNumber: item.batchNumber || order.salesItem?.batchNumber || '',
          itemName: item.name,
          quantity: item.quantity,
          buyerName: order.user?.name || 'Unknown buyer',
          buyerEmail: order.user?.email || '',
          buyerPhone: order.user?.phone || '',
          fulfillmentMethod: item.fulfillmentMethod,
          fulfillmentStatus: item.fulfillmentStatus,
          fulfillmentStatusLabel: item.fulfillmentStatusLabel,
          preferredPickupLocation: formatShortReportLocation(item.preferredPickupLocation),
          pickupAddress: formatShortReportLocation(item.pickupNotice?.address),
          readyDate: item.pickupNotice?.readyDate || '',
          timeWindow: item.pickupNotice?.timeWindow || '',
          noticeSentAt: item.pickupNotice?.sentAt || null,
          templateName: item.pickupNotice?.templateName || '',
        }))
    );

    const fulfillmentProductAggregation = new Map();
    for (const order of paidOrders) {
      for (const item of order.reportItemDetails) {
        const location = getFulfillmentLocationName(item);
        const key = [item.name, item.batchNumber, location, item.fulfillmentMethod].join('::');
        const current = fulfillmentProductAggregation.get(key) || {
          id: key,
          itemName: item.name,
          batchNumber: item.batchNumber || '',
          location,
          fulfillmentMethod: item.fulfillmentMethod,
          pendingOrders: new Set(),
          fulfilledOrders: new Set(),
          totalOrders: new Set(),
          pendingQuantity: 0,
          fulfilledQuantity: 0,
          totalQuantity: 0,
        };
        const orderKey = order.displayOrderReference || order.orderReference || order.id;
        const quantity = Number(item.quantity) || 0;

        current.totalOrders.add(orderKey);
        current.totalQuantity += quantity;

        if (isCompletedFulfillmentItem(item)) {
          current.fulfilledOrders.add(orderKey);
          current.fulfilledQuantity += quantity;
        } else {
          current.pendingOrders.add(orderKey);
          current.pendingQuantity += quantity;
        }

        fulfillmentProductAggregation.set(key, current);
      }
    }

    const fulfillmentByProductRows = Array.from(fulfillmentProductAggregation.values())
      .map((entry) => ({
        id: entry.id,
        itemName: entry.itemName,
        batchNumber: entry.batchNumber,
        location: entry.location,
        fulfillmentMethod: entry.fulfillmentMethod,
        pendingOrders: entry.pendingOrders.size,
        fulfilledOrders: entry.fulfilledOrders.size,
        totalOrders: entry.totalOrders.size,
        pendingQuantity: entry.pendingQuantity,
        fulfilledQuantity: entry.fulfilledQuantity,
        totalQuantity: entry.totalQuantity,
      }))
      .sort((a, b) => {
        if (b.pendingQuantity !== a.pendingQuantity) {
          return b.pendingQuantity - a.pendingQuantity;
        }
        if (a.itemName === b.itemName) {
          return a.location.localeCompare(b.location);
        }
        return a.itemName.localeCompare(b.itemName);
      });

    return {
      filters: {
        startDate: query.startDate || null,
        endDate: query.endDate || null,
        salesItemId: query.salesItemId || null,
        batchNumber: query.batchNumber || null,
        pickupLocation: query.pickupLocation || null,
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
        pickupLocations: pickupLocationNames,
      },
      summary: {
        totalOrders: normalizedOrders.length,
        paidOrders: dashboardPaidOrders.length,
        totalRevenue: dashboardPaidOrders.reduce((sum, order) => sum + order.totalAmount, 0),
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
          fulfillmentByLocation,
          nextLiveEvent: nextLiveEvent
            ? {
                name: nextLiveEvent.name,
              batchNumber: nextLiveEvent.batchNumber,
              saleType: nextLiveEvent.saleType,
              closingDate: nextLiveEvent.closingDate,
              pickupInstructions: nextLiveEvent.pickupInstructions,
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
      fulfilledOrderRows,
      allocatedPendingFulfillmentRows,
      pendingFulfillmentRows,
      fulfillmentByProductRows,
    };
}

function sortPickupNoticeRows(rows, query) {
  const sortDirection = query.sortOrder === 'asc' ? 1 : -1;

  return [...rows].sort((left, right) => {
    if (query.sortBy === 'batchNumber') {
      return sortDirection * String(left.batchNumber || '').localeCompare(String(right.batchNumber || ''));
    }

    if (query.sortBy === 'location') {
      return sortDirection * getPickupNoticeLocationValue(left).localeCompare(getPickupNoticeLocationValue(right));
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
  const locations = await getAllPickupLocationNames();
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
        !isOrderResolvedAwayFromPaid(order) &&
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
      displayOrderReference: getDisplayOrderReference(order),
      pickupLocationFilterValue: getPickupNoticeLocationValue(item),
      noticeStatus: formatPickupNoticeStatus(item.pickupNotice),
      noticeSentAt: item.pickupNotice?.sentAt || null,
      noticeChannels: item.pickupNotice?.lastResults || {},
    })))
    .filter((row) => !query.fulfillmentMethod || row.fulfillmentMethod === query.fulfillmentMethod)
    .filter((row) => !query.fulfillmentStatus || row.fulfillmentStatus === query.fulfillmentStatus)
    .filter((row) => !query.noticeStatus || row.noticeStatus === query.noticeStatus)
    .filter((row) => pickupNoticeLocationMatchesFilter(row, query.location, locations))
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
        row.preferredPickupLocation,
        row.pickupLocationFilterValue,
      ].some((value) => includesInsensitive(value, query.q));
    });

  const rows = sortPickupNoticeRows(filteredRows, query);
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

function normalizeAllocationText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getAllocationStockKeys(row) {
  const productName = normalizeAllocationText(row.name);
  const batchNumber = normalizeAllocationText(row.batchNumber);
  return [
    `${productName}::${batchNumber}`,
    `${productName}::`,
  ];
}

function buildAllocationStock(availableItems) {
  const stock = new Map();

  for (const item of availableItems) {
    const productName = normalizeAllocationText(item.name);
    const batchNumber = normalizeAllocationText(item.batchNumber);
    const key = `${productName}::${batchNumber}`;
    stock.set(key, (stock.get(key) || 0) + item.quantity);
  }

  return stock;
}

function getAvailableQuantityForRow(stock, row) {
  return getAllocationStockKeys(row).reduce((sum, key) => sum + (stock.get(key) || 0), 0);
}

function hasAllocationStockForRow(stock, row) {
  return getAllocationStockKeys(row).some((key) => stock.has(key));
}

function consumeAllocationStock(stock, row, quantity) {
  let remaining = quantity;

  for (const key of getAllocationStockKeys(row)) {
    if (remaining <= 0) {
      break;
    }

    const available = stock.get(key) || 0;
    if (available <= 0) {
      continue;
    }

    const consumed = Math.min(available, remaining);
    stock.set(key, available - consumed);
    remaining -= consumed;
  }

  return remaining === 0;
}

function getPickupAllocationCandidateSortTime(group) {
  return new Date(group.paidAt || group.createdAt || 0).getTime();
}

function getPickupAllocationPaidDateKey(group) {
  const sortDate = new Date(group.paidAt || group.createdAt || 0);
  const { year, month, day } = getCentralDateParts(sortDate);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getPickupAllocationItemCount(group) {
  return group.items.length;
}

function getPickupAllocationTotalQuantity(group) {
  return group.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

function sortPickupAllocationCandidates(left, right) {
  const leftDateKey = getPickupAllocationPaidDateKey(left);
  const rightDateKey = getPickupAllocationPaidDateKey(right);

  if (leftDateKey !== rightDateKey) {
    return leftDateKey.localeCompare(rightDateKey);
  }

  const itemCountDiff = getPickupAllocationItemCount(right) - getPickupAllocationItemCount(left);
  if (itemCountDiff !== 0) {
    return itemCountDiff;
  }

  const quantityDiff = getPickupAllocationTotalQuantity(right) - getPickupAllocationTotalQuantity(left);
  if (quantityDiff !== 0) {
    return quantityDiff;
  }

  return getPickupAllocationCandidateSortTime(left) - getPickupAllocationCandidateSortTime(right);
}

export async function previewPickupAllocationHandler(req, res, next) {
  try {
    const payload = previewPickupAllocationSchema.parse(req.body);
    const allocationMethod = payload.filters?.fulfillmentMethod === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
    const allocationStatus = allocationMethod === 'DELIVERY' ? 'PENDING_DELIVERY' : 'PENDING_PICKUP';
    const { rows, filterOptions } = await buildPickupNoticeRows({
      ...(payload.filters || {}),
      fulfillmentMethod: allocationMethod,
      fulfillmentStatus: allocationStatus,
      sortBy: 'paidAt',
      sortOrder: 'asc',
      page: 1,
      limit: 200,
    });
    const initialStock = buildAllocationStock(payload.availableItems);
    const stock = new Map(initialStock);
    const orderGroups = new Map();

    for (const row of rows) {
      const key = row.orderReference;
      const existing = orderGroups.get(key) || {
        orderReference: row.orderReference,
        displayOrderReference: row.displayOrderReference,
        paidAt: row.paidAt,
        createdAt: row.createdAt,
        user: row.user,
        preferredPickupLocation: row.preferredPickupLocation || '',
        pickupLocation: row.pickupLocationFilterValue || row.preferredPickupLocation || row.location || '',
        items: [],
      };
      existing.items.push({
        orderReference: row.orderReference,
        displayOrderReference: row.displayOrderReference,
        itemIndex: row.itemIndex,
        name: row.name,
        batchNumber: row.batchNumber || '',
        quantity: Number(row.quantity) || 0,
        paidAt: row.paidAt,
        createdAt: row.createdAt,
        preferredPickupLocation: row.preferredPickupLocation || '',
      });
      orderGroups.set(key, existing);
    }

    const suggestions = [];
    const skipped = [];
    const candidates = Array.from(orderGroups.values()).sort(sortPickupAllocationCandidates);

    for (const candidate of candidates) {
      const allocatableItems = [];
      const shortItems = [];
      const matchingItems = candidate.items.filter((item) => hasAllocationStockForRow(initialStock, item));

      for (const item of matchingItems) {
        const availableQuantity = getAvailableQuantityForRow(stock, item);
        if (availableQuantity >= item.quantity) {
          allocatableItems.push(item);
        } else {
          shortItems.push({
            name: item.name,
            batchNumber: item.batchNumber,
            requested: item.quantity,
            available: availableQuantity,
          });
        }
      }

      if (!allocatableItems.length) {
        skipped.push({
          orderReference: candidate.orderReference,
          displayOrderReference: candidate.displayOrderReference,
          buyerName: candidate.user?.name || 'Unknown buyer',
          buyerEmail: candidate.user?.email || '',
          paidAt: candidate.paidAt || candidate.createdAt,
          pickupLocation: candidate.pickupLocation,
          items: candidate.items,
          reason: 'Insufficient stock',
          shortItems,
        });
        continue;
      }

      for (const item of allocatableItems) {
        consumeAllocationStock(stock, item, item.quantity);
      }

      suggestions.push({
        orderReference: candidate.orderReference,
        displayOrderReference: candidate.displayOrderReference,
        buyerName: candidate.user?.name || 'Unknown buyer',
        buyerEmail: candidate.user?.email || '',
        buyerPhone: candidate.user?.phone || '',
        paidAt: candidate.paidAt || candidate.createdAt,
        pickupLocation: candidate.pickupLocation,
        preferredPickupLocation: candidate.preferredPickupLocation,
        items: allocatableItems,
        skippedItems: shortItems,
        itemCount: allocatableItems.length,
        totalPendingItems: candidate.items.length,
        totalQuantity: allocatableItems.reduce((sum, item) => sum + item.quantity, 0),
        totalPendingQuantity: candidate.items.reduce((sum, item) => sum + item.quantity, 0),
      });
    }

    const remainingItems = payload.availableItems.map((item) => {
      const name = normalizeAllocationText(item.name);
      const batchNumber = normalizeAllocationText(item.batchNumber);
      const key = `${name}::${batchNumber}`;
      return {
        name: item.name,
        batchNumber: item.batchNumber || '',
        inputQuantity: item.quantity,
        remainingQuantity: stock.get(key) || 0,
      };
    });

    return res.json({
      suggestions,
      skipped,
      remainingItems,
      filterOptions,
      totalCandidates: candidates.length,
      suggestedOrders: suggestions.length,
    });
  } catch (error) {
    next(error);
  }
}

export async function pickupAllocationPendingSummaryHandler(req, res, next) {
  try {
    const query = pickupAllocationPendingSummaryQuerySchema.parse(req.query);
    const allocationMethod = query.fulfillmentMethod === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
    const allocationStatus = allocationMethod === 'DELIVERY' ? 'PENDING_DELIVERY' : 'PENDING_PICKUP';
    const { rows } = await buildPickupNoticeRows({
      ...query,
      fulfillmentMethod: allocationMethod,
      fulfillmentStatus: allocationStatus,
      sortBy: 'paidAt',
      sortOrder: 'asc',
      page: 1,
      limit: 1,
    });
    const summary = new Map();

    for (const row of rows) {
      const key = [normalizeAllocationText(row.name), normalizeAllocationText(row.batchNumber)].join('::');
      const current = summary.get(key) || {
        name: row.name,
        batchNumber: row.batchNumber || '',
        pendingQuantity: 0,
        pendingOrders: new Set(),
      };

      current.pendingQuantity += Number(row.quantity) || 0;
      current.pendingOrders.add(row.orderReference);
      summary.set(key, current);
    }

    return res.json({
      items: Array.from(summary.values()).map((item) => ({
        name: item.name,
        batchNumber: item.batchNumber,
        pendingQuantity: item.pendingQuantity,
        pendingOrders: item.pendingOrders.size,
      })),
    });
  } catch (error) {
    next(error);
  }
}

export async function sendPickupNoticesHandler(req, res, next) {
  try {
    const payload = sendPickupNoticesSchema.parse(req.body);
    let noticeTemplate = null;
    if (payload.templateId) {
      noticeTemplate = await findActivePickupNoticeTemplateById(payload.templateId);

      if (!noticeTemplate) {
        return res.status(404).json({ message: 'Pickup notice template not found or inactive.' });
      }
    }

    const noticeDetails = noticeTemplate
      ? {
          templateId: noticeTemplate.id,
          templateName: noticeTemplate.name,
          address: noticeTemplate.address,
          readyDate: noticeTemplate.readyDate,
          timeWindow: noticeTemplate.timeWindow,
          emailSubject: noticeTemplate.emailSubject || '',
          emailBody: noticeTemplate.emailBody || '',
          note: noticeTemplate.instructions || '',
        }
      : {
          templateId: null,
          templateName: '',
          address: payload.address || '',
          readyDate: payload.readyDate || '',
          timeWindow: payload.timeWindow || '',
          emailSubject: '',
          emailBody: '',
          note: payload.note || '',
        };

    if (!noticeDetails.address || !noticeDetails.readyDate || !noticeDetails.timeWindow) {
      return res.status(400).json({
        message: 'Select a pickup notice template before sending.',
      });
    }

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

      if (selectedRows.some((row) => isCompletedFulfillmentItem(row))) {
        return res.status(409).json({
          message: 'Pickup notices cannot be sent for items already marked picked up or delivered.',
        });
      }

      const itemsSummary = formatPickupNoticeItemSummary(selectedRows);
      const firstName = order.user?.firstName || order.user?.name || 'Customer';
      const displayOrderReference = getDisplayOrderReference(order);
      const preferredPickupLocation = order.fulfillmentMethod === 'PICKUP'
        ? (selectedRows.find((row) => row.preferredPickupLocation)?.preferredPickupLocation || order.preferredPickupLocation || '')
        : '';
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
              address: noticeDetails.address,
              preferredPickupLocation,
              readyDate: noticeDetails.readyDate,
              timeWindow: noticeDetails.timeWindow,
              contactName: '',
              contactPhone: '',
              emailSubject: noticeDetails.emailSubject,
              emailBody: noticeDetails.emailBody,
              note: noticeDetails.note,
            });
            channelResults.email = { status: 'sent', sentAt: nowIso };
          } catch (error) {
            channelResults.email = { status: 'failed', sentAt: nowIso, reason: error?.message || 'Email send failed.' };
          }
        } else {
          channelResults.email = { status: 'skipped', sentAt: nowIso, reason: 'Buyer email is not available.' };
        }
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
                templateId: noticeDetails.templateId,
                templateName: noticeDetails.templateName,
                address: noticeDetails.address,
                preferredPickupLocation,
                readyDate: noticeDetails.readyDate,
                timeWindow: noticeDetails.timeWindow,
                emailSubject: noticeDetails.emailSubject,
                emailBody: noticeDetails.emailBody,
                contactName: '',
                contactPhone: '',
                note: noticeDetails.note,
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
            templateId: noticeDetails.templateId,
            templateName: noticeDetails.templateName,
            address: noticeDetails.address,
            preferredPickupLocation,
            readyDate: noticeDetails.readyDate,
            timeWindow: noticeDetails.timeWindow,
            emailSubject: noticeDetails.emailSubject,
            emailBody: noticeDetails.emailBody,
            contactName: '',
            contactPhone: '',
            note: noticeDetails.note,
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
        fulfillmentMethod: selectedRows[0]?.fulfillmentMethod || order.fulfillmentMethod,
        channelResults,
        sentSuccessfully,
      });
    }

    const sentCount = results.filter((entry) => entry.sentSuccessfully).length;
    const sentMethods = new Set(results.filter((entry) => entry.sentSuccessfully).map((entry) => entry.fulfillmentMethod));
    const noticeLabel = sentMethods.size === 1 && sentMethods.has('DELIVERY') ? 'Delivery notice' : 'Pickup notice';

    return res.json({
      message: sentCount
        ? `${noticeLabel} sent for ${sentCount} order${sentCount === 1 ? '' : 's'}.`
        : `No ${noticeLabel.toLowerCase()}s were sent. Check channel availability or buyer contact details.`,
      results,
    });
  } catch (error) {
    next(error);
  }
}

export async function sendGeneralNoticesHandler(req, res, next) {
  try {
    const payload = sendGeneralNoticesSchema.parse(req.body);
    const customerIds = [...new Set(payload.customerIds || [])];
    if (!payload.selectAllMatching && customerIds.length === 0) {
      return res.status(400).json({ message: 'Select at least one customer.' });
    }

    const customers = await prisma.user.findMany({
      where: payload.selectAllMatching
        ? buildCustomerListWhere({ q: payload.q })
        : {
            id: { in: customerIds },
            role: 'USER',
          },
      orderBy: { updatedAt: 'desc' },
      take: payload.selectAllMatching ? 5000 : undefined,
      select: {
        id: true,
        name: true,
        firstName: true,
        email: true,
      },
    });

    const customerById = new Map(customers.map((customer) => [customer.id, customer]));
    const orderedCustomers = payload.selectAllMatching
      ? customers
      : customerIds
          .map((customerId) => customerById.get(customerId))
          .filter(Boolean);
    const results = [];

    for (const customer of orderedCustomers) {
      const sentAt = new Date().toISOString();
      const firstName = customer.firstName || customer.name?.split(/\s+/)[0] || 'Customer';
      if (!customer.email) {
        results.push({
          customerId: customer.id,
          name: customer.name,
          email: '',
          status: 'skipped',
          reason: 'Customer email is not available.',
          sentAt,
        });
        continue;
      }

      try {
        const messageText = payload.message.replace(/\{\{\s*Firstname\s*\}\}/gi, firstName);
        await sendMail({
          to: customer.email,
          subject: payload.subject,
          feedbackEmail: customer.email,
          text: messageText,
        });

        results.push({
          customerId: customer.id,
          name: customer.name,
          email: customer.email,
          status: 'sent',
          sentAt,
        });
      } catch (error) {
        results.push({
          customerId: customer.id,
          name: customer.name,
          email: customer.email,
          status: 'failed',
          reason: error?.message || 'Email send failed.',
          sentAt,
        });
      }
    }

    const sentCount = results.filter((entry) => entry.status === 'sent').length;
    return res.json({
      message: sentCount
        ? `General notice sent to ${sentCount} customer${sentCount === 1 ? '' : 's'}.`
        : 'No general notices were sent.',
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
          : reportType === 'fulfilledOrders'
            ? reports.fulfilledOrderRows || []
            : reportType === 'allocatedPendingFulfillment'
              ? reports.allocatedPendingFulfillmentRows || []
              : reportType === 'pendingFulfillment'
                ? reports.pendingFulfillmentRows || []
              : reportType === 'fulfillmentByProduct'
                ? reports.fulfillmentByProductRows || []
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
            : reportType === 'fulfilledOrders'
              ? [
                ['Order No', (row) => row.displayOrderReference],
                ['Batch No', (row) => row.batchNumber],
                ['Item', (row) => row.itemName],
                ['Quantity', (row) => row.quantity],
                ['Buyer Name', (row) => row.buyerName],
                ['Buyer Email', (row) => row.buyerEmail],
                ['Buyer Phone', (row) => row.buyerPhone],
                ['Fulfilment Method', (row) => row.fulfillmentMethod],
                ['Fulfilment Status', (row) => row.fulfillmentStatusLabel],
                ['Pickup Location', (row) => row.preferredPickupLocation],
                ['Sales Location', (row) => row.location],
                ['Fulfilled At', (row) => row.fulfilledAt || ''],
                ['Fulfilled By', (row) => row.fulfilledByEmail],
                ['Fulfilled By Role', (row) => row.fulfilledByRole],
                ['Total Amount (CAD)', (row) => ((row.totalAmount || 0) / 100).toFixed(2)],
                ]
              : reportType === 'allocatedPendingFulfillment'
                ? [
                  ['Order No', (row) => row.displayOrderReference],
                  ['Batch No', (row) => row.batchNumber],
                  ['Item', (row) => row.itemName],
                  ['Qty', (row) => row.quantity],
                  ['Buyer', (row) => row.buyerName],
                  ['Email', (row) => row.buyerEmail],
                  ['Phone', (row) => row.buyerPhone],
                  ['Method', (row) => row.fulfillmentMethod],
                  ['Status', (row) => row.fulfillmentStatusLabel],
                  ['Pickup Location', (row) => row.preferredPickupLocation],
                  ['Pickup Address', (row) => row.pickupAddress],
                  ['Ready Date', (row) => row.readyDate],
                  ['Time Window', (row) => row.timeWindow],
                  ['Notice Sent At', (row) => row.noticeSentAt],
                  ['Template', (row) => row.templateName],
                ]
                : reportType === 'pendingFulfillment'
                  ? [
                    ['Order No', (row) => row.displayOrderReference],
                    ['Batch No', (row) => row.batchNumber],
                    ['Item', (row) => row.itemName],
                    ['Qty', (row) => row.quantity],
                    ['Buyer', (row) => row.buyerName],
                    ['Email', (row) => row.buyerEmail],
                    ['Phone', (row) => row.buyerPhone],
                    ['Method', (row) => row.fulfillmentMethod],
                    ['Status', (row) => row.fulfillmentStatusLabel],
                    ['Pickup Location', (row) => row.preferredPickupLocation],
                    ['Pickup Address', (row) => row.pickupAddress],
                    ['Ready Date', (row) => row.readyDate],
                    ['Time Window', (row) => row.timeWindow],
                    ['Notice Sent At', (row) => row.noticeSentAt],
                    ['Template', (row) => row.templateName],
                  ]
                : reportType === 'fulfillmentByProduct'
                  ? [
                    ['Product', (row) => row.itemName],
                  ['Batch No', (row) => row.batchNumber],
                  ['Location', (row) => row.location],
                  ['Method', (row) => row.fulfillmentMethod],
                  ['To be Fulfilled Orders', (row) => row.pendingOrders],
                  ['Fulfilled Orders', (row) => row.fulfilledOrders],
                  ['Total Orders', (row) => row.totalOrders],
                  ['Pending Quantity', (row) => row.pendingQuantity],
                  ['Fulfilled Quantity', (row) => row.fulfilledQuantity],
                  ['Total Quantity', (row) => row.totalQuantity],
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
          : reportType === 'fulfilledOrders'
            ? 'fulfilled-orders-report'
            : reportType === 'allocatedPendingFulfillment'
              ? 'allocated-pending-fulfillment-report'
              : reportType === 'pendingFulfillment'
                ? 'pending-fulfillment-report'
              : reportType === 'fulfillmentByProduct'
                ? 'fulfillment-by-product-report'
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

    const snapshot = parseOrderNotes(order.notes);
    const snapshotItems = Array.isArray(snapshot?.items) && snapshot.items.length
      ? snapshot.items
      : [buildFallbackSnapshotItem(order)];
    const activeSnapshotItems = snapshotItems
      .map((item, sourceIndex) => ({ ...item, sourceIndex }))
      .filter((item) => !isResolvedSnapshotItem(item));

    if (!activeSnapshotItems.length) {
      return res.status(409).json({ message: 'There are no active items left on this order to cancel or refund.' });
    }

    const selectedIndexes = [...new Set(payload.sourceIndexes)];
    const selectedItems = activeSnapshotItems.filter((item) => selectedIndexes.includes(item.sourceIndex));

    if (!selectedItems.length) {
      return res.status(409).json({ message: 'Select at least one active item to cancel or refund.' });
    }

    if (selectedItems.length !== selectedIndexes.length) {
      return res.status(409).json({ message: 'One or more selected items are no longer available for this action.' });
    }

    const existingPayload = order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object'
      ? order.payment.providerPayloadJson
      : {};
    const resolvedAt = new Date().toISOString();
    const resolutionRecord = {
      action: payload.action,
      comment: payload.comment,
      notifyBuyer: payload.notifyBuyer,
      resolvedAt,
      resolvedByUserId: req.admin.userId,
      previousPaymentStatus: order.paymentStatus,
      previousOrderStatus: order.status,
      sourceIndexes: selectedIndexes,
      partial: selectedItems.length < activeSnapshotItems.length,
      itemsSummary: summarizeSnapshotItems(selectedItems),
      quantity: sumSnapshotItemQuantity(selectedItems),
      totalAmount: sumSnapshotItemLineTotals(selectedItems),
    };

    const nextSnapshotItems = snapshotItems.map((item, sourceIndex) => (
      selectedIndexes.includes(sourceIndex)
        ? {
            ...item,
            paymentResolution: {
              action: payload.action,
              comment: payload.comment,
              resolvedAt,
              resolvedByUserId: req.admin.userId,
            },
          }
        : item
    ));
    const remainingSnapshotItems = nextSnapshotItems.filter((item) => !isResolvedSnapshotItem(item));
    const remainingQuantity = sumSnapshotItemQuantity(remainingSnapshotItems);
    const remainingSubtotal = sumSnapshotItemLineTotals(remainingSnapshotItems);
    const nextServiceFee = remainingSnapshotItems.length ? (order.serviceFee || 0) : 0;
    const nextTotalAmount = remainingSnapshotItems.length ? remainingSubtotal + nextServiceFee : 0;
    const resolutionHistory = Array.isArray(existingPayload.adminResolutionHistory)
      ? existingPayload.adminResolutionHistory
      : [];
    const nextProviderPayload = {
      ...existingPayload,
      adminResolutionHistory: [...resolutionHistory, resolutionRecord],
    };

    if (remainingSnapshotItems.length === 0) {
      nextProviderPayload.adminResolution = resolutionRecord;
    } else if (nextProviderPayload.adminResolution) {
      delete nextProviderPayload.adminResolution;
    }

    const nextAmountDue = isPaid ? 0 : Math.max(0, nextTotalAmount - (order.storeCreditApplied || 0));
    const updatedOrder = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { orderReference: payload.orderReference },
        data: {
          quantity: remainingQuantity,
          subtotal: remainingSubtotal,
          serviceFee: nextServiceFee,
          totalAmount: nextTotalAmount,
          amountDue: nextAmountDue,
          notes: JSON.stringify({
            ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
            items: nextSnapshotItems,
          }),
          status: remainingSnapshotItems.length === 0 ? 'CANCELLED' : order.status,
          paymentStatus: remainingSnapshotItems.length === 0 ? 'FAILED' : order.paymentStatus,
          payment: {
            update: {
              status: remainingSnapshotItems.length === 0 ? 'FAILED' : order.payment?.status || order.paymentStatus,
              providerPayloadJson: nextProviderPayload,
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

      if (payload.action === 'STORE_CREDIT') {
        await issueStoreCredit({
          userId: order.userId,
          sourceOrderId: order.id,
          amount: resolutionRecord.totalAmount,
          note: `Store credit for ${resolutionRecord.itemsSummary}`,
          createdByUserId: req.admin.userId,
          client: tx,
        });
      }

      return updated;
    });

    let emailSent = false;
    if (payload.notifyBuyer && updatedOrder.user?.email) {
      try {
        const firstName = updatedOrder.user.firstName || updatedOrder.user.name?.split(' ').filter(Boolean)[0] || 'Customer';
        if (payload.action === 'REFUNDED') {
          await sendOrderRefundEmail({
            email: updatedOrder.user.email,
            firstName,
            displayOrderReference: getDisplayOrderReference(updatedOrder),
            itemsSummary: summarizeSnapshotItems(selectedItems),
            quantity: sumSnapshotItemQuantity(selectedItems),
            totalRefunded: sumSnapshotItemLineTotals(selectedItems),
            reason: payload.comment,
          });
        } else if (payload.action === 'STORE_CREDIT') {
          await sendOrderStoreCreditEmail({
            email: updatedOrder.user.email,
            firstName,
            displayOrderReference: getDisplayOrderReference(updatedOrder),
            itemsSummary: summarizeSnapshotItems(selectedItems),
            quantity: sumSnapshotItemQuantity(selectedItems),
            totalCredited: sumSnapshotItemLineTotals(selectedItems),
            reason: payload.comment,
          });
        } else {
          await sendOrderCancellationEmail({
            email: updatedOrder.user.email,
            firstName,
            displayOrderReference: getDisplayOrderReference(updatedOrder),
            itemsSummary: summarizeSnapshotItems(selectedItems),
            quantity: sumSnapshotItemQuantity(selectedItems),
            reason: payload.comment,
          });
        }
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
      message: `${payload.action === 'REFUNDED' ? 'Refund' : payload.action === 'STORE_CREDIT' ? 'Store credit' : 'Cancellation'} saved successfully.`,
      emailSent,
      resolvedItems: selectedItems,
      resolvedQuantity: sumSnapshotItemQuantity(selectedItems),
      resolvedAmount: sumSnapshotItemLineTotals(selectedItems),
      orderTotals: {
        quantity: remainingQuantity,
        subtotal: remainingSubtotal,
        serviceFee: nextServiceFee,
        totalAmount: nextTotalAmount,
      },
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
    const isFulfillmentStaff = req.admin?.role === 'PARTNER' && !req.admin?.isSuperAdmin;
    const where = buildCustomerListWhere(query);

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

    if (isFulfillmentStaff) {
      return res.json({
        items: users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
        })),
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      });
    }

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

function addStatementEntry(entries, entry) {
  if (!entry?.occurredAt) {
    return;
  }

  entries.push({
    id: entry.id,
    occurredAt: entry.occurredAt,
    type: entry.type,
    title: entry.title,
    details: entry.details || '',
    orderReference: entry.orderReference || null,
    itemSummary: entry.itemSummary || '',
    quantity: entry.quantity ?? null,
    amount: entry.amount ?? null,
    balanceImpact: entry.balanceImpact ?? null,
    method: entry.method || '',
    status: entry.status || '',
    actor: entry.actor || '',
    metadata: entry.metadata || {},
  });
}

function formatStatementOrderReference(order) {
  return order.displayOrderReference || getDisplayOrderReference(order);
}

function formatStatementItemSummary(items = []) {
  return summarizeSnapshotItems(items) || 'Order items';
}

function getStatementOrderItems(order) {
  const snapshotItems = getOrderSnapshotItems(order);
  if (snapshotItems.length) {
    return snapshotItems;
  }
  return [buildFallbackSnapshotItem(order)];
}

function buildStatementEntries({ customer, orders, storeCreditEntries, updateRequests, auditLogs }) {
  const entries = [];

  addStatementEntry(entries, {
    id: `customer-created:${customer.id}`,
    occurredAt: customer.createdAt,
    type: 'CUSTOMER_CREATED',
    title: 'Customer created',
    details: [customer.name, customer.email].filter(Boolean).join(' · '),
    status: customer.isActive ? 'Active' : 'Inactive',
  });

  if (customer.updatedAt && new Date(customer.updatedAt).getTime() !== new Date(customer.createdAt).getTime()) {
    addStatementEntry(entries, {
      id: `customer-updated:${customer.id}`,
      occurredAt: customer.updatedAt,
      type: 'CUSTOMER_UPDATED',
      title: 'Customer record updated',
      details: 'Current saved customer profile was updated.',
      status: customer.isActive ? 'Active' : 'Inactive',
    });
  }

  for (const request of updateRequests) {
    const requestedAddress = [request.address, request.city, request.province, request.postalCode].filter(Boolean).join(', ');
    addStatementEntry(entries, {
      id: `customer-update-requested:${request.id}`,
      occurredAt: request.createdAt,
      type: 'CUSTOMER_UPDATE_REQUESTED',
      title: 'Customer update requested',
      details: [`Phone: ${request.phone || '-'}`, `Address: ${requestedAddress || '-'}`].join(' · '),
      status: request.status,
    });

    if (request.reviewedAt) {
      addStatementEntry(entries, {
        id: `customer-update-reviewed:${request.id}`,
        occurredAt: request.reviewedAt,
        type: request.status === 'APPROVED' ? 'CUSTOMER_UPDATE_APPROVED' : 'CUSTOMER_UPDATE_DECLINED',
        title: request.status === 'APPROVED' ? 'Customer update approved' : 'Customer update declined',
        details: requestedAddress || request.phone || 'Customer update request reviewed.',
        status: request.status,
        actor: request.reviewedBy?.email || '',
      });
    }
  }

  for (const log of auditLogs) {
    const changedFields = Array.isArray(log.afterJson?.changedFields) ? log.afterJson.changedFields : [];
    addStatementEntry(entries, {
      id: `customer-audit:${log.id}`,
      occurredAt: log.createdAt,
      type: log.action || 'CUSTOMER_AUDIT',
      title: log.action === 'CUSTOMER_UPDATE_APPROVED' ? 'Customer details changed from approved request' : 'Customer details changed',
      details: changedFields.length ? `Changed: ${changedFields.join(', ')}` : 'Customer profile changed.',
      status: 'COMPLETED',
      actor: log.changedBy?.email || '',
      metadata: {
        before: log.beforeJson || null,
        after: log.afterJson || null,
      },
    });
  }

  for (const order of orders) {
    const orderReference = formatStatementOrderReference(order);
    const snapshotItems = getStatementOrderItems(order);
    const activeItems = snapshotItems.filter((item) => !isResolvedSnapshotItem(item));
    const resolvedItems = snapshotItems.filter((item) => isResolvedSnapshotItem(item));
    const itemSummary = formatStatementItemSummary(snapshotItems);

    addStatementEntry(entries, {
      id: `order-created:${order.id}`,
      occurredAt: order.createdAt,
      type: 'ORDER_CREATED',
      title: 'Order created',
      details: itemSummary,
      orderReference,
      itemSummary,
      quantity: sumSnapshotItemQuantity(snapshotItems),
      amount: order.totalAmount,
      method: order.paymentMethod,
      status: getDisplayPaymentStatus(order),
    });

    if (order.paidAt || isOrderPaidLike(order)) {
      addStatementEntry(entries, {
        id: `payment-paid:${order.id}`,
        occurredAt: order.paidAt || order.payment?.updatedAt || order.updatedAt,
        type: 'PAYMENT_COMPLETED',
        title: 'Payment completed',
        details: itemSummary,
        orderReference,
        itemSummary,
        quantity: sumSnapshotItemQuantity(activeItems.length ? activeItems : snapshotItems),
        amount: order.amountDue ?? order.totalAmount,
        method: order.paymentMethod,
        status: order.paymentStatus,
      });
    } else {
      addStatementEntry(entries, {
        id: `payment-status:${order.id}`,
        occurredAt: order.payment?.updatedAt || order.updatedAt || order.createdAt,
        type: 'PAYMENT_STATUS',
        title: 'Payment status',
        details: itemSummary,
        orderReference,
        itemSummary,
        amount: order.amountDue ?? order.totalAmount,
        method: order.paymentMethod,
        status: order.paymentStatus,
      });
    }

    for (const item of resolvedItems) {
      const action = item.paymentResolution?.action || 'RESOLVED';
      const resolvedAt = item.paymentResolution?.resolvedAt || order.payment?.updatedAt || order.updatedAt;
      const actionTitle = action === 'STORE_CREDIT'
        ? 'Item converted to store credit'
        : action === 'REFUNDED'
          ? 'Item refunded'
          : 'Item cancelled';

      addStatementEntry(entries, {
        id: `payment-resolution:${order.id}:${item.sourceIndex ?? item.name}:${action}`,
        occurredAt: resolvedAt,
        type: `ITEM_${action}`,
        title: actionTitle,
        details: item.paymentResolution?.comment || `${item.name} x${item.quantity}`,
        orderReference,
        itemSummary: `${item.name} x${item.quantity}`,
        quantity: Number(item.quantity) || 0,
        amount: Number(item.lineTotal) || null,
        method: order.paymentMethod,
        status: action,
      });
    }

    for (const item of normalizeFulfillmentItems(order)) {
      if (!isCompletedFulfillmentItem(item)) {
        continue;
      }

      addStatementEntry(entries, {
        id: `fulfillment:${order.id}:${item.itemIndex}`,
        occurredAt: item.fulfilledAt || order.updatedAt,
        type: item.fulfillmentStatus === 'DELIVERED' ? 'ITEM_DELIVERED' : 'ITEM_PICKED_UP',
        title: item.fulfillmentStatus === 'DELIVERED' ? 'Item delivered' : 'Item picked up',
        details: [
          `${item.name} x${item.quantity}`,
          item.preferredPickupLocation || item.location,
          item.isPartialFulfillment ? 'Partial fulfilment' : '',
        ].filter(Boolean).join(' · '),
        orderReference,
        itemSummary: `${item.name} x${item.quantity}`,
        quantity: Number(item.quantity) || 0,
        amount: Number(item.lineTotal) || null,
        method: item.fulfillmentMethod,
        status: item.fulfillmentStatus,
        actor: item.fulfilledByEmail || '',
      });
    }
  }

  for (const credit of storeCreditEntries) {
    const sourceReference = credit.sourceOrder ? formatStatementOrderReference(credit.sourceOrder) : '';
    const usedReference = credit.order ? formatStatementOrderReference(credit.order) : '';
    const isCredit = credit.type === 'CREDIT_ISSUED';

    addStatementEntry(entries, {
      id: `store-credit:${credit.id}`,
      occurredAt: credit.createdAt,
      type: credit.type,
      title: isCredit ? 'Store credit issued' : credit.type === 'CREDIT_USED' ? 'Store credit used' : 'Store credit reversed',
      details: credit.note || [sourceReference ? `From ${sourceReference}` : '', usedReference ? `Used on ${usedReference}` : ''].filter(Boolean).join(' · '),
      orderReference: usedReference || sourceReference || null,
      amount: Math.abs(Number(credit.amount) || 0),
      balanceImpact: Number(credit.amount) || 0,
      method: 'STORE_CREDIT',
      status: credit.type,
    });
  }

  return entries.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
}

export async function customerStatementHandler(req, res, next) {
  try {
    const { customerId } = customerStatementParamsSchema.parse(req.params);

    const customer = await prisma.user.findUnique({
      where: { id: customerId },
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
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!customer || customer.role !== 'USER') {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    const [orders, storeCreditEntries, updateRequests, auditLogs] = await Promise.all([
      prisma.order.findMany({
        where: { userId: customerId },
        orderBy: { createdAt: 'asc' },
        include: {
          salesItem: true,
          payment: true,
        },
      }),
      prisma.storeCreditLedger.findMany({
        where: { userId: customerId },
        orderBy: { createdAt: 'asc' },
        include: {
          order: {
            select: {
              id: true,
              orderReference: true,
              displayOrderReference: true,
              orderSequence: true,
              createdAt: true,
              user: { select: { firstName: true, name: true } },
              salesItem: { select: { batchNumber: true } },
            },
          },
          sourceOrder: {
            select: {
              id: true,
              orderReference: true,
              displayOrderReference: true,
              orderSequence: true,
              createdAt: true,
              user: { select: { firstName: true, name: true } },
              salesItem: { select: { batchNumber: true } },
            },
          },
        },
      }),
      prisma.customerUpdateRequest.findMany({
        where: { userId: customerId },
        orderBy: { createdAt: 'asc' },
        include: {
          reviewedBy: {
            select: {
              email: true,
              name: true,
            },
          },
        },
      }),
      prisma.customerAuditLog.findMany({
        where: { userId: customerId },
        orderBy: { createdAt: 'asc' },
        include: {
          changedBy: {
            select: {
              email: true,
              name: true,
            },
          },
        },
      }),
    ]);

    const entries = buildStatementEntries({
      customer,
      orders,
      storeCreditEntries,
      updateRequests,
      auditLogs,
    });

    const storeCreditBalance = storeCreditEntries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    const paidOrders = orders.filter((order) => isOrderPaidLike(order));

    return res.json({
      customer,
      summary: {
        totalOrders: orders.length,
        paidOrders: paidOrders.length,
        totalPaidAmount: paidOrders.reduce((sum, order) => sum + (Number(order.totalAmount) || 0), 0),
        storeCreditBalance,
        entries: entries.length,
      },
      entries,
    });
  } catch (error) {
    next(error);
  }
}

function formatCustomerNote(note) {
  return {
    id: note.id,
    userId: note.userId,
    orderId: note.orderId,
    orderReferences: Array.isArray(note.orderReferences) ? note.orderReferences : [],
    orderReference: Array.isArray(note.orderReferences) && note.orderReferences.length
      ? note.orderReferences.join(', ')
      : note.order
      ? getDisplayOrderReference(note.order)
      : '',
    source: note.source,
    note: note.note,
    messageType: note.messageType,
    readAt: note.readAt || null,
    readBy: note.readBy
      ? {
          id: note.readBy.id,
          name: note.readBy.name,
          email: note.readBy.email,
        }
      : null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    createdBy: note.createdBy
      ? {
          id: note.createdBy.id,
          name: note.createdBy.name,
          email: note.createdBy.email,
        }
      : null,
  };
}

function formatRawCustomerNote(row) {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    orderReferences: Array.isArray(row.order_references) ? row.order_references : [],
    orderReference: Array.isArray(row.order_references) && row.order_references.length
      ? row.order_references.join(', ')
      : row.order_reference || '',
    source: row.source,
    note: row.note,
    messageType: row.message_type,
    readAt: row.read_at || null,
    readBy: row.read_by_user_id
      ? {
          id: row.read_by_user_id,
          name: row.read_by_name,
          email: row.read_by_email,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          name: row.created_by_name,
          email: row.created_by_email,
        }
      : null,
  };
}

async function getCustomerOrderOptions(customerId) {
  const orders = await prisma.order.findMany({
    where: { userId: customerId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      orderReference: true,
      displayOrderReference: true,
      orderSequence: true,
      createdAt: true,
      user: { select: { firstName: true, name: true } },
      salesItem: { select: { batchNumber: true, name: true } },
    },
  });

  return orders.map((order) => ({
    id: order.id,
    label: getDisplayOrderReference(order),
    itemName: order.salesItem?.name || '',
    batchNumber: order.salesItem?.batchNumber || '',
    createdAt: order.createdAt,
  }));
}

async function findCustomerForAdmin(customerId) {
  const customer = await prisma.user.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      address: true,
      isActive: true,
      role: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!customer || customer.role !== 'USER') {
    return null;
  }

  return customer;
}

export async function listCustomerNotesHandler(req, res, next) {
  try {
    const { customerId } = customerStatementParamsSchema.parse(req.params);
    const customer = await findCustomerForAdmin(customerId);

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    const orderOptions = await getCustomerOrderOptions(customerId);
    const notes = prisma.customerNote
      ? await prisma.customerNote.findMany({
          where: { userId: customerId },
          orderBy: { createdAt: 'desc' },
          include: {
            createdBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            order: {
              select: {
                id: true,
                orderReference: true,
                displayOrderReference: true,
                orderSequence: true,
                createdAt: true,
                user: { select: { firstName: true, name: true } },
                salesItem: { select: { batchNumber: true } },
              },
            },
          },
        })
      : await prisma.$queryRaw`
          SELECT
            cn.id,
            cn.user_id,
            cn.order_id,
            cn.order_references,
            COALESCE(o.display_order_reference, o.order_reference) AS order_reference,
            cn.source,
            cn.note,
            cn.message_type,
            cn.read_at,
            cn.read_by_user_id,
            reader.name AS read_by_name,
            reader.email AS read_by_email,
            cn.created_by_user_id,
            u.name AS created_by_name,
            u.email AS created_by_email,
            cn.created_at,
            cn.updated_at
          FROM customer_notes cn
          LEFT JOIN orders o ON o.id = cn.order_id
          LEFT JOIN users u ON u.id = cn.created_by_user_id
          LEFT JOIN users reader ON reader.id = cn.read_by_user_id
          WHERE cn.user_id = ${customerId}
          ORDER BY cn.created_at DESC
        `;

    return res.json({
      customer,
      orderOptions,
      items: notes.map((note) => (prisma.customerNote ? formatCustomerNote(note) : formatRawCustomerNote(note))),
    });
  } catch (error) {
    next(error);
  }
}

export async function createCustomerNoteHandler(req, res, next) {
  try {
    const { customerId } = customerStatementParamsSchema.parse(req.params);
    const payload = createCustomerNoteSchema.parse(req.body);
    const customer = await findCustomerForAdmin(customerId);

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found.' });
    }

    const orderReference = payload.orderReference?.trim() || '';
    const requestedOrderIds = [...new Set([
      ...payload.orderIds,
      ...(payload.orderId ? [payload.orderId] : []),
    ])];
    let orders = [];

    if (requestedOrderIds.length) {
      orders = await prisma.order.findMany({
        where: {
          id: { in: requestedOrderIds },
          userId: customerId,
        },
        select: {
          id: true,
          orderReference: true,
          displayOrderReference: true,
          orderSequence: true,
          createdAt: true,
          user: { select: { firstName: true, name: true } },
          salesItem: { select: { batchNumber: true } },
        },
      });

      if (orders.length !== requestedOrderIds.length) {
        return res.status(404).json({ message: 'One or more selected orders were not found for this customer.' });
      }

      orders = requestedOrderIds
        .map((orderId) => orders.find((entry) => entry.id === orderId))
        .filter(Boolean);
    } else if (orderReference) {
      const order = await prisma.order.findFirst({
        where: {
          userId: customerId,
          OR: [
            { displayOrderReference: orderReference },
            { orderReference },
          ],
        },
        select: {
          id: true,
          orderReference: true,
          displayOrderReference: true,
          orderSequence: true,
          createdAt: true,
          user: { select: { firstName: true, name: true } },
          salesItem: { select: { batchNumber: true } },
        },
      });

      if (!order) {
        return res.status(404).json({ message: 'No matching order found for this customer.' });
      }

      orders = [order];
    }

    const primaryOrder = orders[0] || null;
    const orderReferences = orders.map((order) => getDisplayOrderReference(order)).filter(Boolean);

    const note = prisma.customerNote
      ? await prisma.customerNote.create({
          data: {
            userId: customerId,
            orderId: primaryOrder?.id || null,
            orderReferences,
            source: 'ADMIN',
            note: payload.note,
            messageType: payload.messageType?.trim() || null,
            createdByUserId: req.admin?.userId || null,
          },
          include: {
            createdBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            order: {
              select: {
                id: true,
                orderReference: true,
                displayOrderReference: true,
                orderSequence: true,
                createdAt: true,
                user: { select: { firstName: true, name: true } },
                salesItem: { select: { batchNumber: true } },
              },
            },
          },
        })
      : (await prisma.$queryRaw`
          WITH inserted AS (
            INSERT INTO customer_notes (
              user_id,
              order_id,
              order_references,
              source,
              note,
              message_type,
              created_by_user_id
            )
            VALUES (
              ${customerId},
              ${primaryOrder?.id || null},
              ${orderReferences},
              'ADMIN',
              ${payload.note},
              ${payload.messageType?.trim() || null},
              ${req.admin?.userId || null}
            )
            RETURNING *
          )
          SELECT
            inserted.id,
            inserted.user_id,
            inserted.order_id,
            inserted.order_references,
            COALESCE(o.display_order_reference, o.order_reference) AS order_reference,
            inserted.source,
            inserted.note,
            inserted.message_type,
            inserted.created_by_user_id,
            u.name AS created_by_name,
            u.email AS created_by_email,
            inserted.created_at,
            inserted.updated_at
          FROM inserted
          LEFT JOIN orders o ON o.id = inserted.order_id
          LEFT JOIN users u ON u.id = inserted.created_by_user_id
        `)[0];

    return res.status(201).json({
      message: 'Customer note saved successfully.',
      note: prisma.customerNote ? formatCustomerNote(note) : formatRawCustomerNote(note),
    });
  } catch (error) {
    next(error);
  }
}

function formatCustomerNoteNotification(note) {
  const formatted = prisma.customerNote ? formatCustomerNote(note) : formatRawCustomerNote(note);
  const customer = note.user || {
    id: note.user_id,
    name: note.customer_name,
    email: note.customer_email,
    phone: note.customer_phone,
    isActive: note.customer_is_active,
  };

  return {
    ...formatted,
    customer: {
      id: customer.id,
      name: customer.name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      isActive: customer.isActive ?? customer.customer_is_active ?? true,
    },
  };
}

function formatCustomerMessage(row) {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    orderReferences: Array.isArray(row.order_references) ? row.order_references : [],
    orderReference: Array.isArray(row.order_references) && row.order_references.length
      ? row.order_references.join(', ')
      : row.order_reference || '',
    source: row.source,
    note: row.note,
    messageType: row.message_type,
    readAt: row.read_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          name: row.created_by_name,
          email: row.created_by_email,
        }
      : null,
    customer: {
      id: row.customer_id || row.user_id,
      name: row.customer_name || '',
      email: row.customer_email || '',
      phone: row.customer_phone || '',
      isActive: row.customer_is_active ?? true,
    },
  };
}

export async function listCustomerMessagesHandler(req, res, next) {
  try {
    const query = listCustomerMessagesQuerySchema.parse(req.query);
    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;
    const search = query.q.trim();

    const whereSql = Prisma.sql`
      cn.source = 'CUSTOMER'
      ${query.status === 'UNREAD' ? Prisma.sql`AND cn.read_at IS NULL` : Prisma.empty}
      ${query.status === 'READ' ? Prisma.sql`AND cn.read_at IS NOT NULL` : Prisma.empty}
      ${search
        ? Prisma.sql`AND (
            customer.name ILIKE ${`%${search}%`}
            OR customer.email ILIKE ${`%${search}%`}
            OR customer.phone ILIKE ${`%${search}%`}
            OR cn.note ILIKE ${`%${search}%`}
            OR COALESCE(o.display_order_reference, o.order_reference) ILIKE ${`%${search}%`}
          )`
        : Prisma.empty}
    `;

    const [countRows, rows] = await Promise.all([
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM customer_notes cn
        JOIN users customer ON customer.id = cn.user_id
        LEFT JOIN orders o ON o.id = cn.order_id
        WHERE ${whereSql}
      `,
      prisma.$queryRaw`
        SELECT
          cn.id,
          cn.user_id,
          cn.order_id,
          cn.order_references,
          COALESCE(o.display_order_reference, o.order_reference) AS order_reference,
          cn.source,
          cn.note,
          cn.message_type,
          cn.read_at,
          cn.created_by_user_id,
          actor.name AS created_by_name,
          actor.email AS created_by_email,
          cn.created_at,
          cn.updated_at,
          customer.id AS customer_id,
          customer.name AS customer_name,
          customer.email AS customer_email,
          customer.phone AS customer_phone,
          customer.is_active AS customer_is_active
        FROM customer_notes cn
        JOIN users customer ON customer.id = cn.user_id
        LEFT JOIN orders o ON o.id = cn.order_id
        LEFT JOIN users actor ON actor.id = cn.created_by_user_id
        WHERE ${whereSql}
        ORDER BY cn.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
    ]);

    const total = Number(countRows?.[0]?.count || 0);

    return res.json({
      items: rows.map((row) => formatCustomerMessage(row)),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    next(error);
  }
}

export async function replyCustomerMessageHandler(req, res, next) {
  try {
    const noteId = z.string().uuid().parse(req.params.noteId);
    const payload = replyCustomerMessageSchema.parse(req.body);

    const messageRows = await prisma.$queryRaw`
      SELECT
        cn.id,
        cn.user_id,
        cn.order_id,
        cn.order_references,
        COALESCE(o.display_order_reference, o.order_reference) AS order_reference,
        cn.note,
        cn.message_type,
        customer.name AS customer_name,
        customer.email AS customer_email
      FROM customer_notes cn
      JOIN users customer ON customer.id = cn.user_id
      LEFT JOIN orders o ON o.id = cn.order_id
      WHERE cn.id = ${noteId}
        AND cn.source = 'CUSTOMER'
      LIMIT 1
    `;
    const message = messageRows?.[0];

    if (!message) {
      return res.status(404).json({ message: 'Customer message not found.' });
    }

    await sendMail({
      to: message.customer_email,
      subject: payload.subject,
      text: payload.message,
      feedbackEmail: message.customer_email,
    });

    const readAt = new Date();
    const readByUserId = req.admin?.userId || null;
    await prisma.$executeRaw`
      UPDATE customer_notes
      SET read_at = COALESCE(read_at, ${readAt}),
          read_by_user_id = COALESCE(read_by_user_id, ${readByUserId}),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${noteId}
    `;

    const insertedRows = await prisma.$queryRaw`
      WITH inserted AS (
        INSERT INTO customer_notes (
          user_id,
          order_id,
          order_references,
          source,
          note,
          message_type,
          created_by_user_id
        )
        VALUES (
          ${message.user_id},
          ${message.order_id || null},
          ${Array.isArray(message.order_references) ? message.order_references : []},
          'ADMIN',
          ${payload.message},
          'MESSAGE_REPLY',
          ${readByUserId}
        )
        RETURNING *
      )
      SELECT
        inserted.id,
        inserted.user_id,
        inserted.order_id,
        inserted.order_references,
        COALESCE(o.display_order_reference, o.order_reference) AS order_reference,
        inserted.source,
        inserted.note,
        inserted.message_type,
        inserted.read_at,
        inserted.created_by_user_id,
        actor.name AS created_by_name,
        actor.email AS created_by_email,
        inserted.created_at,
        inserted.updated_at,
        customer.id AS customer_id,
        customer.name AS customer_name,
        customer.email AS customer_email,
        customer.phone AS customer_phone,
        customer.is_active AS customer_is_active
      FROM inserted
      JOIN users customer ON customer.id = inserted.user_id
      LEFT JOIN orders o ON o.id = inserted.order_id
      LEFT JOIN users actor ON actor.id = inserted.created_by_user_id
    `;

    return res.status(201).json({
      message: 'Reply sent successfully.',
      reply: insertedRows?.[0] ? formatCustomerMessage(insertedRows[0]) : null,
    });
  } catch (error) {
    next(error);
  }
}

export async function listCustomerNoteNotificationsHandler(req, res, next) {
  try {
    const [unreadCount, notes] = await Promise.all([
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM customer_notes
        WHERE source = 'CUSTOMER'
          AND read_at IS NULL
      `,
      prisma.$queryRaw`
        SELECT
          cn.id,
          cn.user_id,
          cn.order_id,
          cn.order_references,
          COALESCE(o.display_order_reference, o.order_reference) AS order_reference,
          cn.source,
          cn.note,
          cn.message_type,
          cn.read_at,
          cn.read_by_user_id,
          reader.name AS read_by_name,
          reader.email AS read_by_email,
          cn.created_by_user_id,
          actor.name AS created_by_name,
          actor.email AS created_by_email,
          cn.created_at,
          cn.updated_at,
          customer.name AS customer_name,
          customer.email AS customer_email,
          customer.phone AS customer_phone,
          customer.is_active AS customer_is_active
        FROM customer_notes cn
        JOIN users customer ON customer.id = cn.user_id
        LEFT JOIN orders o ON o.id = cn.order_id
        LEFT JOIN users actor ON actor.id = cn.created_by_user_id
        LEFT JOIN users reader ON reader.id = cn.read_by_user_id
        WHERE cn.source = 'CUSTOMER'
          AND cn.read_at IS NULL
        ORDER BY cn.created_at DESC
        LIMIT 20
      `,
    ]);

    const count = Array.isArray(unreadCount) ? Number(unreadCount[0]?.count || 0) : Number(unreadCount || 0);

    return res.json({
      unreadCount: count,
      items: notes.map((note) => formatCustomerNoteNotification(note)),
    });
  } catch (error) {
    next(error);
  }
}

export async function markCustomerNoteNotificationsReadHandler(req, res, next) {
  try {
    const payload = markCustomerNoteNotificationsReadSchema.parse(req.body || {});
    const noteIds = [...new Set(payload.noteIds)];
    const readAt = new Date();
    const readByUserId = req.admin?.userId || null;

    const result = noteIds.length
      ? await prisma.$executeRaw`
          UPDATE customer_notes
          SET read_at = ${readAt},
              read_by_user_id = ${readByUserId},
              updated_at = CURRENT_TIMESTAMP
          WHERE source = 'CUSTOMER'
            AND read_at IS NULL
            AND id = ANY(${noteIds})
        `
      : await prisma.$executeRaw`
          UPDATE customer_notes
          SET read_at = ${readAt},
              read_by_user_id = ${readByUserId},
              updated_at = CURRENT_TIMESTAMP
          WHERE source = 'CUSTOMER'
            AND read_at IS NULL
        `;

    return res.json({
      message: `${result} note${result === 1 ? '' : 's'} marked as read.`,
      markedRead: result,
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
      select: {
        id: true,
        role: true,
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
      },
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

    const beforeJson = pickCustomerAuditFields(existingCustomer);
    const updatedCustomer = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
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
      });

      const afterJson = pickCustomerAuditFields(updated);
      const changedFields = getCustomerChangedFields(beforeJson, afterJson);
      if (changedFields.length) {
        await tx.customerAuditLog.create({
          data: {
            userId: customerId,
            action: 'ADMIN_CUSTOMER_UPDATED',
            beforeJson,
            afterJson: {
              ...afterJson,
              changedFields,
            },
            changedByUserId: req.admin?.userId || null,
          },
        });
      }

      return updated;
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
            isActive: true,
          },
        },
      },
    });

    if (!existingRequest) {
      return res.status(404).json({ message: 'Customer update request not found.' });
    }

    if (existingRequest.status !== 'PENDING') {
      return res.status(409).json({ message: 'This customer update request has already been reviewed.' });
    }

    await prisma.$transaction(async (tx) => {
      const beforeJson = pickCustomerAuditFields(existingRequest.user);
      const updatedUser = await tx.user.update({
        where: { id: existingRequest.userId },
        data: {
          phone: existingRequest.phone,
          address: existingRequest.address,
          city: existingRequest.city,
          province: existingRequest.province,
          postalCode: existingRequest.postalCode,
        },
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
        },
      });

      await tx.customerUpdateRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedByUserId: req.admin.userId,
        },
      });

      const afterJson = pickCustomerAuditFields(updatedUser);
      const changedFields = getCustomerChangedFields(beforeJson, afterJson);
      if (changedFields.length) {
        await tx.customerAuditLog.create({
          data: {
            userId: existingRequest.userId,
            action: 'CUSTOMER_UPDATE_APPROVED',
            beforeJson,
            afterJson: {
              ...afterJson,
              changedFields,
              requestId,
            },
            changedByUserId: req.admin?.userId || null,
          },
        });
      }
    });

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
        ...(query.paymentStatus && !['CANCELLED', 'REFUNDED', 'STORE_CREDIT', 'PARTIALLY_CANCELLED', 'PARTIALLY_REFUNDED', 'PARTIALLY_STORE_CREDIT', 'PARTIALLY_RESOLVED'].includes(query.paymentStatus) ? { paymentStatus: query.paymentStatus } : {}),
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
        getDisplayOrderReference(order),
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
      displayOrderReference: getDisplayOrderReference(order),
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
    if (payload.transferProof && !isValidScopedReceiptObjectKey('discount-orders', payload.transferProof.objectKey)) {
      return res.status(409).json({ message: 'Uploaded receipt does not match the discount order upload path.' });
    }

    const order = await createAdminDiscountOrder({
      ...payload,
      adminUserId: req.admin.userId,
    });

    return res.status(201).json({
      message: 'Discount order created and sent to pending review.',
      order,
    });
  } catch (error) {
    next(error);
  }
}

export async function createAdminDiscountOrderUploadHandler(req, res, next) {
  try {
    const payload = adminDiscountOrderUploadSchema.parse(req.body);
    const uploadTarget = await createScopedTransferProofUploadTarget({
      scopeKey: 'discount-orders',
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

export async function updatePreferredPickupLocationHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const payload = updatePreferredPickupLocationSchema.parse(req.body);

    const order = await prisma.order.findUnique({
      where: { orderReference },
      select: {
        id: true,
        notes: true,
        fulfillmentMethod: true,
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.fulfillmentMethod !== 'PICKUP') {
      return res.status(409).json({ message: 'Preferred pickup location can only be set for pickup orders.' });
    }

    const isActivePickupLocation = await hasActivePickupLocation(payload.preferredPickupLocation);
    if (!isActivePickupLocation) {
      return res.status(409).json({ message: 'Selected pickup location is no longer active.' });
    }

    const snapshot = parseOrderNotes(order.notes);
    const nextItems = Array.isArray(snapshot?.items)
      ? snapshot.items.map((item) => ({
          ...item,
          preferredPickupLocation: payload.preferredPickupLocation,
        }))
      : undefined;

    const updatedOrder = await prisma.order.update({
      where: { orderReference },
      data: {
        preferredPickupLocation: payload.preferredPickupLocation,
        ...(nextItems
          ? {
              notes: JSON.stringify({
                ...(snapshot || {}),
                preferredPickupLocation: payload.preferredPickupLocation,
                items: nextItems,
              }),
            }
          : {}),
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

    return res.json({
      message: 'Preferred pickup location updated successfully.',
      order: {
        ...updatedOrder,
        displayOrderReference: getDisplayOrderReference(updatedOrder),
        fulfillmentItems: normalizeFulfillmentItems(updatedOrder),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function updateOrderFulfillmentMethodHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const payload = updateOrderFulfillmentMethodSchema.parse(req.body);
    const nextPickupLocation = payload.fulfillmentMethod === 'PICKUP'
      ? payload.preferredPickupLocation || ''
      : null;

    if (payload.fulfillmentMethod === 'PICKUP') {
      if (!nextPickupLocation) {
        return res.status(400).json({ message: 'Select a preferred pickup location for a pickup order.' });
      }

      const isActivePickupLocation = await hasActivePickupLocation(nextPickupLocation);
      if (!isActivePickupLocation) {
        return res.status(409).json({ message: 'Selected pickup location is no longer active.' });
      }
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { orderReference },
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

      if (!order) {
        return { status: 404, message: 'Order not found.' };
      }

      if (order.status === 'CANCELLED') {
        return { status: 409, message: 'Cancelled orders cannot have their pickup or delivery method changed.' };
      }

      const snapshot = parseOrderNotes(order.notes) || {};
      const sourceItems = Array.isArray(snapshot.items) ? snapshot.items : [buildFallbackSnapshotItem(order)];
      const activeItems = sourceItems.filter((item) => !isResolvedSnapshotItem(item));

      if (!activeItems.length) {
        return { status: 409, message: 'This order has no active items available for fulfillment.' };
      }

      const fulfillmentHasStarted = activeItems.some((item) => {
        const children = Array.isArray(item.fulfillmentChildren) ? item.fulfillmentChildren : [];
        return isCompletedFulfillmentItem(item)
          || Boolean(item.fulfilledAt)
          || getPartialFulfillments(item).length > 0
          || children.some((child) => (
            isCompletedFulfillmentItem(child)
            || Boolean(child.fulfilledAt)
            || getPartialFulfillments(child).length > 0
          ));
      });

      if (fulfillmentHasStarted || ['PICKED_UP', 'DELIVERED'].includes(order.fulfillmentStatus)) {
        return { status: 409, message: 'Pickup or delivery cannot be changed after fulfillment has started.' };
      }

      if (payload.fulfillmentMethod === 'DELIVERY') {
        const missingAddressFields = ['address', 'city', 'province', 'postalCode']
          .filter((field) => !String(order.user?.[field] || '').trim());
        if (missingAddressFields.length) {
          return {
            status: 409,
            message: 'Add a complete customer delivery address before changing this order to delivery.',
          };
        }
      }

      if (
        order.fulfillmentMethod === payload.fulfillmentMethod
        && (order.preferredPickupLocation || null) === nextPickupLocation
      ) {
        return { status: 409, message: 'The order already uses these pickup or delivery details.' };
      }

      const changedAt = new Date().toISOString();
      const pendingStatus = getPendingStatusForMethod(payload.fulfillmentMethod);
      let noticeReset = false;

      const updateFulfillmentEntity = (entity) => {
        const currentNotice = entity?.pickupNotice;
        const existingNoticeHistory = Array.isArray(entity?.fulfillmentNoticeHistory)
          ? entity.fulfillmentNoticeHistory
          : [];
        if (currentNotice?.sentAt) {
          noticeReset = true;
        }

        return {
          ...entity,
          fulfillmentMethod: payload.fulfillmentMethod,
          fulfillmentStatus: pendingStatus,
          preferredPickupLocation: nextPickupLocation,
          fulfilledAt: null,
          fulfilledByUserId: null,
          fulfilledByEmail: null,
          fulfilledByRole: null,
          ...(currentNotice
            ? {
                fulfillmentNoticeHistory: [
                  ...existingNoticeHistory,
                  {
                    ...currentNotice,
                    supersededAt: changedAt,
                    supersededReason: 'FULFILLMENT_METHOD_CHANGED',
                  },
                ],
                pickupNotice: null,
              }
            : {}),
        };
      };

      const nextItems = sourceItems.map((item) => {
        if (isResolvedSnapshotItem(item)) {
          return item;
        }

        const nextItem = updateFulfillmentEntity(item);
        return {
          ...nextItem,
          fulfillmentChildren: Array.isArray(item.fulfillmentChildren)
            ? item.fulfillmentChildren.map(updateFulfillmentEntity)
            : item.fulfillmentChildren,
        };
      });

      const fulfillmentMethodHistory = Array.isArray(snapshot.fulfillmentMethodHistory)
        ? snapshot.fulfillmentMethodHistory
        : [];
      const nextNotes = {
        ...snapshot,
        fulfillmentMethod: payload.fulfillmentMethod,
        fulfillmentStatus: pendingStatus,
        preferredPickupLocation: nextPickupLocation,
        items: nextItems,
        fulfillmentMethodHistory: [
          ...fulfillmentMethodHistory,
          {
            previousMethod: order.fulfillmentMethod,
            nextMethod: payload.fulfillmentMethod,
            previousPickupLocation: order.preferredPickupLocation || null,
            nextPickupLocation,
            reason: payload.reason,
            changedAt,
            changedByUserId: req.admin?.userId || null,
            changedByEmail: req.admin?.email || null,
            changedByRole: req.admin?.role || null,
          },
        ],
      };

      const updateResult = await tx.order.updateMany({
        where: {
          id: order.id,
          updatedAt: order.updatedAt,
          fulfillmentStatus: order.fulfillmentStatus,
        },
        data: {
          fulfillmentMethod: payload.fulfillmentMethod,
          fulfillmentStatus: pendingStatus,
          preferredPickupLocation: nextPickupLocation,
          notes: JSON.stringify(nextNotes),
        },
      });

      if (updateResult.count !== 1) {
        return {
          status: 409,
          message: 'This order changed while you were editing it. Reopen Payment details and try again.',
        };
      }

      const updatedOrder = await tx.order.findUnique({
        where: { id: order.id },
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

      return { updatedOrder, noticeReset };
    });

    if (outcome.status) {
      return res.status(outcome.status).json({ message: outcome.message });
    }

    return res.json({
      message: `Order changed to ${payload.fulfillmentMethod === 'DELIVERY' ? 'delivery' : 'pickup'} successfully.${outcome.noticeReset ? ' Send a new fulfillment notice to the customer.' : ''}`,
      noticeReset: outcome.noticeReset,
      order: {
        ...outcome.updatedOrder,
        displayOrderReference: getDisplayOrderReference(outcome.updatedOrder),
        fulfillmentItems: normalizeFulfillmentItems(outcome.updatedOrder),
      },
    });
  } catch (error) {
    next(error);
  }
}

function serializeFulfillmentOrderForPartner(order) {
  return {
    id: order.id,
    orderReference: order.orderReference,
    displayOrderReference: order.displayOrderReference,
    orderSequence: order.orderSequence,
    quantity: order.quantity,
    totalAmount: order.totalAmount,
    paymentMethod: order.paymentMethod,
    paymentStatus: getDisplayPaymentStatus(order),
    status: order.status,
    fulfillmentMethod: order.fulfillmentMethod,
    fulfillmentStatus: order.fulfillmentStatus,
    preferredPickupLocation: order.preferredPickupLocation,
    unitPrice: order.unitPrice,
    currency: order.currency,
    subtotal: order.subtotal,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    user: order.user
      ? {
          id: order.user.id,
          name: order.user.name,
          email: order.user.email,
          phone: order.user.phone,
          address: order.user.address,
          city: order.user.city,
          province: order.user.province,
          postalCode: order.user.postalCode,
        }
      : null,
    salesItem: order.salesItem
      ? {
          id: order.salesItem.id,
          name: order.salesItem.name,
          batchNumber: order.salesItem.batchNumber,
          pickupInstructions: order.salesItem.pickupInstructions,
        }
      : null,
    fulfillmentItems: order.fulfillmentItems,
  };
}

export async function listOrdersHandler(req, res, next) {
  try {
    const query = listOrdersQuerySchema.parse(req.query);
    const isFulfillmentStaff = req.admin?.role === 'PARTNER' && !req.admin?.isSuperAdmin;

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.paymentStatus && !['CANCELLED', 'REFUNDED', 'STORE_CREDIT', 'PARTIALLY_CANCELLED', 'PARTIALLY_REFUNDED', 'PARTIALLY_STORE_CREDIT', 'PARTIALLY_RESOLVED'].includes(query.paymentStatus) ? { paymentStatus: query.paymentStatus } : {}),
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
          !isOrderResolvedAwayFromPaid(order) &&
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
            displayOrderReference: getDisplayOrderReference(updated, {
              batchNumber: order.salesItem?.batchNumber,
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
        displayOrderReference: getDisplayOrderReference(order),
        fulfillmentItems,
      };
    }).filter((order) =>
      orderMatchesDateRange(order, {
        startDate: query.startDate,
        endDate: query.endDate,
      }) &&
      (isFulfillmentStaff || query.paidOnly === true ? isOrderPaidLike(order) : true) &&
      (!isFulfillmentStaff && query.paymentStatus ? getDisplayPaymentStatus(order) === query.paymentStatus : true) &&
      orderMatchesBatchNumber(order, query.batchNumber) &&
      orderMatchesTextQuery(order, query.q) &&
      orderMatchesFulfillmentFilters(order, {
        fulfillmentMethod: query.fulfillmentMethod,
        fulfillmentStatus: query.fulfillmentStatus,
        pickupLocation: query.pickupLocation,
      }),
    );

    const total = normalizedOrders.length;
    const skip = (query.page - 1) * query.limit;
    const pagedOrders = normalizedOrders.slice(skip, skip + query.limit);

    return res.json({
      items: isFulfillmentStaff ? pagedOrders.map(serializeFulfillmentOrderForPartner) : pagedOrders,
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
      ...(query.paymentStatus && !['CANCELLED', 'REFUNDED', 'STORE_CREDIT', 'PARTIALLY_CANCELLED', 'PARTIALLY_REFUNDED', 'PARTIALLY_STORE_CREDIT', 'PARTIALLY_RESOLVED'].includes(query.paymentStatus) ? { paymentStatus: query.paymentStatus } : {}),
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
        pickupLocation: query.pickupLocation,
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
        'Preferred Pickup Location',
        'Total Amount (CAD)',
        'Created At',
        'Paid At',
        'Location of Sales',
      ].map(escapeCsv).join(','),
      ...filteredOrders.map((order) => [
        getDisplayOrderReference(order),
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
        order.preferredPickupLocation || '',
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

    const isFulfillmentStaff = req.admin?.role === 'PARTNER' && !req.admin?.isSuperAdmin;
    const isRevertStatus = payload.fulfillmentStatus === 'PENDING_PICKUP' || payload.fulfillmentStatus === 'PENDING_DELIVERY';
    if (isFulfillmentStaff && isRevertStatus) {
      return res.status(403).json({ message: 'Only admin users can revert completed fulfilment actions.' });
    }

    let nextNotes = order.notes;
    let aggregateFulfillmentStatus = payload.fulfillmentStatus;
    const isCompletedStatus = payload.fulfillmentStatus === 'PICKED_UP' || payload.fulfillmentStatus === 'DELIVERED';
    const fulfilledAt = isCompletedStatus ? new Date().toISOString() : null;
    const fulfillmentAudit = isCompletedStatus
      ? {
          fulfilledByUserId: req.admin?.userId || null,
          fulfilledByEmail: req.admin?.email || null,
          fulfilledByRole: req.admin?.role || null,
        }
      : {
          fulfilledByUserId: null,
          fulfilledByEmail: null,
          fulfilledByRole: null,
        };

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
                        fulfilledAt,
                        ...fulfillmentAudit,
                      }
                    : child,
                ),
              }
            : {
                ...item,
                fulfillmentStatus: payload.fulfillmentStatus,
                fulfilledAt,
                ...fulfillmentAudit,
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
          displayOrderReference: getDisplayOrderReference(updatedOrder),
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
      order: req.admin?.role === 'PARTNER' && !req.admin?.isSuperAdmin
        ? serializeFulfillmentOrderForPartner({
            ...updatedOrder,
            fulfillmentStatus: deriveAggregateFulfillmentStatus(updatedOrder, fulfillmentItems),
            displayOrderReference: getDisplayOrderReference(updatedOrder),
            fulfillmentItems,
          })
        : {
            ...updatedOrder,
            fulfillmentItems,
          },
    });
  } catch (error) {
    next(error);
  }
}

export async function updatePartialFulfillmentHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const payload = partialFulfillmentSchema.parse(req.body);

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

    if (!rawItems.length) {
      return res.status(409).json({ message: 'Partial fulfilment requires item details.' });
    }

    const normalizedItems = rawItems.map((item) => {
      const normalizedItem = {
        ...item,
        fulfillmentMethod: item.fulfillmentMethod || order.fulfillmentMethod,
        fulfillmentStatus: getDefaultItemFulfillmentStatus(order, item),
      };

      if (normalizedItem.saleType === 'BUNDLE_DISCOUNTED_SALE') {
        normalizedItem.fulfillmentChildren = buildBundleFulfillmentChildren(order, normalizedItem);
      }

      return normalizedItem;
    });

    const flattenedItems = normalizeFulfillmentItems({
      ...order,
      notes: JSON.stringify({
        ...(snapshot || {}),
        items: normalizedItems,
      }),
    });
    const targetItem = flattenedItems.find((item) => item.itemIndex === payload.itemIndex);

    if (!targetItem) {
      return res.status(404).json({ message: 'Order item not found.' });
    }

    if (targetItem.isBundleComponent || targetItem.isPartialFulfillment) {
      return res.status(409).json({ message: 'Select a pending order item.' });
    }

    if (isCompletedFulfillmentItem(targetItem)) {
      return res.status(409).json({ message: 'This item is already completed.' });
    }

    const sourceItem = normalizedItems[targetItem.sourceIndex];
    const originalQuantity = Number(sourceItem?.quantity) || 0;
    const alreadyFulfilledQuantity = getPartialFulfilledQuantity(sourceItem);
    const remainingQuantity = Math.max(0, originalQuantity - alreadyFulfilledQuantity);

    if (!remainingQuantity) {
      return res.status(409).json({ message: 'This item is already completed.' });
    }

    if (payload.quantity > remainingQuantity) {
      return res.status(409).json({ message: `Quantity cannot exceed ${remainingQuantity}.` });
    }

    const completedStatus = getCompletedStatusForMethod(targetItem.fulfillmentMethod);
    const fulfilledAt = new Date().toISOString();
    const fulfillmentAudit = {
      fulfilledByUserId: req.admin?.userId || null,
      fulfilledByEmail: req.admin?.email || null,
      fulfilledByRole: req.admin?.role || null,
    };
    const nextPartialFulfillments = [
      ...getPartialFulfillments(sourceItem),
      {
        quantity: payload.quantity,
        fulfillmentStatus: completedStatus,
        fulfilledAt,
        ...fulfillmentAudit,
      },
    ];
    const nextPartialTotal = alreadyFulfilledQuantity + payload.quantity;

    const nextItems = normalizedItems.map((item, index) => {
      if (index !== targetItem.sourceIndex) {
        return item;
      }

      return {
        ...item,
        fulfillmentStatus: nextPartialTotal >= originalQuantity
          ? completedStatus
          : getPendingStatusForMethod(targetItem.fulfillmentMethod),
        fulfilledAt: nextPartialTotal >= originalQuantity ? fulfilledAt : item.fulfilledAt || null,
        ...(nextPartialTotal >= originalQuantity ? fulfillmentAudit : {}),
        partialFulfillments: nextPartialFulfillments,
      };
    });

    const nextNotes = JSON.stringify({
      ...(snapshot || {}),
      items: nextItems,
    });
    const nextFlattenedItems = normalizeFulfillmentItems({
      ...order,
      notes: nextNotes,
    });
    const aggregateFulfillmentStatus = deriveAggregateFulfillmentStatus(order, nextFlattenedItems);

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

    return res.json({
      message: 'Partial fulfilment saved successfully.',
      order: req.admin?.role === 'PARTNER' && !req.admin?.isSuperAdmin
        ? serializeFulfillmentOrderForPartner({
            ...updatedOrder,
            fulfillmentStatus: deriveAggregateFulfillmentStatus(updatedOrder, fulfillmentItems),
            displayOrderReference: getDisplayOrderReference(updatedOrder),
            fulfillmentItems,
          })
        : {
            ...updatedOrder,
            fulfillmentItems,
          },
    });
  } catch (error) {
    next(error);
  }
}

export async function undoPartialFulfillmentHandler(req, res, next) {
  try {
    const orderReference = z.string().uuid().parse(req.params.orderReference);
    const payload = undoPartialFulfillmentSchema.parse(req.body);

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

    if (!rawItems.length) {
      return res.status(409).json({ message: 'Partial fulfilment requires item details.' });
    }

    const normalizedItems = rawItems.map((item) => {
      const normalizedItem = {
        ...item,
        fulfillmentMethod: item.fulfillmentMethod || order.fulfillmentMethod,
        fulfillmentStatus: getDefaultItemFulfillmentStatus(order, item),
      };

      if (normalizedItem.saleType === 'BUNDLE_DISCOUNTED_SALE') {
        normalizedItem.fulfillmentChildren = buildBundleFulfillmentChildren(order, normalizedItem);
      }

      return normalizedItem;
    });

    const flattenedItems = normalizeFulfillmentItems({
      ...order,
      notes: JSON.stringify({
        ...(snapshot || {}),
        items: normalizedItems,
      }),
    });
    const targetItem = flattenedItems.find((item) => item.itemIndex === payload.itemIndex);

    if (!targetItem) {
      return res.status(404).json({ message: 'Order item not found.' });
    }

    if (targetItem.isBundleComponent) {
      return res.status(409).json({ message: 'Bundle component partial undo is not supported.' });
    }

    const sourceItem = normalizedItems[targetItem.sourceIndex];
    const currentPartialFulfillments = getPartialFulfillments(sourceItem);

    if (!currentPartialFulfillments.length) {
      return res.status(409).json({ message: 'No partial fulfilment found for this item.' });
    }

    const partialIndexToRemove = targetItem.isPartialFulfillment
      ? targetItem.partialIndex
      : currentPartialFulfillments.length - 1;

    if (
      partialIndexToRemove === undefined ||
      partialIndexToRemove < 0 ||
      partialIndexToRemove >= currentPartialFulfillments.length
    ) {
      return res.status(404).json({ message: 'Partial fulfilment entry not found.' });
    }

    const removedPartialFulfillment = currentPartialFulfillments[partialIndexToRemove];
    const nextPartialFulfillments = currentPartialFulfillments.filter((_, index) => index !== partialIndexToRemove);
    const originalQuantity = Math.max(0, Number(sourceItem?.quantity) || 0);
    const nextPartialTotal = nextPartialFulfillments.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry?.quantity) || 0),
      0,
    );
    const completedStatus = getCompletedStatusForMethod(sourceItem.fulfillmentMethod);
    const nextItemStatus = nextPartialTotal >= originalQuantity && originalQuantity > 0
      ? completedStatus
      : getPendingStatusForMethod(sourceItem.fulfillmentMethod);
    const nextCompletedPartial = nextPartialFulfillments[nextPartialFulfillments.length - 1] || null;
    const reversalAudit = {
      action: 'PARTIAL_FULFILLMENT_UNDONE',
      sourceIndex: targetItem.sourceIndex,
      partialIndex: partialIndexToRemove,
      itemName: sourceItem.name || targetItem.name || null,
      salesItemId: sourceItem.salesItemId || targetItem.salesItemId || null,
      batchNumber: sourceItem.batchNumber || targetItem.batchNumber || null,
      quantity: Math.max(0, Number(removedPartialFulfillment?.quantity) || 0),
      originalFulfilledAt: removedPartialFulfillment?.fulfilledAt || null,
      undoneAt: new Date().toISOString(),
      undoneByUserId: req.admin?.userId || null,
      undoneByEmail: req.admin?.email || null,
      undoneByRole: req.admin?.role || null,
    };

    const nextItems = normalizedItems.map((item, index) => {
      if (index !== targetItem.sourceIndex) {
        return item;
      }

      const nextItem = {
        ...item,
        fulfillmentStatus: nextItemStatus,
        fulfilledAt: nextItemStatus === completedStatus ? nextCompletedPartial?.fulfilledAt || item.fulfilledAt || null : null,
        fulfilledByUserId: nextItemStatus === completedStatus ? nextCompletedPartial?.fulfilledByUserId || item.fulfilledByUserId || null : null,
        fulfilledByEmail: nextItemStatus === completedStatus ? nextCompletedPartial?.fulfilledByEmail || item.fulfilledByEmail || null : null,
        fulfilledByRole: nextItemStatus === completedStatus ? nextCompletedPartial?.fulfilledByRole || item.fulfilledByRole || null : null,
        partialFulfillments: nextPartialFulfillments,
      };

      return nextItem;
    });

    const nextNotes = JSON.stringify({
      ...(snapshot || {}),
      items: nextItems,
      fulfillmentAuditTrail: [
        ...(Array.isArray(snapshot?.fulfillmentAuditTrail) ? snapshot.fulfillmentAuditTrail : []),
        reversalAudit,
      ],
    });
    const nextFlattenedItems = normalizeFulfillmentItems({
      ...order,
      notes: nextNotes,
    });
    const aggregateFulfillmentStatus = deriveAggregateFulfillmentStatus(order, nextFlattenedItems);

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

    return res.json({
      message: 'Partial fulfilment undone successfully.',
      audit: reversalAudit,
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

    if (payload.transferProof && !isValidReceiptObjectKey(payload.orderReference, payload.transferProof.objectKey)) {
      return res.status(409).json({ message: 'Uploaded receipt does not match this order.' });
    }

    const existingPayload = order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object'
      ? order.payment.providerPayloadJson
      : {};

    const storedTransferProof = payload.transferProof ? buildStoredTransferProof(payload.transferProof) : null;

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
              ...(storedTransferProof ? { transferProof: storedTransferProof } : {}),
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
      displayOrderReference: getDisplayOrderReference(order),
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
