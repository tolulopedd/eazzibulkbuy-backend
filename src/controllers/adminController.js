import { z } from 'zod';
import { prisma } from '../config/prisma.js';
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

const createSalesItemSchema = z.object({
  name: z.string().min(2).max(120),
  pricePerUnit: z.number().int().positive(),
  closingDate: z.string().datetime(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  pickupInstructions: z.string().max(500).optional(),
  description: z.string().max(500).optional(),
  deliveryEnabled: z.boolean().optional(),
  deliveryBaseRangeMax: z.number().int().min(1).optional(),
  deliveryBasePrice: z.number().int().min(0).optional(),
  deliveryAdditionalUnitPrice: z.number().int().min(0).optional(),
});

const updateSalesItemSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  pricePerUnit: z.number().int().positive().optional(),
  closingDate: z.string().datetime().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  pickupInstructions: z.string().max(500).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  deliveryEnabled: z.boolean().optional(),
  deliveryBaseRangeMax: z.number().int().min(1).optional(),
  deliveryBasePrice: z.number().int().min(0).optional(),
  deliveryAdditionalUnitPrice: z.number().int().min(0).optional(),
});

const listSalesItemsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  sortBy: z.enum(['createdAt', 'closingDate', 'name', 'pricePerUnit', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const listCustomersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  hasOrders: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'email']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const listOrdersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
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
  sortBy: z.enum(['createdAt', 'paidAt', 'totalAmount', 'status', 'paymentStatus']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const adminReportsQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  salesItemId: z.string().uuid().optional(),
  reportType: z.enum(['all', 'sales', 'payments', 'bookings', 'delivery', 'logistics']).default('all'),
});

export async function createSalesItemHandler(req, res, next) {
  try {
    const payload = createSalesItemSchema.parse(req.body);
    const item = await prisma.salesItem.create({
      data: {
        name: payload.name,
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
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
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

    const data = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
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
    const where = {
      ...(query.salesItemId ? { salesItemId: query.salesItemId } : {}),
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
        status: true,
        closingDate: true,
        pickupInstructions: true,
      },
    });

    const totalOrders = reconciledOrders.length;
    const paidOrders = reconciledOrders.filter((o) => isOrderPaidLike(o)).length;
    const confirmedOrders = reconciledOrders.filter((o) => o.status === 'CONFIRMED').length;
    const pendingOrders = reconciledOrders.filter((o) => !isOrderPaidLike(o) && ['PENDING_PAYMENT', 'AWAITING_MANUAL_PAYMENT'].includes(o.status)).length;
    const manualReviewOrders = reconciledOrders.filter((o) => o.paymentStatus === 'PENDING_REVIEW').length;
    const totalRevenue = reconciledOrders
      .filter((o) => isOrderPaidLike(o))
      .reduce((sum, o) => sum + o.totalAmount, 0);

    const byItem = new Map();
    const byPaymentMethod = new Map();
    const byPaymentStatus = new Map();
    const byOrderStatus = new Map();
    const byLocation = new Map();

    for (const order of reconciledOrders) {
      const key = order.salesItemId;
      const current = byItem.get(key) || {
        salesItemId: key,
        salesItemName: order.salesItem?.name || 'Unknown',
        totalOrders: 0,
        confirmedOrders: 0,
        revenue: 0,
      };
      current.totalOrders += 1;
      if (isOrderPaidLike(order)) {
        current.confirmedOrders += 1;
        current.revenue += order.totalAmount;
      }
      byItem.set(key, current);

      const paymentMethodKey = order.paymentMethod || 'UNSPECIFIED';
      const paymentMethodCurrent = byPaymentMethod.get(paymentMethodKey) || {
        paymentMethod: paymentMethodKey,
        totalOrders: 0,
        totalAmount: 0,
      };
      paymentMethodCurrent.totalOrders += 1;
      paymentMethodCurrent.totalAmount += order.totalAmount || 0;
      byPaymentMethod.set(paymentMethodKey, paymentMethodCurrent);

      const paymentStatusKey = order.paymentStatus || 'UNKNOWN';
      const paymentStatusCurrent = byPaymentStatus.get(paymentStatusKey) || {
        paymentStatus: paymentStatusKey,
        totalOrders: 0,
      };
      paymentStatusCurrent.totalOrders += 1;
      byPaymentStatus.set(paymentStatusKey, paymentStatusCurrent);

      const orderStatusKey = order.status || 'UNKNOWN';
      const orderStatusCurrent = byOrderStatus.get(orderStatusKey) || {
        status: orderStatusKey,
        totalOrders: 0,
      };
      orderStatusCurrent.totalOrders += 1;
      byOrderStatus.set(orderStatusKey, orderStatusCurrent);

      const locationKey = order.salesItem?.pickupInstructions || 'Location not set';
      const locationCurrent = byLocation.get(locationKey) || {
        location: locationKey,
        totalOrders: 0,
        confirmedOrders: 0,
        totalRevenue: 0,
      };
      locationCurrent.totalOrders += 1;
      if (isOrderPaidLike(order)) {
        locationCurrent.confirmedOrders += 1;
        locationCurrent.totalRevenue += order.totalAmount;
      }
      byLocation.set(locationKey, locationCurrent);
    }

    const liveSales = salesItems.filter((item) => item.status === 'ACTIVE' && new Date(item.closingDate) > new Date());

    res.json({
      filters: {
        startDate: query.startDate || null,
        endDate: query.endDate || null,
        salesItemId: query.salesItemId || null,
        reportType: query.reportType,
      },
      filterOptions: {
        salesItems: salesItems.map((item) => ({
          id: item.id,
          name: item.name,
          status: item.status,
          closingDate: item.closingDate,
        })),
      },
      summary: {
        totalOrders,
        paidOrders,
        confirmedOrders,
        pendingOrders,
        manualReviewOrders,
        totalRevenue,
        activeBulkSales: liveSales.length,
      },
      salesBreakdown: Array.from(byItem.values()),
      paymentBreakdown: {
        byMethod: Array.from(byPaymentMethod.values()),
        byStatus: Array.from(byPaymentStatus.values()),
        paidRevenue: totalRevenue,
      },
      bookingBreakdown: Array.from(byOrderStatus.values()),
      deliveryBreakdown: Array.from(byLocation.values()),
      logisticsBreakdown: {
        activeLocations: Array.from(new Set(liveSales.map((item) => item.pickupInstructions || 'Location not set'))),
        liveSales: liveSales.map((item) => ({
          salesItemId: item.id,
          salesItemName: item.name,
          closingDate: item.closingDate,
          location: item.pickupInstructions || 'Location not set',
        })),
      },
    });
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

    const where = {
      role: 'USER',
      ...(query.hasOrders === true ? { orders: { some: {} } } : {}),
      ...(query.hasOrders === false ? { orders: { none: {} } } : {}),
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
        where: { userId: { in: userIds } },
        _count: { _all: true },
      }),
      prisma.order.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          paymentStatus: 'PAID',
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.order.findMany({
        where: { userId: { in: userIds } },
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

export async function listOrdersHandler(req, res, next) {
  try {
    const query = listOrdersQuerySchema.parse(req.query);

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.paidOnly === true ? { paymentStatus: 'PAID' } : {}),
      ...(query.q
        ? {
            OR: [
              { orderReference: { contains: query.q, mode: 'insensitive' } },
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
              postalCode: true,
            },
          },
          salesItem: {
            select: {
              id: true,
              name: true,
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

    return res.json({
      items: reconciledOrders,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
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
