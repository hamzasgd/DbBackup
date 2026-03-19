import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { scheduleSchema } from '../middleware/validation.schemas';
import { getSchedules, createSchedule, updateSchedule, deleteSchedule } from '../controllers/schedule.controller';

const router = Router();
router.use(authenticate);
router.get('/', getSchedules);
router.post('/', validate(scheduleSchema), createSchedule);
router.put('/:id', validate(scheduleSchema), updateSchedule);
router.delete('/:id', deleteSchedule);

export default router;
