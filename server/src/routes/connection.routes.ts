import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  getDbInfo,
} from '../controllers/connection.controller';

const router = Router();

router.use(authenticate);

router.get('/', getConnections);
router.get('/:id', getConnection);
router.post('/', createConnection);
router.put('/:id', updateConnection);
router.delete('/:id', deleteConnection);
router.post('/:id/test', testConnection);
router.get('/:id/info', getDbInfo);

export default router;
