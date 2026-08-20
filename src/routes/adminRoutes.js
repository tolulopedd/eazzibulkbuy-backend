import { Router } from 'express';
import { requireAdminAuth, requireAdminRoles } from '../middleware/adminAuth.js';
import { requireTrustedOrigin } from '../middleware/security.js';
import {
  createSalesItemHandler,
  createDiscountOrderHandler,
  createAdminDiscountOrderUploadHandler,
  adminReportsHandler,
  exportReportsHandler,
  listSalesItemsHandler,
  updateSalesItemHandler,
  deleteSalesItemHandler,
  listCustomersHandler,
  listOrdersHandler,
  exportOrdersHandler,
  updatePreferredPickupLocationHandler,
  updateFulfillmentStatusHandler,
  confirmInteracPaymentHandler,
  createAdminIncompleteOrderUploadHandler,
  markIncompleteOrderPendingReviewHandler,
  deleteIncompleteOrderHandler,
  paymentProofViewUrlHandler,
  resendPaymentConfirmationHandler,
  resolvePaymentHandler,
  updateCustomerHandler,
  createAdminCustomerHandler,
  approveCustomerUpdateRequestHandler,
  declineCustomerUpdateRequestHandler,
  exportCustomersHandler,
  listDiscountOrdersHandler,
  listPickupNoticesHandler,
  sendPickupNoticesHandler,
} from '../controllers/adminController.js';
import {
  listAdminPickupLocationsHandler,
  createPickupLocationHandler,
  updatePickupLocationHandler,
  deletePickupLocationHandler,
} from '../controllers/pickupLocationController.js';
import { createUserHandler, inviteUserHandler, listUsersHandler } from '../controllers/adminUserController.js';

const router = Router();

router.use(requireAdminAuth);
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  return requireTrustedOrigin(req, res, next);
});
router.get('/users', requireAdminRoles('SUPERADMIN'), listUsersHandler);
router.post('/users', requireAdminRoles('SUPERADMIN'), createUserHandler);
router.post('/users/invite', requireAdminRoles('SUPERADMIN'), inviteUserHandler);
router.get('/sales-items', requireAdminRoles('ADMIN', 'SUPERADMIN'), listSalesItemsHandler);
router.post('/sales-items', requireAdminRoles('ADMIN', 'SUPERADMIN'), createSalesItemHandler);
router.patch('/sales-items/:salesItemId', requireAdminRoles('ADMIN', 'SUPERADMIN'), updateSalesItemHandler);
router.delete('/sales-items/:salesItemId', requireAdminRoles('ADMIN', 'SUPERADMIN'), deleteSalesItemHandler);
router.get('/reports', requireAdminRoles('ADMIN', 'SUPERADMIN'), adminReportsHandler);
router.get('/reports/export', requireAdminRoles('ADMIN', 'SUPERADMIN'), exportReportsHandler);
router.get('/customers', requireAdminRoles('ADMIN', 'SUPERADMIN'), listCustomersHandler);
router.get('/customers/export', requireAdminRoles('ADMIN', 'SUPERADMIN'), exportCustomersHandler);
router.post('/customers', requireAdminRoles('ADMIN', 'SUPERADMIN'), createAdminCustomerHandler);
router.patch('/customers/:customerId', requireAdminRoles('ADMIN', 'SUPERADMIN'), updateCustomerHandler);
router.post('/customers/update-requests/:requestId/approve', requireAdminRoles('ADMIN', 'SUPERADMIN'), approveCustomerUpdateRequestHandler);
router.post('/customers/update-requests/:requestId/decline', requireAdminRoles('ADMIN', 'SUPERADMIN'), declineCustomerUpdateRequestHandler);
router.get('/discount-orders', requireAdminRoles('ADMIN', 'SUPERADMIN'), listDiscountOrdersHandler);
router.post('/discount-orders/upload-url', requireAdminRoles('ADMIN', 'SUPERADMIN'), createAdminDiscountOrderUploadHandler);
router.post('/discount-orders', requireAdminRoles('ADMIN', 'SUPERADMIN'), createDiscountOrderHandler);
router.get('/pickup-notices', requireAdminRoles('ADMIN', 'SUPERADMIN'), listPickupNoticesHandler);
router.post('/pickup-notices/send', requireAdminRoles('ADMIN', 'SUPERADMIN'), sendPickupNoticesHandler);
router.get('/pickup-locations', requireAdminRoles('ADMIN', 'SUPERADMIN'), listAdminPickupLocationsHandler);
router.post('/pickup-locations', requireAdminRoles('ADMIN', 'SUPERADMIN'), createPickupLocationHandler);
router.patch('/pickup-locations/:pickupLocationId', requireAdminRoles('ADMIN', 'SUPERADMIN'), updatePickupLocationHandler);
router.delete('/pickup-locations/:pickupLocationId', requireAdminRoles('ADMIN', 'SUPERADMIN'), deletePickupLocationHandler);
router.get('/orders', requireAdminRoles('ADMIN', 'SUPERADMIN'), listOrdersHandler);
router.get('/orders/export', requireAdminRoles('ADMIN', 'SUPERADMIN'), exportOrdersHandler);
router.patch('/orders/:orderReference/preferred-pickup-location', requireAdminRoles('ADMIN', 'SUPERADMIN'), updatePreferredPickupLocationHandler);
router.patch('/orders/:orderReference/fulfillment-status', requireAdminRoles('ADMIN', 'SUPERADMIN'), updateFulfillmentStatusHandler);
router.get('/payments/:orderReference/proof-view-url', requireAdminRoles('ADMIN', 'SUPERADMIN'), paymentProofViewUrlHandler);
router.post('/payments/:orderReference/incomplete-upload-url', requireAdminRoles('ADMIN', 'SUPERADMIN'), createAdminIncompleteOrderUploadHandler);
router.post('/payments/:orderReference/mark-pending-review', requireAdminRoles('ADMIN', 'SUPERADMIN'), markIncompleteOrderPendingReviewHandler);
router.post('/payments/:orderReference/confirm-interac', requireAdminRoles('ADMIN', 'SUPERADMIN'), confirmInteracPaymentHandler);
router.post('/payments/:orderReference/resend-confirmation', requireAdminRoles('ADMIN', 'SUPERADMIN'), resendPaymentConfirmationHandler);
router.post('/payments/:orderReference/resolve', requireAdminRoles('ADMIN', 'SUPERADMIN'), resolvePaymentHandler);
router.delete('/payments/:orderReference/incomplete-order', requireAdminRoles('ADMIN', 'SUPERADMIN'), deleteIncompleteOrderHandler);

export default router;
