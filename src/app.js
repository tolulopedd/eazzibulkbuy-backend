import express from 'express';
import cors from 'cors';
import orderRoutes from './routes/orderRoutes.js';
import groupBuyRoutes from './routes/groupBuyRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import salesItemRoutes from './routes/salesItemRoutes.js';
import pickupLocationRoutes from './routes/pickupLocationRoutes.js';
import adminAuthRoutes from './routes/adminAuthRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import { stripeWebhookHandler } from './controllers/webhookController.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { stripeWebhookGuard } from './middleware/webhookGuard.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { applySecurityHeaders } from './middleware/security.js';
import { allowedFrontendOrigins, env } from './config/env.js';

export const app = express();
app.disable('x-powered-by');
const webhookRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyPrefix: 'stripe-webhook',
});

const corsOriginHandler = (origin, callback) => {
  if (!origin) {
    callback(null, true);
    return;
  }

  if (allowedFrontendOrigins.includes(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS.`));
};

app.use(
  cors({
    origin: corsOriginHandler,
    credentials: true,
  })
);
app.use(applySecurityHeaders);

app.post(
  '/api/webhooks/stripe',
  webhookRateLimiter,
  express.raw({ type: 'application/json', limit: '1mb' }),
  stripeWebhookGuard,
  stripeWebhookHandler
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/group-buys', groupBuyRoutes);
app.use('/api/sales-items', salesItemRoutes);
app.use('/api/pickup-locations', pickupLocationRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
