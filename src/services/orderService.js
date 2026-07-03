import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { isS3Configured, isStripeConfigured } from '../config/env.js';
import { createStripePaymentIntent } from './paymentService.js';
import { getManualPaymentInstructions } from './paymentService.js';
import { retrieveStripePaymentIntent } from './paymentService.js';
import { sendOrderPaidEmail } from './emailService.js';
import { formatDisplayOrderReference } from '../utils/orderReference.js';
import {
  buildStoredTransferProof,
  createTransferProofUploadTarget,
  createTransferProofViewUrl,
  isValidReceiptObjectKey,
} from './storageService.js';

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

async function reserveNextOrderSequence(tx, salesItemId) {
  await tx.$queryRaw`SELECT "id" FROM "sales_items" WHERE "id" = ${salesItemId} FOR UPDATE`;
  const result = await tx.$queryRaw`SELECT COALESCE(MAX("order_sequence"), 0) AS "maxSequence" FROM "orders" WHERE "sales_item_id" = ${salesItemId}`;
  return Number(result?.[0]?.maxSequence || 0) + 1;
}

export async function createPendingOrder(payload) {
  const { title, firstName, lastName, email, phone, address, city, province, postalCode, items, paymentMethod } = payload;
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

  const primaryLine = orderLines[0];
  const subtotal = orderLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const totalQuantity = orderLines.reduce((sum, line) => sum + line.quantity, 0);
  const deliveryFee = calculateGroupedDeliveryFee(orderLines);
  const storedPaymentMethod = paymentMethod || 'STRIPE_CARD';
  const hasExplicitPaymentMethod = Boolean(paymentMethod);
  const isManualFlow = hasExplicitPaymentMethod && paymentMethod !== 'STRIPE_CARD';
  const isInteracFlow = paymentMethod === 'INTERAC_E_TRANSFER';
  const { stripeProcessingFee, totalAmount } = calculateOrderTotalAmount({
    subtotal,
    deliveryFee,
    paymentMethod: hasExplicitPaymentMethod ? storedPaymentMethod : null,
  });
  const manualInstructions = null;
  const cartSnapshot = {
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

  const order = await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
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

    const orderSequence = await reserveNextOrderSequence(tx, primaryLine.salesItem.id);

    return tx.order.create({
      data: {
        orderSequence,
        userId: user.id,
        salesItemId: primaryLine.salesItem.id,
        quantity: totalQuantity,
        fulfillmentMethod: orderLines.some((line) => line.fulfillmentMethod === 'DELIVERY') ? 'DELIVERY' : 'PICKUP',
        fulfillmentStatus: getInitialFulfillmentStatus(orderLines.some((line) => line.fulfillmentMethod === 'DELIVERY') ? 'DELIVERY' : 'PICKUP'),
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

  const displayOrderReference = formatDisplayOrderReference({
    createdAt: order.createdAt,
    batchNumber: primaryLine.salesItem.batchNumber,
    orderSequence: order.orderSequence,
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

  const isManualFlow = paymentMethod !== 'STRIPE_CARD';
  const isInteracFlow = paymentMethod === 'INTERAC_E_TRANSFER';
  const manualInstructions = isManualFlow
    ? getManualPaymentInstructions(paymentMethod, {
        orderReference: formatDisplayOrderReference({
          createdAt: order.createdAt,
          batchNumber: order.salesItem?.batchNumber,
          orderSequence: order.orderSequence,
        }),
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
    displayOrderReference: formatDisplayOrderReference({
      createdAt: updated.createdAt,
      batchNumber: order.salesItem?.batchNumber,
      orderSequence: updated.orderSequence,
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
    displayOrderReference: formatDisplayOrderReference({
      createdAt: order.createdAt,
      batchNumber: order.salesItem?.batchNumber,
      orderSequence: order.orderSequence,
    }),
    clientSecret: paymentIntent.client_secret,
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
      displayOrderReference: formatDisplayOrderReference({
        createdAt: order.createdAt,
        batchNumber: order.salesItem?.batchNumber,
        orderSequence: order.orderSequence,
      }),
    };
  }

  if (order.paymentStatus === 'PENDING_REVIEW') {
    return {
      ok: true,
      alreadyConfirmed: true,
      message: 'Transfer already submitted for review. We will confirm within 6 hours.',
      orderReference: order.orderReference,
      displayOrderReference: formatDisplayOrderReference({
        createdAt: order.createdAt,
        batchNumber: order.salesItem?.batchNumber,
        orderSequence: order.orderSequence,
      }),
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
    displayOrderReference: formatDisplayOrderReference({
      createdAt: order.createdAt,
      batchNumber: order.salesItem?.batchNumber,
      orderSequence: order.orderSequence,
    }),
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
      displayOrderReference: formatDisplayOrderReference({
        createdAt: order.createdAt,
        batchNumber: order.salesItem?.batchNumber,
        orderSequence: order.orderSequence,
      }),
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
      displayOrderReference: formatDisplayOrderReference({
        createdAt: confirmedOrder.createdAt,
        batchNumber: confirmedOrder.salesItem?.batchNumber,
        orderSequence: confirmedOrder.orderSequence,
      }),
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
    displayOrderReference: formatDisplayOrderReference({
      createdAt: confirmedOrder.createdAt,
      batchNumber: confirmedOrder.salesItem?.batchNumber,
      orderSequence: confirmedOrder.orderSequence,
    }),
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
        displayOrderReference: formatDisplayOrderReference({
          createdAt: outcome.order.createdAt,
          batchNumber: outcome.order.salesItem?.batchNumber,
          orderSequence: outcome.order.orderSequence,
        }),
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
    displayOrderReference: formatDisplayOrderReference({
      createdAt: order.createdAt,
      batchNumber: order.salesItem?.batchNumber,
      orderSequence: order.orderSequence,
    }),
  });

  return {
    orderReference: order.orderReference,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt,
  };
}
