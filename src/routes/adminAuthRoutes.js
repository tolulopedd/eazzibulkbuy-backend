import { Router } from 'express';
import {
  adminLoginHandler,
  adminLogoutHandler,
  adminMeHandler,
  acceptInviteHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
} from '../controllers/adminAuthController.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const router = Router();
const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'admin-login',
});

router.post('/login', loginRateLimiter, adminLoginHandler);
router.post('/invite/accept', loginRateLimiter, acceptInviteHandler);
router.post('/forgot-password', loginRateLimiter, forgotPasswordHandler);
router.post('/reset-password', loginRateLimiter, resetPasswordHandler);
router.post('/logout', requireAdminAuth, adminLogoutHandler);
router.get('/me', requireAdminAuth, adminMeHandler);

export default router;
