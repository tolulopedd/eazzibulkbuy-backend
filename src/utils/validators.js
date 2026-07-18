import { z } from 'zod';
import { sanitizeEmail, sanitizeText } from './sanitize.js';

export const createOrderSchema = z.object({
  title: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.enum(['Mr', 'Mrs', 'Miss']).optional()),
  firstName: z.preprocess((v) => sanitizeText(v), z.string().min(2).max(80)),
  lastName: z.preprocess((v) => sanitizeText(v), z.string().min(2).max(80)),
  email: z.preprocess((v) => sanitizeEmail(v), z.string().email()),
  phone: z.preprocess((v) => sanitizeText(v), z.string().min(7).max(30)),
  address: z.preprocess((v) => sanitizeText(v), z.string().min(5).max(250)),
  city: z.preprocess((v) => sanitizeText(v), z.string().min(2).max(120)),
  province: z.preprocess((v) => sanitizeText(v), z.string().min(2).max(120)),
  postalCode: z.preprocess((v) => sanitizeText(v), z.string().min(3).max(20)),
  items: z.array(z.object({
    salesItemId: z.preprocess((v) => sanitizeText(v), z.string().min(1)),
    quantity: z.number().int().min(1),
    fulfillmentMethod: z
      .preprocess((v) => sanitizeText(v), z.enum(['PICKUP', 'DELIVERY']))
      .default('PICKUP'),
  })).min(1),
  paymentMethod: z
    .preprocess((v) => sanitizeText(v), z.enum(['STRIPE_CARD', 'INTERAC_E_TRANSFER', 'MANUAL_BANK_TRANSFER', 'OTHER_CA_GATEWAY']))
    .optional(),
});

export const setOrderPaymentMethodSchema = z.object({
  orderReference: z.string().uuid(),
  paymentMethod: z.preprocess(
    (v) => sanitizeText(v),
    z.enum(['STRIPE_CARD', 'INTERAC_E_TRANSFER', 'MANUAL_BANK_TRANSFER', 'OTHER_CA_GATEWAY']),
  ),
});

export const createPaymentIntentSchema = z.object({
  orderReference: z.string().uuid(),
});

export const confirmManualTransferSchema = z.object({
  orderReference: z.string().uuid(),
  transferProof: z.object({
    fileName: z.preprocess((v) => sanitizeText(v), z.string().min(3).max(180)),
    contentType: z.preprocess((v) => sanitizeText(v), z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/)),
    sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
    objectKey: z.preprocess((v) => sanitizeText(v), z.string().min(10).max(300)),
  }),
});

export const createManualTransferUploadSchema = z.object({
  orderReference: z.string().uuid(),
  fileName: z.preprocess((v) => sanitizeText(v), z.string().min(3).max(180)),
  contentType: z.preprocess((v) => sanitizeText(v), z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/)),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
});

export const confirmCardPaymentSchema = z.object({
  orderReference: z.string().uuid(),
  paymentIntentId: z.preprocess((v) => sanitizeText(v), z.string().min(5).max(200)),
});

export const createHelcimCheckoutSchema = z.object({
  orderReference: z.string().uuid(),
});

export const confirmHelcimPaymentSchema = z.object({
  orderReference: z.string().uuid(),
  checkoutToken: z.preprocess((v) => sanitizeText(v), z.string().min(5).max(200)),
  transactionResponse: z.object({
    data: z.record(z.any()),
    hash: z.preprocess((v) => sanitizeText(v), z.string().min(8).max(200)),
  }),
});
