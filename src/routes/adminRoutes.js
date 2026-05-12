import { Router } from 'express';
import { requireAdminAuth, requireAdminRoles } from '../middleware/adminAuth.js';
import {
  createSalesItemHandler,
  adminReportsHandler,
  listSalesItemsHandler,
  updateSalesItemHandler,
  deleteSalesItemHandler,
  listCustomersHandler,
  listOrdersHandler,
  confirmInteracPaymentHandler,
  paymentProofViewUrlHandler,
  resendPaymentConfirmationHandler,
} from '../controllers/adminController.js';
import { createUserHandler, inviteUserHandler, listUsersHandler } from '../controllers/adminUserController.js';

const router = Router();

router.use(requireAdminAuth);
router.get('/users', requireAdminRoles('SUPERADMIN'), listUsersHandler);
router.post('/users', requireAdminRoles('SUPERADMIN'), createUserHandler);
router.post('/users/invite', requireAdminRoles('SUPERADMIN'), inviteUserHandler);
router.get('/sales-items', requireAdminRoles('ADMIN', 'SUPERADMIN'), listSalesItemsHandler);
router.post('/sales-items', requireAdminRoles('ADMIN', 'SUPERADMIN'), createSalesItemHandler);
router.patch('/sales-items/:salesItemId', requireAdminRoles('ADMIN', 'SUPERADMIN'), updateSalesItemHandler);
router.delete('/sales-items/:salesItemId', requireAdminRoles('ADMIN', 'SUPERADMIN'), deleteSalesItemHandler);
router.get('/reports', requireAdminRoles('ADMIN', 'SUPERADMIN'), adminReportsHandler);
router.get('/customers', requireAdminRoles('ADMIN', 'SUPERADMIN'), listCustomersHandler);
router.get('/orders', requireAdminRoles('ADMIN', 'SUPERADMIN'), listOrdersHandler);
router.get('/payments/:orderReference/proof-view-url', requireAdminRoles('ADMIN', 'SUPERADMIN'), paymentProofViewUrlHandler);
router.post('/payments/:orderReference/confirm-interac', requireAdminRoles('ADMIN', 'SUPERADMIN'), confirmInteracPaymentHandler);
router.post('/payments/:orderReference/resend-confirmation', requireAdminRoles('ADMIN', 'SUPERADMIN'), resendPaymentConfirmationHandler);

export default router;
