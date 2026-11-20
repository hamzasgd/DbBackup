import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { restoreSchema } from '../middleware/validation.schemas';
import { restoreBackup, checkRestore, listRestores } from '../controllers/restore.controller';
import { restoreProgressSSE } from '../controllers/sse.controller';

const router = Router();
router.use(authenticate);
router.get('/', listRestores);
router.get('/check', checkRestore);
router.post('/', validate(restoreSchema), restoreBackup);
router.get('/:jobId/progress', restoreProgressSSE);

export default router;
