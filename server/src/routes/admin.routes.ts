import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, requireAdmin } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { adminUserStatusSchema, adminUserQuotaSchema } from '../middleware/validation.schemas';
import { getPlatformStats, listUsers, getUserDetail, setUserStatus, setUserQuota } from '../controllers/admin.controller';

// Admin surface is small and sensitive: stricter than the global API limiter.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many admin requests, please try again later' },
});

const router = Router();

// Every admin route requires a valid access token AND the ADMIN role.
router.use(authenticate, requireAdmin);

router.get('/stats', adminLimiter, getPlatformStats);
router.get('/users', adminLimiter, listUsers);
router.get('/users/:id', adminLimiter, getUserDetail);
router.patch('/users/:id/status', adminLimiter, validate(adminUserStatusSchema), setUserStatus);
router.patch('/users/:id/quota', adminLimiter, validate(adminUserQuotaSchema), setUserQuota);

export default router;
