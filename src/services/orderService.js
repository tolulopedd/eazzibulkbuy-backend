import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { isHelcimConfigured, isS3Configured, isStripeConfigured } from '../config/env.js';
import { createStripePaymentIntent } from './paymentService.js';
import { createHelcimCheckoutSession } from './paymentService.js';
import { getManualPaymentInstructions } from './paymentService.js';
import { retrieveStripePaymentIntent } from './paymentService.js';
import { validateHelcimPayResponse } from './paymentService.js';
import { sendOrderPaidEmail } from './emailService.js';
import { formatDisplayOrderReference, getDisplayOrderReference } from '../utils/orderReference.js';
import {
  buildStoredTransferProof,
  createTransferProofUploadTarget,
  createTransferProofViewUrl,
  isValidReceiptObjectKey,
} from './storageService.js';
import {
  DISCOUNT_ORDER_SYSTEM_BATCH_NUMBER,
  DISCOUNT_ORDER_SYSTEM_LOCATION,
  DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME,
} from '../constants/systemSalesItems.js';
import { hasActivePickupLocation } from './pickupLocationService.js';

function buildBuyerName({ title, firstName, lastName }) {
  return [title, firstName, lastName].filter(Boolean).join(' ').trim();
}

function getDeliveryGroupKey(salesItem) {
  return [
    salesItem.deliveryBaseRangeMax || 0,
    salesItem.deliveryBasePrice || 0,
    salesItem.deliveryAdditionalUnitPrice || 0,
  ].join(':');
}

function getEffectiveDeliveryUnits(line) {
  if (line.salesItem?.saleType !== 'BUNDLE_DISCOUNTED_SALE') {
    return line.quantity;
  }

  const bundleItems = Array.isArray(line.salesItem.bundleItemsJson) ? line.salesItem.bundleItemsJson : [];
  const unitsPerBundle = bundleItems.reduce((sum, item) => sum + Math.max(0, Number(item?.quantity) || 0), 0);
  return line.quantity * Math.max(1, unitsPerBundle);
}

function calculateGroupedDeliveryFee(lines) {
  const groupedQuantities = new Map();

  for (const line of lines) {
    if (line.fulfillmentMethod !== 'DELIVERY') {
      continue;
    }

    if (!line.salesItem.deliveryEnabled) {
      throw new Error(`Delivery is not available for ${line.salesItem.name}.`);
    }

    const key = getDeliveryGroupKey(line.salesItem);
    const current = groupedQuantities.get(key) || { quantity: 0, salesItem: line.salesItem };
    groupedQuantities.set(key, {
      quantity: current.quantity + getEffectiveDeliveryUnits(line),
      salesItem: line.salesItem,
    });
  }

  let totalFee = 0;
  for (const group of groupedQuantities.values()) {
    const baseRangeMax = Math.max(1, group.salesItem.deliveryBaseRangeMax || 10);
    const basePrice = group.salesItem.deliveryBasePrice || 0;
    const additionalUnitPrice = group.salesItem.deliveryAdditionalUnitPrice || 0;
    totalFee += group.quantity <= baseRangeMax
      ? basePrice
      : basePrice + (group.quantity - baseRangeMax) * additionalUnitPrice;
  }

  return totalFee;
}

function parseCartNotes(notes) {
  if (!notes) {
    return null;
  }

  try {
    return JSON.parse(notes);
  } catch {
    return null;
  }
}

function formatSnapshotItemSummary(item) {
  const saleType = item?.saleType;
  const quantity = Number(item?.quantity) || 0;
  const bundleItems = Array.isArray(item?.bundleItems) ? item.bundleItems : [];

  if (saleType === 'BUNDLE_DISCOUNTED_SALE' && bundleItems.length) {
    return bundleItems
      .map((bundleItem) => {
        const bundleQuantity = (Number(bundleItem?.quantity) || 0) * Math.max(1, quantity);
        return `${bundleItem?.name || 'Item'} x ${bundleQuantity}`;
      })
      .join(' + ');
  }

  return `${item?.name || 'Order items'} x ${Math.max(1, quantity)}`;
}

function getSalesItemSummaryFromOrder(order) {
  const cartSnapshot = parseCartNotes(order.notes);
  return cartSnapshot?.items?.length
    ? cartSnapshot.items.map((item) => formatSnapshotItemSummary(item)).join(' + ')
    : order.salesItem?.name || 'Order items';
}

function getInitialFulfillmentStatus(fulfillmentMethod) {
  return fulfillmentMethod === 'DELIVERY' ? 'PENDING_DELIVERY' : 'PENDING_PICKUP';
}

function getBaseOrderAmount({ subtotal, deliveryFee }) {
  return subtotal + deliveryFee;
}

function calculateStripeProcessingFee(baseAmountCents) {
  if (!baseAmountCents || baseAmountCents <= 0) {
    return 0;
  }

  const grossTotal = Math.round((baseAmountCents + 30) / (1 - 0.029));
  return Math.max(0, grossTotal - baseAmountCents);
}

