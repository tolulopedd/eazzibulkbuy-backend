import crypto from 'crypto';
import Stripe from 'stripe';
import { env, isHelcimConfigured, isStripeConfigured } from '../config/env.js';

export const stripe = isStripeConfigured ? new Stripe(env.stripeSecretKey) : null;

function escapeUnicodeForHelcim(value) {
  return value.replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function normalizeHelcimHashPayload(transactionData) {
  return escapeUnicodeForHelcim(JSON.stringify(transactionData));
}

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

export async function createHelcimCheckoutSession({
  amount,
  currency,
  orderReference,
}) {
  if (!isHelcimConfigured) {
    throw new Error('Helcim is not configured yet.');
  }

  const response = await fetch(`${env.helcimApiBaseUrl.replace(/\/$/, '')}/v2/helcim-pay/initialize`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-token': env.helcimApiToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      paymentType: 'purchase',
      paymentMethod: 'cc',
      amount: Number((amount / 100).toFixed(2)),
      currency,
      confirmationScreen: false,
      displayContactFields: 0,
      invoiceNumber: orderReference,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.checkoutToken || !payload?.secretToken) {
    throw new Error(payload?.message || 'Unable to start Helcim checkout right now.');
  }

  return payload;
}

export function validateHelcimPayResponse({ transactionData, receivedHash, secretToken }) {
  const normalizedPayload = normalizeHelcimHashPayload(transactionData);
  const generatedHash = crypto
    .createHash('sha256')
    .update(`${normalizedPayload}${secretToken}`)
    .digest('hex');

  return generatedHash === String(receivedHash || '').toLowerCase();
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
