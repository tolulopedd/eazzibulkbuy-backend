import { Router } from 'express';
import { listPublicProduceItemsHandler, viewProduceImageHandler } from '../controllers/produceItemController.js';

const router = Router();

router.get('/', listPublicProduceItemsHandler);
router.get('/images/:encodedObjectKey', viewProduceImageHandler);

export default router;
