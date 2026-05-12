import { env } from '../config/env.js';
import { stripe } from '../services/paymentService.js';
import { markOrderPaidByReference } from '../services/orderService.js';

export async function stripeWebhookHandler(req, res, next) {
  try {
    if (!stripe || !env.stripeWebhookSecret) {
      return res.status(400).send('Stripe webhook not configured');
    }

    const signature = String(req.headers['stripe-signature'] || '');
    const event = stripe.webhooks.constructEvent(req.body, signature, env.stripeWebhookSecret);

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const orderReference = paymentIntent.metadata?.orderReference;
      if (orderReference) {
        await markOrderPaidByReference({
          orderReference,
          providerReference: paymentIntent.id,
          payload: paymentIntent,
        });
      }
    }

    return res.json({ received: true });
  } catch (error) {
    if (error?.type === 'StripeSignatureVerificationError') {
      return res.status(400).send('Invalid Stripe signature');
    }
    next(error);
  }
}
