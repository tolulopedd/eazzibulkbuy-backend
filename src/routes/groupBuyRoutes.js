import { Router } from 'express';
import { listActiveGroupBuysHandler } from '../controllers/groupBuyController.js';

const router = Router();

router.get('/', listActiveGroupBuysHandler);

export default router;
