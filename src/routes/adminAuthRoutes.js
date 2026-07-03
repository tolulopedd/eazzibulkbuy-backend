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
import { requireTrustedOrigin } from '../middleware/security.js';

const router = Router();
const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'admin-login',
});

router.post('/login', requireTrustedOrigin, loginRateLimiter, adminLoginHandler);
router.post('/invite/accept', requireTrustedOrigin, loginRateLimiter, acceptInviteHandler);
router.post('/forgot-password', requireTrustedOrigin, loginRateLimiter, forgotPasswordHandler);
router.post('/reset-password', requireTrustedOrigin, loginRateLimiter, resetPasswordHandler);
router.post('/logout', requireTrustedOrigin, requireAdminAuth, adminLogoutHandler);
router.get('/me', requireAdminAuth, adminMeHandler);

export default router;
