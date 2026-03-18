import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getMigrations, getMigration, createMigration, deleteMigration, verifyMigration } from '../controllers/migration.controller';
import { migrationProgressSSE } from '../controllers/sse.controller';

const router = Router();

router.use(authenticate);

router.get('/', getMigrations);
router.get('/:id', getMigration);
router.post('/', createMigration);
router.post('/:id/verify', verifyMigration);
router.delete('/:id', deleteMigration);
router.get('/:id/progress', migrationProgressSSE);

export default router;