function calculateOrderTotalAmount({ subtotal, deliveryFee, paymentMethod }) {
  const baseAmount = getBaseOrderAmount({ subtotal, deliveryFee });
  const stripeProcessingFee = paymentMethod === 'STRIPE_CARD' ? calculateStripeProcessingFee(baseAmount) : 0;

  return {
    baseAmount,
    stripeProcessingFee,
    totalAmount: baseAmount + stripeProcessingFee,
  };
}

function isCardPaymentMethod(paymentMethod) {
  return paymentMethod === 'STRIPE_CARD' || paymentMethod === 'HELCIM_CARD';
}

function normalizeBatchNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function buildDisplayOrderReferencePrefix(createdAt, batchNumber) {
  const date = createdAt ? new Date(createdAt) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const day = String(safeDate.getDate()).padStart(2, '0');
  const month = safeDate.toLocaleString('en-US', { month: 'short' });
  const normalizedBatch = normalizeBatchNumber(batchNumber);
  return normalizedBatch ? `${day}${month}-${normalizedBatch}-` : `${day}${month}-`;
}

function isDisplayOrderReferenceUniqueConstraintError(error) {
  return (
    error?.code === 'P2002' &&
    (
      (Array.isArray(error?.meta?.target) && error.meta.target.includes('display_order_reference'))
      || String(error?.meta?.target || '').includes('display_order_reference')
      || String(error?.message || '').includes('display_order_reference')
    )
  );
}

async function reserveNextOrderSequence(tx, batchNumber) {
  const orderCreatedAt = new Date();
  const prefix = buildDisplayOrderReferencePrefix(orderCreatedAt, batchNumber);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;
  const result = await tx.$queryRaw`
    SELECT COALESCE(MAX(CAST(RIGHT("display_order_reference", 4) AS INTEGER)), 0) AS "maxSequence"
    FROM "orders"
    WHERE "display_order_reference" LIKE ${`${prefix}%`}
  `;
  return {
    orderSequence: Number(result?.[0]?.maxSequence || 0) + 1,
    orderCreatedAt,
  };
}

async function ensureDiscountOrderAnchorSalesItem(tx) {
  const existing = await tx.salesItem.findFirst({
    where: { name: DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME },
  });

  if (existing) {
    return existing;
  }

  return tx.salesItem.create({
    data: {
      name: DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME,
      saleType: 'NORMAL_SALE',
      batchNumber: DISCOUNT_ORDER_SYSTEM_BATCH_NUMBER,
      description: 'System anchor for admin discount orders.',
      pickupInstructions: DISCOUNT_ORDER_SYSTEM_LOCATION,
      deliveryEnabled: false,
      pricePerUnit: 1,
      status: 'INACTIVE',
      closingDate: new Date('2099-12-31T23:59:59.000Z'),
    },
  });
}

