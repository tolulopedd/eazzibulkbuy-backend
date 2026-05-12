import express from 'express';
import cors from 'cors';
import orderRoutes from './routes/orderRoutes.js';
import groupBuyRoutes from './routes/groupBuyRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import salesItemRoutes from './routes/salesItemRoutes.js';
import adminAuthRoutes from './routes/adminAuthRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import { stripeWebhookHandler } from './controllers/webhookController.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { stripeWebhookGuard } from './middleware/webhookGuard.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { env } from './config/env.js';

export const app = express();
const webhookRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyPrefix: 'stripe-webhook',
});

app.use(
  cors({
    origin: env.frontendUrl,
    credentials: true,
  })
);

app.post(
  '/api/webhooks/stripe',
  webhookRateLimiter,
  express.raw({ type: 'application/json', limit: '1mb' }),
  stripeWebhookGuard,
  stripeWebhookHandler
);

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/group-buys', groupBuyRoutes);
app.use('/api/sales-items', salesItemRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
