import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { scheduleSchema } from '../middleware/validation.schemas';
import { getSchedules, createSchedule, updateSchedule, deleteSchedule } from '../controllers/schedule.controller';

const router = Router();
router.use(authenticate);
router.get('/', getSchedules);
router.post('/', validate(scheduleSchema), createSchedule);
// Partial schema: updates may send only some fields (e.g. { isActive } from the Pause/Resume toggle)
router.put('/:id', validate(scheduleSchema.partial()), updateSchedule);
router.delete('/:id', deleteSchedule);

export default router;