export async function createPendingOrder(payload) {
  const {
    existingCustomerId,
    title,
    firstName,
    lastName,
    email,
    phone,
    address,
    city,
    province,
    postalCode,
    items,
    paymentMethod,
    preferredPickupLocation,
  } = payload;
  const name = buildBuyerName({ title, firstName, lastName });
  const uniqueSalesItemIds = [...new Set(items.map((item) => item.salesItemId))];
  const salesItems = await prisma.salesItem.findMany({
    where: { id: { in: uniqueSalesItemIds } },
  });
  const salesItemMap = new Map(salesItems.map((salesItem) => [salesItem.id, salesItem]));

  if (salesItems.length !== uniqueSalesItemIds.length) {
    throw new Error('One or more bulk sale items could not be found.');
  }

  const orderLines = items.map((item) => {
    const salesItem = salesItemMap.get(item.salesItemId);
    if (!salesItem) {
      throw new Error('Bulk sale item could not be found.');
    }
    if (salesItem.status !== 'ACTIVE') {
      throw new Error(`${salesItem.name} is no longer active.`);
    }
    if (new Date() >= salesItem.closingDate) {
      throw new Error(`${salesItem.name} is already closed.`);
    }

    return {
      salesItem,
      salesItemId: salesItem.id,
      quantity: item.quantity,
      fulfillmentMethod: item.fulfillmentMethod,
      unitPrice: salesItem.pricePerUnit,
      lineTotal: item.quantity * salesItem.pricePerUnit,
    };
  });

  const fulfillmentMethods = [...new Set(orderLines.map((line) => line.fulfillmentMethod))];
  if (fulfillmentMethods.length > 1) {
    throw new Error('All items in the cart must use the same pickup option.');
  }
  const orderFulfillmentMethod = orderLines.some((line) => line.fulfillmentMethod === 'DELIVERY') ? 'DELIVERY' : 'PICKUP';

  if (orderFulfillmentMethod === 'PICKUP' && !preferredPickupLocation) {
    throw new Error('Select your preferred pickup location before creating your order.');
  }

  if (orderFulfillmentMethod === 'DELIVERY' && preferredPickupLocation) {
    throw new Error('Preferred pickup location is only needed for pickup orders.');
  }

  if (orderFulfillmentMethod === 'PICKUP' && preferredPickupLocation) {
    const isActivePickupLocation = await hasActivePickupLocation(preferredPickupLocation);
    if (!isActivePickupLocation) {
      throw new Error('Selected pickup location is no longer available. Please choose an active pickup location.');
    }
  }

  const primaryLine = orderLines[0];
  const subtotal = orderLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const totalQuantity = orderLines.reduce((sum, line) => sum + line.quantity, 0);
  const deliveryFee = calculateGroupedDeliveryFee(orderLines);
  const storedPaymentMethod = paymentMethod || 'STRIPE_CARD';
  const hasExplicitPaymentMethod = Boolean(paymentMethod);
  const isManualFlow = hasExplicitPaymentMethod && !isCardPaymentMethod(paymentMethod);
  const isInteracFlow = paymentMethod === 'INTERAC_E_TRANSFER';
  const { stripeProcessingFee, totalAmount } = calculateOrderTotalAmount({
    subtotal,
    deliveryFee,
    paymentMethod: hasExplicitPaymentMethod ? storedPaymentMethod : null,
  });
  const manualInstructions = null;
  const cartSnapshot = {
    preferredPickupLocation: orderFulfillmentMethod === 'PICKUP' ? preferredPickupLocation : null,
    items: orderLines.map((line) => ({
      salesItemId: line.salesItemId,
      batchNumber: line.salesItem.batchNumber,
      name: line.salesItem.name,
      saleType: line.salesItem.saleType,
      description: line.salesItem.description,
      bundleItems: Array.isArray(line.salesItem.bundleItemsJson) ? line.salesItem.bundleItemsJson : [],
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      fulfillmentMethod: line.fulfillmentMethod,
      fulfillmentStatus: getInitialFulfillmentStatus(line.fulfillmentMethod),
      fulfillmentChildren: line.salesItem.saleType === 'BUNDLE_DISCOUNTED_SALE'
        ? (Array.isArray(line.salesItem.bundleItemsJson) ? line.salesItem.bundleItemsJson : []).map((bundleItem) => ({
            name: bundleItem.name,
            quantity: (Number(bundleItem.quantity) || 0) * line.quantity,
            lineTotal: null,
            fulfillmentMethod: line.fulfillmentMethod,
            fulfillmentStatus: getInitialFulfillmentStatus(line.fulfillmentMethod),
            parentBundleName: line.salesItem.name,
          }))
        : [],
      location: line.salesItem.pickupInstructions,
      preferredPickupLocation: orderFulfillmentMethod === 'PICKUP' ? preferredPickupLocation : null,
      deliveryConfig: {
        enabled: line.salesItem.deliveryEnabled,
        baseRangeMax: line.salesItem.deliveryBaseRangeMax,
        basePrice: line.salesItem.deliveryBasePrice,
        additionalUnitPrice: line.salesItem.deliveryAdditionalUnitPrice,
      },
    })),
  };
  const salesItemSummary = orderLines
    .map((line) => `${line.salesItem.name} x${line.quantity}`)
    .join(', ');

  let order;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      order = await prisma.$transaction(async (tx) => {
        let user;

        if (existingCustomerId) {
          user = await tx.user.findFirst({
            where: {
              id: existingCustomerId,
              role: 'USER',
              isActive: true,
            },
            select: {
              id: true,
            },
          });

          if (!user) {
            throw new Error('Selected buyer could not be found.');
          }
        } else {
          user = await tx.user.upsert({
            where: { email },
            update: {
              name,
              title: title ?? null,
              firstName,
              lastName,
              phone,
              address,
              city,
              province,
              postalCode,
            },
            create: {
              name,
              title,
              firstName,
              lastName,
              email,
              role: 'USER',
              phone,
              address,
              city,
              province,
              postalCode,
            },
            select: {
              id: true,
            },
          });
        }

        const { orderSequence, orderCreatedAt } = await reserveNextOrderSequence(tx, primaryLine.salesItem.batchNumber);
        const displayOrderReference = formatDisplayOrderReference({
          createdAt: orderCreatedAt,
          batchNumber: primaryLine.salesItem.batchNumber,
          orderSequence,
        });

        return tx.order.create({
          data: {
            createdAt: orderCreatedAt,
            displayOrderReference,
            orderSequence,
            userId: user.id,
            salesItemId: primaryLine.salesItem.id,
            quantity: totalQuantity,
            fulfillmentMethod: orderFulfillmentMethod,
            fulfillmentStatus: getInitialFulfillmentStatus(orderFulfillmentMethod),
            preferredPickupLocation: orderFulfillmentMethod === 'PICKUP' ? preferredPickupLocation : null,
            unitPrice: primaryLine.salesItem.pricePerUnit,
            paymentMethod: storedPaymentMethod,
            currency: primaryLine.salesItem.currency,
            subtotal,
            serviceFee: deliveryFee,
            totalAmount,
            notes: JSON.stringify(cartSnapshot),
            status: isManualFlow ? 'AWAITING_MANUAL_PAYMENT' : 'PENDING_PAYMENT',
            paymentStatus: 'PENDING_PAYMENT',
            payment: {
              create: {
                method: storedPaymentMethod,
                status: 'PENDING_PAYMENT',
              },
            },
          },
        });
      });
      break;
    } catch (error) {
      if (!isDisplayOrderReferenceUniqueConstraintError(error) || attempt === 3) {
        throw error;
      }
    }
  }

  const displayOrderReference = getDisplayOrderReference(order, {
    batchNumber: primaryLine.salesItem.batchNumber,
  });

  const resolvedManualInstructions = isManualFlow
    ? getManualPaymentInstructions(paymentMethod, { orderReference: displayOrderReference })
    : null;

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    displayOrderReference,
    orderSequence: order.orderSequence,
    batchNumber: primaryLine.salesItem.batchNumber,
    createdAt: order.createdAt,
    totalAmount: order.totalAmount,
    subtotal: order.subtotal,
    deliveryFee: order.serviceFee,
    stripeProcessingFee,
    fulfillmentMethod: order.fulfillmentMethod,
    preferredPickupLocation: order.preferredPickupLocation,
    cartItems: cartSnapshot.items,
    paymentMethod: hasExplicitPaymentMethod ? order.paymentMethod : null,
    paymentInstructions: resolvedManualInstructions,
    manualPayment: isManualFlow
      ? {
          transferEmail: isInteracFlow ? env.interacBusinessEmail : null,
          instructions: resolvedManualInstructions,
          confirmationEtaHours: 6,
        }
      : null,
    manualConfirmationEtaHours: isManualFlow ? 6 : null,
    orderCreatedEmailSent: false,
  };
}

