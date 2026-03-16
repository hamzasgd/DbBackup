import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { restoreBackup } from '../controllers/restore.controller';

const router = Router();
router.use(authenticate);
router.post('/', restoreBackup);

export default router;
