import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getBackups, triggerBackup, getBackup, deleteBackup, downloadBackup, verifyBackupEndpoint } from '../controllers/backup.controller';
import { backupProgressSSE } from '../controllers/sse.controller';

const router = Router();

router.use(authenticate);

router.get('/', getBackups);
router.post('/', triggerBackup);
router.get('/:id', getBackup);
router.delete('/:id', deleteBackup);
router.get('/:id/download', downloadBackup);
router.post('/:id/verify', verifyBackupEndpoint);
router.get('/:id/progress', backupProgressSSE);

export default router;