export async function createAdminDiscountOrder(payload) {
  const {
    customerId,
    items,
    fulfillmentMethod,
    paymentMethod = 'INTERAC_E_TRANSFER',
    discountReason,
    adminUserId,
    adminComment,
    transferProof,
  } = payload;

  const user = await prisma.user.findFirst({
    where: {
      id: customerId,
      role: 'USER',
      isActive: true,
    },
    select: {
      id: true,
    },
  });

  if (!user) {
    throw new Error('Selected buyer could not be found.');
  }

  const referencedSalesItemIds = [...new Set(items.map((item) => item.salesItemId).filter(Boolean))];
  const salesItems = referencedSalesItemIds.length
    ? await prisma.salesItem.findMany({
        where: { id: { in: referencedSalesItemIds } },
      })
    : [];
  const salesItemMap = new Map(salesItems.map((salesItem) => [salesItem.id, salesItem]));

  if (salesItems.length !== referencedSalesItemIds.length) {
    throw new Error('One or more selected sales event items could not be found.');
  }

  const orderLines = items.map((item) => {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const discountedUnitPrice = Number(item.discountedUnitPrice) || 0;

    if (discountedUnitPrice <= 0) {
      throw new Error('Discounted unit price must be greater than zero.');
    }

    if (item.sourceType === 'SALES_EVENT') {
      const salesItem = salesItemMap.get(item.salesItemId);
      if (!salesItem) {
        throw new Error('Selected sales event item could not be found.');
      }
      if (salesItem.status !== 'ACTIVE') {
        throw new Error(`${salesItem.name} is no longer active.`);
      }
      if (new Date() >= salesItem.closingDate) {
        throw new Error(`${salesItem.name} is already closed.`);
      }
      if (discountedUnitPrice >= salesItem.pricePerUnit) {
        throw new Error(`Discounted unit price for ${salesItem.name} must be lower than the current sales price.`);
      }

      return {
        sourceType: 'SALES_EVENT',
        salesItem,
        salesItemId: salesItem.id,
        quantity,
        fulfillmentMethod,
        unitPrice: discountedUnitPrice,
        lineTotal: quantity * discountedUnitPrice,
        displayName: salesItem.name,
        description: salesItem.description,
        location: salesItem.pickupInstructions,
        batchNumber: salesItem.batchNumber,
        saleType: salesItem.saleType,
        bundleItems: Array.isArray(salesItem.bundleItemsJson) ? salesItem.bundleItemsJson : [],
      };
    }

    return {
      sourceType: 'CUSTOM',
      salesItem: {
        name: item.customName?.trim() || 'Custom item',
        saleType: 'NORMAL_SALE',
        bundleItemsJson: [],
        deliveryEnabled: false,
        deliveryBaseRangeMax: 0,
        deliveryBasePrice: 0,
        deliveryAdditionalUnitPrice: 0,
      },
      salesItemId: null,
      quantity,
      fulfillmentMethod,
      unitPrice: discountedUnitPrice,
      lineTotal: quantity * discountedUnitPrice,
      displayName: item.customName?.trim() || 'Custom item',
      description: item.customDescription?.trim() || null,
      location: item.customLocation?.trim() || DISCOUNT_ORDER_SYSTEM_LOCATION,
      batchNumber: 'CUSTOM',
      saleType: 'NORMAL_SALE',
      bundleItems: [],
    };
  });

  const subtotal = orderLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const deliveryFee = calculateGroupedDeliveryFee(orderLines);
  const isManualFlow = !isCardPaymentMethod(paymentMethod);
  const isInteracFlow = paymentMethod === 'INTERAC_E_TRANSFER';
  const { stripeProcessingFee, totalAmount } = calculateOrderTotalAmount({
    subtotal,
    deliveryFee,
    paymentMethod,
  });

  const discountMetadata = {
    discountOrder: true,
    pricingMode: 'ADMIN_OVERRIDE',
    discountReason,
    createdByAdminUserId: adminUserId,
    createdAt: new Date().toISOString(),
    adminComment: adminComment || null,
    lines: orderLines.map((line) => ({
      sourceType: line.sourceType,
      salesItemId: line.salesItemId,
      name: line.displayName,
      batchNumber: line.batchNumber,
      quantity: line.quantity,
      originalUnitPrice: line.sourceType === 'SALES_EVENT' ? line.salesItem.pricePerUnit : null,
      discountedUnitPrice: line.unitPrice,
      discountAmountPerUnit: line.sourceType === 'SALES_EVENT' ? line.salesItem.pricePerUnit - line.unitPrice : null,
      lineTotal: line.lineTotal,
    })),
  };

  const cartSnapshot = {
    meta: discountMetadata,
    items: orderLines.map((line) => ({
      salesItemId: line.salesItemId,
      batchNumber: line.batchNumber,
      name: line.displayName,
      saleType: line.saleType,
      description: line.description,
      bundleItems: line.bundleItems,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      fulfillmentMethod: line.fulfillmentMethod,
      fulfillmentStatus: getInitialFulfillmentStatus(line.fulfillmentMethod),
      fulfillmentChildren: line.saleType === 'BUNDLE_DISCOUNTED_SALE'
        ? line.bundleItems.map((bundleItem) => ({
            name: bundleItem.name,
            quantity: (Number(bundleItem.quantity) || 0) * line.quantity,
            lineTotal: null,
            fulfillmentMethod: line.fulfillmentMethod,
            fulfillmentStatus: getInitialFulfillmentStatus(line.fulfillmentMethod),
            parentBundleName: line.displayName,
          }))
        : [],
      location: line.location,
      deliveryConfig: {
        enabled: Boolean(line.salesItem?.deliveryEnabled),
        baseRangeMax: line.salesItem?.deliveryBaseRangeMax || 0,
        basePrice: line.salesItem?.deliveryBasePrice || 0,
        additionalUnitPrice: line.salesItem?.deliveryAdditionalUnitPrice || 0,
      },
    })),
  };

  let order;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      order = await prisma.$transaction(async (tx) => {
        const anchorSalesItem = orderLines.find((line) => line.sourceType === 'SALES_EVENT')?.salesItem
          || await ensureDiscountOrderAnchorSalesItem(tx);
        const { orderSequence, orderCreatedAt } = await reserveNextOrderSequence(tx, anchorSalesItem.batchNumber);
        const displayOrderReference = formatDisplayOrderReference({
          createdAt: orderCreatedAt,
          batchNumber: anchorSalesItem.batchNumber,
          orderSequence,
        });

        return tx.order.create({
          data: {
            createdAt: orderCreatedAt,
            displayOrderReference,
            orderSequence,
            userId: user.id,
            salesItemId: anchorSalesItem.id,
            quantity: orderLines.reduce((sum, line) => sum + line.quantity, 0),
            fulfillmentMethod,
            fulfillmentStatus: getInitialFulfillmentStatus(fulfillmentMethod),
            unitPrice: orderLines[0]?.unitPrice || 0,
            paymentMethod,
            currency: anchorSalesItem.currency || 'CAD',
            subtotal,
            serviceFee: deliveryFee,
            totalAmount,
            notes: JSON.stringify(cartSnapshot),
            status: isManualFlow ? 'AWAITING_MANUAL_PAYMENT' : 'PENDING_PAYMENT',
            paymentStatus: isManualFlow ? 'PENDING_REVIEW' : 'PENDING_PAYMENT',
            payment: {
              create: {
                method: paymentMethod,
                status: isManualFlow ? 'PENDING_REVIEW' : 'PENDING_PAYMENT',
                providerPayloadJson: {
                  adminDiscount: discountMetadata,
                  ...(transferProof ? { transferProof: buildStoredTransferProof(transferProof) } : {}),
                  ...(isManualFlow
                    ? {
                        adminRecovery: {
                          comment: discountReason,
                          updatedByUserId: adminUserId,
                          updatedAt: new Date().toISOString(),
                        },
                      }
                    : {}),
                },
              },
            },
          },
          include: {
            user: true,
            salesItem: true,
            payment: true,
          },
        });
      });
      break;
    } catch (error) {
      if (!isDisplayOrderReferenceUniqueConstraintError(error) || attempt === 3) {
        throw error;
      }
    }
  }

  const displayOrderReference = getDisplayOrderReference(order);

  const resolvedManualInstructions = isManualFlow
    ? getManualPaymentInstructions(paymentMethod, { orderReference: displayOrderReference })
    : null;

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    displayOrderReference,
    orderSequence: order.orderSequence,
    batchNumber: order.salesItem.batchNumber,
    createdAt: order.createdAt,
    totalAmount: order.totalAmount,
    subtotal: order.subtotal,
    deliveryFee: order.serviceFee,
    stripeProcessingFee,
    fulfillmentMethod: order.fulfillmentMethod,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status: order.status,
    cartItems: cartSnapshot.items,
    salesItem: {
      id: order.salesItem.id,
      name: order.salesItem.name,
      batchNumber: order.salesItem.batchNumber,
      pickupInstructions: order.salesItem.pickupInstructions,
    },
    user: {
      id: order.user.id,
      name: order.user.name,
      email: order.user.email,
    },
    discountMeta: discountMetadata,
    paymentInstructions: resolvedManualInstructions,
    manualPayment: isManualFlow
      ? {
          transferEmail: isInteracFlow ? env.interacBusinessEmail : null,
          instructions: resolvedManualInstructions,
          confirmationEtaHours: 6,
        }
      : null,
  };
}

