import { Router } from 'express';
import { saveCustomerDetailsHandler, searchCustomersHandler } from '../controllers/customerController.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const router = Router();
const searchRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyPrefix: 'customer-search',
});
const saveRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyPrefix: 'customer-save',
});

router.get('/search', searchRateLimiter, searchCustomersHandler);
router.post('/save', saveRateLimiter, saveCustomerDetailsHandler);

export default router;
