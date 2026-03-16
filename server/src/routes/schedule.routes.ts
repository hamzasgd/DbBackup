import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getSchedules, createSchedule, updateSchedule, deleteSchedule } from '../controllers/schedule.controller';

const router = Router();
router.use(authenticate);
router.get('/', getSchedules);
router.post('/', createSchedule);
router.put('/:id', updateSchedule);
router.delete('/:id', deleteSchedule);

export default router;