export async function setOrderPaymentMethodByReference({ orderReference, paymentMethod }) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { salesItem: true, user: true, payment: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentStatus === 'PAID' || order.status === 'CONFIRMED') {
    throw new Error('Payment method cannot be changed after payment is confirmed.');
  }

  const isManualFlow = !isCardPaymentMethod(paymentMethod);
  const isInteracFlow = paymentMethod === 'INTERAC_E_TRANSFER';
  const manualInstructions = isManualFlow
    ? getManualPaymentInstructions(paymentMethod, {
        orderReference: getDisplayOrderReference(order),
      })
    : null;
  const { stripeProcessingFee, totalAmount } = calculateOrderTotalAmount({
    subtotal: order.subtotal,
    deliveryFee: order.serviceFee,
    paymentMethod,
  });

  const updated = await prisma.order.update({
    where: { orderReference },
    data: {
      paymentMethod,
      totalAmount,
      status: isManualFlow ? 'AWAITING_MANUAL_PAYMENT' : 'PENDING_PAYMENT',
      paymentStatus: 'PENDING_PAYMENT',
      fulfillmentStatus: getInitialFulfillmentStatus(order.fulfillmentMethod),
      payment: {
        update: {
          method: paymentMethod,
          status: 'PENDING_PAYMENT',
        },
      },
    },
  });

  return {
    orderId: updated.id,
    orderReference: updated.orderReference,
    displayOrderReference: getDisplayOrderReference(updated, {
      batchNumber: order.salesItem?.batchNumber,
    }),
    orderSequence: updated.orderSequence,
    batchNumber: order.salesItem?.batchNumber || '',
    createdAt: updated.createdAt,
    totalAmount: updated.totalAmount,
    subtotal: updated.subtotal,
    deliveryFee: updated.serviceFee,
    stripeProcessingFee,
    fulfillmentMethod: updated.fulfillmentMethod,
    cartItems: parseCartNotes(updated.notes)?.items || [],
    paymentMethod: updated.paymentMethod,
    paymentInstructions: manualInstructions,
    manualPayment: isManualFlow
      ? {
          transferEmail: isInteracFlow ? env.interacBusinessEmail : null,
          instructions: manualInstructions,
          confirmationEtaHours: 6,
        }
      : null,
    manualConfirmationEtaHours: isManualFlow ? 6 : null,
  };
}

