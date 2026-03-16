import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';
import { Response, NextFunction } from 'express';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { page = '1', limit = '50' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.auditLog.count({ where: { userId: req.user!.userId } }),
    ]);

    res.json({ success: true, data: { logs, total } });
  } catch (err) { next(err); }
});

export default router;
