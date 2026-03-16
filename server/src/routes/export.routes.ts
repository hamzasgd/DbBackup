import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { exportTableData } from '../controllers/export.controller';

const router = Router();

router.use(authenticate);

// POST /api/connections/:id/export
// Body: { tables: string[], format: 'json' | 'csv' | 'sql' }
router.post('/:id/export', exportTableData);

export default router;