export async function createOrderPaymentIntent(orderReference) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { user: true, salesItem: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentMethod !== 'STRIPE_CARD') {
    throw new Error('Payment intent is only available for card payments.');
  }

  if (order.status !== 'PENDING_PAYMENT') {
    throw new Error('Order is not in pending payment state');
  }

  const paymentIntent = await createStripePaymentIntent({
    amount: order.totalAmount,
    currency: order.currency,
    orderReference: order.orderReference,
    customerEmail: order.user.email,
  });

  await prisma.payment.update({
    where: { orderId: order.id },
    data: {
      providerReference: paymentIntent.id,
      providerPayloadJson: paymentIntent,
    },
  });

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    displayOrderReference: getDisplayOrderReference(order),
    clientSecret: paymentIntent.client_secret,
  };
}

export async function createOrderHelcimCheckoutSession(orderReference) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { user: true, salesItem: true, payment: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentMethod !== 'HELCIM_CARD') {
    throw new Error('Helcim checkout is only available for Helcim card payments.');
  }

  if (!isHelcimConfigured) {
    throw new Error('Helcim is not configured yet.');
  }

  if (order.paymentStatus === 'PAID' || order.status === 'CONFIRMED') {
    throw new Error('Payment is already confirmed for this order.');
  }

  const checkoutSession = await createHelcimCheckoutSession({
    amount: order.totalAmount,
    currency: order.currency,
    orderReference: getDisplayOrderReference(order),
  });

  const existingPayload = order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object'
    ? order.payment.providerPayloadJson
    : {};

  await prisma.payment.update({
    where: { orderId: order.id },
    data: {
      providerReference: checkoutSession.checkoutToken,
      providerPayloadJson: {
        ...existingPayload,
        helcimCheckout: {
          checkoutToken: checkoutSession.checkoutToken,
          secretToken: checkoutSession.secretToken,
          initializedAt: new Date().toISOString(),
        },
      },
    },
  });

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    displayOrderReference: getDisplayOrderReference(order),
    checkoutToken: checkoutSession.checkoutToken,
  };
}

