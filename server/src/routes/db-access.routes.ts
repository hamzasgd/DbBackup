import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { dbAccessCreateSchema, dbAccessUpdateSchema } from '../middleware/validation.schemas';
import {
  closeAccessSession, createAccess, deleteAccess, gatewayStatus, listAccess, listAccessSessions, listAccessTables,
  listSessionQueries, resetAccessPassword, updateAccess,
} from '../controllers/db-access.controller';

const router = Router();
router.use(authenticate);
router.get('/status', gatewayStatus);
router.get('/tables', listAccessTables);
router.get('/', listAccess);
router.post('/', validate(dbAccessCreateSchema), createAccess);
router.patch('/:id', validate(dbAccessUpdateSchema), updateAccess);
router.post('/:id/password', resetAccessPassword);
router.delete('/:id', deleteAccess);
router.get('/:id/sessions', listAccessSessions);
router.get('/sessions/:sessionId/queries', listSessionQueries);
router.post('/sessions/:sessionId/close', closeAccessSession);

export default router;
