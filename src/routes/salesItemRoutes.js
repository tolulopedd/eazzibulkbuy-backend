import { Router } from 'express';
import { getSalesItemByIdHandler, listActiveSalesItemsHandler } from '../controllers/salesItemController.js';

const router = Router();

router.get('/', listActiveSalesItemsHandler);
router.get('/:salesItemId', getSalesItemByIdHandler);

export default router;
