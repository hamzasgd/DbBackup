import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { dataSyncSchema, liveSyncSchema } from '../middleware/validation.schemas';
import { startDataSync, listDataSyncs, cancelDataSync } from '../controllers/data-sync.controller';
import { listLiveSyncs, startLiveSync, stopLiveSync, removeLiveSync } from '../controllers/live-sync.controller';

const router = Router();
router.use(authenticate);
router.get('/live', listLiveSyncs);
router.post('/live', validate(liveSyncSchema), startLiveSync);
router.post('/live/:id/stop', stopLiveSync);
router.delete('/live/:id', removeLiveSync);
router.get('/', listDataSyncs);
router.post('/', validate(dataSyncSchema), startDataSync);
router.post('/:id/cancel', cancelDataSync);

export default router;