export async function createManualTransferUploadByReference({
  orderReference,
  fileName,
  contentType,
  sizeBytes,
}) {
  if (!isS3Configured) {
    throw new Error('S3 storage is not configured for receipt uploads.');
  }

  const order = await prisma.order.findUnique({
    where: { orderReference },
    select: {
      orderReference: true,
      paymentMethod: true,
      paymentStatus: true,
      status: true,
    },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentMethod !== 'INTERAC_E_TRANSFER') {
    throw new Error('Receipt uploads are only available for Interac e-Transfer orders.');
  }

  if (order.paymentStatus === 'PAID' || order.status === 'CONFIRMED') {
    throw new Error('Payment is already confirmed for this order.');
  }

  const uploadTarget = await createTransferProofUploadTarget({
    orderReference,
    fileName,
    contentType,
  });

  return {
    ...uploadTarget,
    fileName,
    contentType,
    sizeBytes,
  };
}

export async function confirmManualTransferByReference({ orderReference, transferProof }) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { payment: true, user: true, salesItem: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentMethod !== 'INTERAC_E_TRANSFER') {
    throw new Error('Manual transfer confirmation is only available for Interac e-Transfer orders.');
  }

  if (order.paymentStatus === 'PAID' || order.status === 'CONFIRMED') {
    return {
      ok: true,
      alreadyConfirmed: true,
      message: 'Payment already confirmed.',
      orderReference: order.orderReference,
      displayOrderReference: getDisplayOrderReference(order),
    };
  }

  if (order.paymentStatus === 'PENDING_REVIEW') {
    return {
      ok: true,
      alreadyConfirmed: true,
      message: 'Transfer already submitted for review. We will confirm within 6 hours.',
      orderReference: order.orderReference,
      displayOrderReference: getDisplayOrderReference(order),
      emailSent: false,
    };
  }

  const existingPayload = order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object'
    ? order.payment.providerPayloadJson
    : {};

  if (!isS3Configured) {
    throw new Error('S3 storage is not configured for receipt uploads.');
  }

  if (!isValidReceiptObjectKey(orderReference, transferProof.objectKey)) {
    throw new Error('Uploaded receipt does not match this order.');
  }

  const storedTransferProof = buildStoredTransferProof(transferProof);

  await prisma.order.update({
    where: { orderReference },
    data: {
      status: 'AWAITING_MANUAL_PAYMENT',
      paymentStatus: 'PENDING_REVIEW',
      payment: {
        update: {
          status: 'PENDING_REVIEW',
          providerPayloadJson: {
            ...existingPayload,
            transferProof: storedTransferProof,
          },
        },
      },
    },
  });

  return {
    ok: true,
    message: 'Transfer submitted successfully. We will confirm your transfer within 6 hours.',
    orderReference: order.orderReference,
    displayOrderReference: getDisplayOrderReference(order),
    createdAt: order.createdAt,
    emailSent: false,
  };
}

export async function getManualTransferProofViewUrlByReference({ orderReference }) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { payment: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  const transferProof = order.payment?.providerPayloadJson?.transferProof;
  if (!transferProof?.objectKey) {
    throw new Error('No uploaded receipt found for this payment.');
  }

  const viewUrl = await createTransferProofViewUrl(transferProof.objectKey);
  return {
    orderReference: order.orderReference,
    fileName: transferProof.fileName || 'receipt',
    storage: transferProof.storage || 'S3',
    viewUrl,
    expiresInSeconds: 600,
  };
}

export async function confirmCardPaymentByReference({ orderReference, paymentIntentId }) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { payment: true, salesItem: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentMethod !== 'STRIPE_CARD') {
    throw new Error('Card confirmation is only available for Stripe orders.');
  }

  if (order.paymentStatus === 'PAID' || order.status === 'CONFIRMED') {
    return {
      orderReference: order.orderReference,
      createdAt: order.createdAt,
      displayOrderReference: getDisplayOrderReference(order),
      alreadyConfirmed: true,
      emailSent: false,
    };
  }

  if (!isStripeConfigured) {
    const confirmedOrder = await markOrderPaidByReference({
      orderReference,
      providerReference: paymentIntentId || `stripe-demo:${orderReference}`,
      payload: {
        id: paymentIntentId || `stripe-demo:${orderReference}`,
        status: 'succeeded',
        demoMode: true,
        metadata: { orderReference },
      },
    });

    return {
      orderReference: confirmedOrder.orderReference,
      createdAt: confirmedOrder.createdAt,
      displayOrderReference: getDisplayOrderReference(confirmedOrder),
      paidAt: confirmedOrder.paidAt,
      emailSent: Boolean(confirmedOrder.paymentConfirmationEmailSent),
    };
  }

  const paymentIntent = await retrieveStripePaymentIntent(paymentIntentId);
  if (!paymentIntent || paymentIntent.status !== 'succeeded') {
    throw new Error('Stripe payment has not been completed yet.');
  }

  if (paymentIntent.metadata?.orderReference !== orderReference) {
    throw new Error('Stripe payment does not match this order.');
  }

  const confirmedOrder = await markOrderPaidByReference({
    orderReference,
    providerReference: paymentIntent.id,
    payload: paymentIntent,
  });

  return {
    orderReference: confirmedOrder.orderReference,
    createdAt: confirmedOrder.createdAt,
    displayOrderReference: getDisplayOrderReference(confirmedOrder),
    paidAt: confirmedOrder.paidAt,
    emailSent: Boolean(confirmedOrder.paymentConfirmationEmailSent),
  };
}

