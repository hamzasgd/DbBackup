import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { dataSyncSchema } from '../middleware/validation.schemas';
import { startDataSync, listDataSyncs, cancelDataSync } from '../controllers/data-sync.controller';

const router = Router();
router.use(authenticate);
router.get('/', listDataSyncs);
router.post('/', validate(dataSyncSchema), startDataSync);
router.post('/:id/cancel', cancelDataSync);

export default router;
