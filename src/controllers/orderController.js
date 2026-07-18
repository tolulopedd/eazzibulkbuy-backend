import {
  createOrderSchema,
  createPaymentIntentSchema,
  confirmManualTransferSchema,
  confirmCardPaymentSchema,
  createManualTransferUploadSchema,
  setOrderPaymentMethodSchema,
  createHelcimCheckoutSchema,
  confirmHelcimPaymentSchema,
} from '../utils/validators.js';
import {
  createPendingOrder,
  createOrderPaymentIntent,
  createOrderHelcimCheckoutSession,
  confirmManualTransferByReference,
  confirmCardPaymentByReference,
  confirmHelcimPaymentByReference,
  createManualTransferUploadByReference,
  setOrderPaymentMethodByReference,
} from '../services/orderService.js';

export async function createOrderHandler(req, res, next) {
  try {
    const payload = createOrderSchema.parse(req.body);
    const result = await createPendingOrder(payload);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function createPaymentIntentHandler(req, res, next) {
  try {
    const payload = createPaymentIntentSchema.parse({ orderReference: req.params.orderReference });
    const result = await createOrderPaymentIntent(payload.orderReference);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function createHelcimCheckoutHandler(req, res, next) {
  try {
    const payload = createHelcimCheckoutSchema.parse({ orderReference: req.params.orderReference });
    const result = await createOrderHelcimCheckoutSession(payload.orderReference);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function setOrderPaymentMethodHandler(req, res, next) {
  try {
    const payload = setOrderPaymentMethodSchema.parse({
      orderReference: req.params.orderReference,
      paymentMethod: req.body.paymentMethod,
    });
    const result = await setOrderPaymentMethodByReference(payload);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function confirmManualTransferHandler(req, res, next) {
  try {
    const payload = confirmManualTransferSchema.parse({
      orderReference: req.params.orderReference,
      transferProof: req.body.transferProof,
    });
    const result = await confirmManualTransferByReference(payload);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function createManualTransferUploadHandler(req, res, next) {
  try {
    const payload = createManualTransferUploadSchema.parse({
      orderReference: req.params.orderReference,
      fileName: req.body.fileName,
      contentType: req.body.contentType,
      sizeBytes: req.body.sizeBytes,
    });
    const result = await createManualTransferUploadByReference(payload);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function confirmCardPaymentHandler(req, res, next) {
  try {
    const payload = confirmCardPaymentSchema.parse({
      orderReference: req.params.orderReference,
      paymentIntentId: req.body.paymentIntentId,
    });
    const result = await confirmCardPaymentByReference(payload);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function confirmHelcimPaymentHandler(req, res, next) {
  try {
    const payload = confirmHelcimPaymentSchema.parse({
      orderReference: req.params.orderReference,
      checkoutToken: req.body.checkoutToken,
      transactionResponse: req.body.transactionResponse,
    });
    const result = await confirmHelcimPaymentByReference(payload);
    res.json(result);
  } catch (error) {
    next(error);
  }
}
