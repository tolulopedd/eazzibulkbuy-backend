import Stripe from 'stripe';
import { env, isStripeConfigured } from '../config/env.js';

export const stripe = isStripeConfigured ? new Stripe(env.stripeSecretKey) : null;

export async function createStripePaymentIntent({ amount, currency, orderReference, customerEmail }) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  return stripe.paymentIntents.create({
    amount,
    currency: currency.toLowerCase(),
    receipt_email: customerEmail,
    metadata: { orderReference },
    automatic_payment_methods: { enabled: true },
  });
}

export async function retrieveStripePaymentIntent(paymentIntentId) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  return stripe.paymentIntents.retrieve(paymentIntentId);
}

export function getManualPaymentInstructions(paymentMethod, options = {}) {
  const orderReference = options.orderReference || '{Include Order ID}';

  if (paymentMethod === 'INTERAC_E_TRANSFER') {
    return `Send Interac e-Transfer to: ${env.interacBusinessEmail} and receive confirmation within 6 hours. Use your Order ID ${orderReference} for this transfer as narration.`;
  }

  if (paymentMethod === 'MANUAL_BANK_TRANSFER') {
    return env.bankTransferInstructions;
  }

  if (paymentMethod === 'OTHER_CA_GATEWAY') {
    return 'Your payment is pending external Canadian gateway confirmation. Support will contact you.';
  }

  return '';
}
