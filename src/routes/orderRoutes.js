import { Router } from 'express';
import {
  createOrderHandler,
  createPaymentIntentHandler,
  createHelcimCheckoutHandler,
  setOrderPaymentMethodHandler,
  confirmManualTransferHandler,
  confirmCardPaymentHandler,
  confirmHelcimPaymentHandler,
  createManualTransferUploadHandler,
} from '../controllers/orderController.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const router = Router();
const createOrderRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyPrefix: 'create-order',
});
const paymentIntentRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 40,
  keyPrefix: 'create-payment-intent',
});
const paymentMethodRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 40,
  keyPrefix: 'set-payment-method',
});
const manualTransferConfirmRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyPrefix: 'confirm-manual-transfer',
});
const cardConfirmRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyPrefix: 'confirm-card-payment',
});
const manualTransferUploadRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyPrefix: 'manual-transfer-upload-url',
});
const helcimCheckoutRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyPrefix: 'helcim-checkout-session',
});
const helcimConfirmRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyPrefix: 'helcim-payment-confirmation',
});

router.post('/', createOrderRateLimiter, createOrderHandler);
router.patch('/:orderReference/payment-method', paymentMethodRateLimiter, setOrderPaymentMethodHandler);
router.post('/:orderReference/payment-intent', paymentIntentRateLimiter, createPaymentIntentHandler);
router.post('/:orderReference/helcim-checkout-session', helcimCheckoutRateLimiter, createHelcimCheckoutHandler);
router.post(
  '/:orderReference/manual-transfer-upload-url',
  manualTransferUploadRateLimiter,
  createManualTransferUploadHandler,
);
router.post(
  '/:orderReference/manual-transfer-confirmation',
  manualTransferConfirmRateLimiter,
  confirmManualTransferHandler,
);
router.post(
  '/:orderReference/card-payment-confirmation',
  cardConfirmRateLimiter,
  confirmCardPaymentHandler,
);
router.post(
  '/:orderReference/helcim-payment-confirmation',
  helcimConfirmRateLimiter,
  confirmHelcimPaymentHandler,
);

export default router;
