import { Router } from 'express';
import express from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { connectionSchema } from '../middleware/validation.schemas';
import {
  getConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  resetSshHostKey,
  getDbInfo,
  getHeartbeat,
  exportConfigBundle,
  importConfigBundle,
} from '../controllers/connection.controller';

const router = Router();

router.use(authenticate);

router.get('/', getConnections);
router.get('/:id', getConnection);
router.post('/', validate(connectionSchema), createConnection);
router.put('/:id', validate(connectionSchema), updateConnection);
router.delete('/:id', deleteConnection);
router.post('/:id/test', testConnection);
router.post('/:id/ssh-host-key/reset', resetSshHostKey);
router.get('/:id/info', getDbInfo);
router.get('/:id/heartbeat', getHeartbeat);
router.post('/bundle/export', exportConfigBundle);
router.post('/bundle/import', express.raw({ type: 'application/octet-stream', limit: '10mb' }), importConfigBundle);

export default router;
