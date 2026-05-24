import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { formatDisplayOrderReference } from '../utils/orderReference.js';
import {
  getManualTransferProofViewUrlByReference,
  markOrderPaidByReference,
  resendOrderPaymentConfirmationByReference,
} from '../services/orderService.js';
import { retrieveStripePaymentIntent } from '../services/paymentService.js';

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
    });
  });

  return flattenedItems;
}

function deriveAggregateFulfillmentStatus(order, fulfillmentItems) {
  const methods = [...new Set(fulfillmentItems.map((item) => item.fulfillmentMethod || order.fulfillmentMethod))];
  const isDelivery = methods.every((method) => method === 'DELIVERY');

  if (isDelivery) {
    return fulfillmentItems.every((item) => item.fulfillmentStatus === 'DELIVERED') ? 'DELIVERED' : 'PENDING_DELIVERY';
  }

  return fulfillmentItems.every((item) => item.fulfillmentStatus === 'PICKED_UP') ? 'PICKED_UP' : 'PENDING_PICKUP';
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
  batchNumber: z.string().trim().max(3).optional(),
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

const listOrdersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  batchNumber: z.string().trim().max(3).optional(),
  paidOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  status: z
    .enum(['PENDING_PAYMENT', 'AWAITING_MANUAL_PAYMENT', 'PAID', 'CONFIRMED', 'CANCELLED'])
    .optional(),
  paymentStatus: z
    .enum(['PENDING_PAYMENT', 'REQUIRES_ACTION', 'PENDING_REVIEW', 'SUCCEEDED', 'PAID', 'FAILED'])
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
  batchNumber: z.string().trim().max(3).optional(),
  fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(),
  fulfillmentStatus: z.enum(['PENDING_PICKUP', 'PICKED_UP', 'PENDING_DELIVERY', 'DELIVERED']).optional(),
  reportType: z
    .enum(['orderReady', 'supplierOrders', 'salesDetails'])
    .default('orderReady'),
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

    const [items, total] = await Promise.all([
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
    ]);

    res.json({
      items,
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
    const where = {
      ...(query.salesItemId ? { salesItemId: query.salesItemId } : {}),
      ...(query.batchNumber ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } } : {}),
      ...(query.fulfillmentMethod ? { fulfillmentMethod: query.fulfillmentMethod } : {}),
      ...(query.fulfillmentStatus ? { fulfillmentStatus: query.fulfillmentStatus } : {}),
      ...((query.startDate || query.endDate)
        ? {
            createdAt: {
              ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
              ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
            },
          }
        : {}),
    };

    const orders = await prisma.order.findMany({
      where,
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
      };
    });

    const paidOrders = normalizedOrders.filter((order) => isOrderPaidLike(order));

    const orderReadyRows = paidOrders.map((order) => ({
      id: order.id,
      orderReference: order.orderReference,
      displayOrderReference: order.displayOrderReference,
      batchNumber: order.salesItem?.batchNumber || '',
      items: order.itemDetails.map((item) => item.name).join(', '),
      quantities: order.itemDetails.map((item) => `${item.name}: ${item.quantity}`).join(', '),
    }));

    const supplierAggregation = new Map();
    for (const order of paidOrders) {
      const bundleComponentTotals = new Map();
      for (const item of order.itemDetails) {
        if (!item.isBundleComponent) {
          continue;
        }

        const groupKey = [item.batchNumber, item.bundleName || item.name, item.bundleLineTotal ?? 0].join('::');
        bundleComponentTotals.set(groupKey, (bundleComponentTotals.get(groupKey) || 0) + item.quantity);
      }

      for (const item of order.itemDetails) {
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

    const salesDetailRows = normalizedOrders.map((order) => {
      const orderDetails = [
        order.user?.name || 'Unknown buyer',
        order.itemDetails.map((item) => `${item.name} x${item.quantity}`).join(', '),
      ].filter(Boolean).join(' · ');

      const fulfillment = order.itemDetails
        .map((item) => `${item.name}: ${item.fulfillmentStatusLabel}`)
        .join(', ');

      return {
        id: order.id,
        orderReference: order.orderReference,
        displayOrderReference: order.displayOrderReference,
        batchNumber: order.salesItem?.batchNumber || '',
        orderDetails,
        fulfillment,
        totalAmount: order.totalAmount,
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
        ? 'items-to-order-from-supplier-paid'
        : reportType === 'salesDetails'
          ? 'sales-details-report'
          : 'order-ready-paid';

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
    if (userIds.length === 0) {
      return res.json({
        items: [],
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
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.fulfillmentMethod ? { fulfillmentMethod: query.fulfillmentMethod } : {}),
      ...(query.fulfillmentStatus ? { fulfillmentStatus: query.fulfillmentStatus } : {}),
      ...(query.batchNumber ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } } : {}),
      ...(query.paidOnly === true ? { paymentStatus: 'PAID' } : {}),
      ...(query.q
        ? {
            OR: [
              { orderReference: { contains: query.q, mode: 'insensitive' } },
              { salesItem: { batchNumber: { contains: query.q, mode: 'insensitive' } } },
              { user: { name: { contains: query.q, mode: 'insensitive' } } },
              { user: { email: { contains: query.q, mode: 'insensitive' } } },
              { user: { phone: { contains: query.q } } },
              { salesItem: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const skip = (query.page - 1) * query.limit;
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip,
        take: query.limit,
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
      }),
      prisma.order.count({ where }),
    ]);

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
    });

    return res.json({
      items: normalizedOrders,
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
    const query = listOrdersQuerySchema.parse({
      ...req.query,
      page: 1,
      limit: 1000,
    });

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.fulfillmentMethod ? { fulfillmentMethod: query.fulfillmentMethod } : {}),
      ...(query.fulfillmentStatus ? { fulfillmentStatus: query.fulfillmentStatus } : {}),
      ...(query.batchNumber ? { salesItem: { batchNumber: { contains: query.batchNumber, mode: 'insensitive' } } } : {}),
      ...(query.paidOnly === true ? { paymentStatus: 'PAID' } : {}),
      ...(query.q
        ? {
            OR: [
              { orderReference: { contains: query.q, mode: 'insensitive' } },
              { salesItem: { batchNumber: { contains: query.q, mode: 'insensitive' } } },
              { user: { name: { contains: query.q, mode: 'insensitive' } } },
              { user: { email: { contains: query.q, mode: 'insensitive' } } },
              { user: { phone: { contains: query.q } } },
              { salesItem: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
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

    const rows = [
      [
        'Order Reference',
        'Batch Number',
        'Sales Item',
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
      ...orders.map((order) => [
        formatDisplayOrderReference({
          createdAt: order.createdAt,
          batchNumber: order.salesItem?.batchNumber,
          orderSequence: order.orderSequence,
        }),
        order.salesItem?.batchNumber || '',
        order.salesItem?.name || '',
        order.user?.name || '',
        order.user?.email || '',
        order.user?.phone || '',
        order.user?.address || '',
        order.user?.city || '',
        order.user?.province || '',
        order.user?.postalCode || '',
        order.quantity,
        order.paymentMethod,
        order.paymentStatus,
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

    return res.json({
      message: payload.fulfillmentStatus === 'PICKED_UP'
        ? 'Pickup confirmed successfully.'
        : payload.fulfillmentStatus === 'DELIVERED'
          ? 'Delivery confirmed successfully.'
          : 'Fulfilment status updated successfully.',
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
