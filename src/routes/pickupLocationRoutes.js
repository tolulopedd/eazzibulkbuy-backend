import { Router } from 'express';
import { listPublicPickupLocationsHandler } from '../controllers/pickupLocationController.js';

const router = Router();

router.get('/', listPublicPickupLocationsHandler);

export default router;
