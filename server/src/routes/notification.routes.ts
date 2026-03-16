import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getNotificationSettings, upsertNotificationSettings, testNotificationEndpoint } from '../controllers/notification.controller';

const router = Router();
router.use(authenticate);

router.get('/', getNotificationSettings);
router.put('/', upsertNotificationSettings);
router.post('/test', testNotificationEndpoint);

export default router;