export async function confirmHelcimPaymentByReference({ orderReference, checkoutToken, transactionResponse }) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { payment: true, salesItem: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentMethod !== 'HELCIM_CARD') {
    throw new Error('Helcim confirmation is only available for Helcim card orders.');
  }

  if (order.paymentStatus === 'PAID' || order.status === 'CONFIRMED') {
    return {
      orderReference: order.orderReference,
      createdAt: order.createdAt,
      displayOrderReference: getDisplayOrderReference(order),
      alreadyConfirmed: true,
      emailSent: false,
    };
  }

  const existingPayload = order.payment?.providerPayloadJson && typeof order.payment.providerPayloadJson === 'object'
    ? order.payment.providerPayloadJson
    : {};
  const storedCheckout = existingPayload.helcimCheckout || {};

  if (!storedCheckout.secretToken || !storedCheckout.checkoutToken) {
    throw new Error('Helcim checkout session was not initialized for this order.');
  }

  if (storedCheckout.checkoutToken !== checkoutToken) {
    throw new Error('Helcim checkout token does not match this order.');
  }

  const transactionData = transactionResponse?.data;
  const transactionHash = transactionResponse?.hash;

  if (!transactionData || !transactionHash) {
    throw new Error('Helcim payment response is incomplete.');
  }

  const isValid = validateHelcimPayResponse({
    transactionData,
    receivedHash: transactionHash,
    secretToken: storedCheckout.secretToken,
  });

  if (!isValid) {
    throw new Error('Helcim payment response could not be validated.');
  }

  if (String(transactionData.currency || '').toUpperCase() !== String(order.currency || '').toUpperCase()) {
    throw new Error('Helcim payment currency does not match this order.');
  }

  const helcimAmountCents = Math.round(Number(transactionData.amount || 0) * 100);
  if (helcimAmountCents !== order.totalAmount) {
    throw new Error('Helcim payment amount does not match this order.');
  }

  if (String(transactionData.status || '').toUpperCase() !== 'APPROVED') {
    throw new Error('Helcim payment has not been approved yet.');
  }

  const confirmedOrder = await markOrderPaidByReference({
    orderReference,
    providerReference: String(transactionData.transactionId || checkoutToken),
    payload: {
      ...existingPayload,
      helcimCheckout: {
        ...storedCheckout,
        validatedAt: new Date().toISOString(),
      },
      helcimTransaction: transactionResponse,
    },
  });

  return {
    orderReference: confirmedOrder.orderReference,
    createdAt: confirmedOrder.createdAt,
    displayOrderReference: getDisplayOrderReference(confirmedOrder),
    paidAt: confirmedOrder.paidAt,
    emailSent: Boolean(confirmedOrder.paymentConfirmationEmailSent),
  };
}

export async function markOrderPaidByReference({ orderReference, providerReference, payload }) {
  const paidAt = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findUnique({
      where: { orderReference },
      include: { user: true, salesItem: true, payment: true },
    });

    if (!existing) {
      throw new Error('Order not found for webhook reference');
    }

    const alreadyProcessed =
      existing.status === 'CONFIRMED' ||
      existing.paymentStatus === 'PAID' ||
      existing.paidAt !== null;

    if (alreadyProcessed) {
      return { order: existing, shouldSendEmail: false };
    }

    const updated = await tx.order.update({
      where: { orderReference },
      data: {
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        paidAt,
        payment: {
          update: {
            status: 'PAID',
            providerReference,
            providerPayloadJson: payload,
          },
        },
      },
      include: { user: true, salesItem: true, payment: true },
    });

    return { order: updated, shouldSendEmail: true };
  });

  let paymentConfirmationEmailSent = false;
  if (outcome.shouldSendEmail) {
    const salesItemSummary = getSalesItemSummaryFromOrder(outcome.order);
    try {
      await sendOrderPaidEmail({
        email: outcome.order.user.email,
        firstName: outcome.order.user.firstName || outcome.order.user.name?.split(' ').filter(Boolean)[0] || 'Customer',
        salesItemName: salesItemSummary,
        quantity: outcome.order.quantity,
        totalPaidCad: outcome.order.totalAmount,
        displayOrderReference: getDisplayOrderReference(outcome.order),
      });
      paymentConfirmationEmailSent = true;
    } catch (error) {
      console.error('Failed to send payment confirmation email', {
        orderReference: outcome.order.orderReference,
        error: error?.message,
      });
    }
  }

  return {
    ...outcome.order,
    paymentConfirmationEmailSent,
  };
}

export async function resendOrderPaymentConfirmationByReference({ orderReference }) {
  const order = await prisma.order.findUnique({
    where: { orderReference },
    include: { user: true, salesItem: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  const isPaid = order.paymentStatus === 'PAID' || order.status === 'CONFIRMED' || Boolean(order.paidAt);
  if (!isPaid) {
    throw new Error('Payment confirmation can only be resent for paid orders.');
  }

  await sendOrderPaidEmail({
    email: order.user.email,
    firstName: order.user.firstName || order.user.name?.split(' ').filter(Boolean)[0] || 'Customer',
    salesItemName: getSalesItemSummaryFromOrder(order),
    quantity: order.quantity,
    totalPaidCad: order.totalAmount,
    displayOrderReference: getDisplayOrderReference(order),
  });

  return {
    orderReference: order.orderReference,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt,
  };
}
