import { z } from 'zod';
import { sanitizeEmail, sanitizeText } from './sanitize.js';

const phoneSchema = z.string().regex(/^\d{10}$/, 'Phone number must be exactly 10 digits.');

export const createOrderSchema = z.object({
  existingCustomerId: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().uuid().optional()),
  title: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.enum(['Mr', 'Mrs', 'Miss']).optional()),
  firstName: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().min(2).max(80).optional()),
  lastName: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().min(2).max(80).optional()),
  email: z.preprocess((v) => (v === undefined ? undefined : sanitizeEmail(v)), z.string().email().optional()),
  phone: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), phoneSchema.optional()),
  address: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().min(5).max(250).optional()),
  city: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().min(2).max(120).optional()),
  province: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().min(2).max(120).optional()),
  postalCode: z.preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().min(3).max(20).optional()),
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
  preferredPickupLocation: z
    .preprocess((v) => (v === undefined ? undefined : sanitizeText(v)), z.string().min(2).max(180).optional()),
}).superRefine((payload, ctx) => {
  if (!payload.existingCustomerId) {
    const requiredFields = [
      ['firstName', payload.firstName],
      ['lastName', payload.lastName],
      ['email', payload.email],
      ['phone', payload.phone],
      ['address', payload.address],
      ['city', payload.city],
      ['province', payload.province],
      ['postalCode', payload.postalCode],
    ];

    for (const [field, value] of requiredFields) {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Required',
        });
      }
    }
  }

  const usesPickup = payload.items.some((item) => item.fulfillmentMethod === 'PICKUP');
  const usesDelivery = payload.items.some((item) => item.fulfillmentMethod === 'DELIVERY');

  if (usesPickup && !payload.preferredPickupLocation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preferredPickupLocation'],
      message: 'Select your preferred pickup location.',
    });
  }

  if (usesDelivery && payload.preferredPickupLocation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preferredPickupLocation'],
      message: 'Preferred pickup location is only needed for pickup orders.',
    });
  }
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
  }).optional(),
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
