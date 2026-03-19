import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { exportSchema } from '../middleware/validation.schemas';
import { exportTableData } from '../controllers/export.controller';

const router = Router();

router.use(authenticate);

// POST /api/connections/:id/export
// Body: { tables: string[], format: 'json' | 'csv' | 'sql' }
router.post('/:id/export', validate(exportSchema), exportTableData);

export default router;
