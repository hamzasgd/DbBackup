import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import parser from 'cron-parser';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { addScheduleJob, removeScheduleJob } from '../queue/schedule.queue';

function getNextRunAt(cronExpression: string): Date {
  try {
    return parser.parseExpression(cronExpression, { currentDate: new Date() }).next().toDate();
  } catch {
    throw new AppError('Invalid cron expression', 400);
  }
}

export async function getSchedules(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const schedules = await prisma.schedule.findMany({
      where: { connection: { userId: req.user!.userId } },
      include: { connection: { select: { id: true, name: true, type: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const enriched = await Promise.all(
      schedules.map(async (schedule) => {
        const computedNextRunAt = schedule.isActive
          ? getNextRunAt(schedule.cronExpression)
          : null;

        if (
          schedule.isActive &&
          computedNextRunAt &&
          (!schedule.nextRunAt || Math.abs(computedNextRunAt.getTime() - schedule.nextRunAt.getTime()) > 1000)
        ) {
          await prisma.schedule.update({
            where: { id: schedule.id },
            data: { nextRunAt: computedNextRunAt },
          });
        }

        const history = await prisma.backup.findMany({
          where: {
            connectionId: schedule.connectionId,
            OR: [
              { snapshotName: { startsWith: `scheduled-${schedule.id}-` } },
              { snapshotName: { startsWith: `scheduled-${schedule.name}` } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            status: true,
            createdAt: true,
            completedAt: true,
            fileSize: true,
            error: true,
          },
        });

        return {
          ...schedule,
          nextRunAt: schedule.isActive ? computedNextRunAt : null,
          history,
        };
      })
    );

    res.json({ success: true, data: enriched });
  } catch (err) { next(err); }
}

export async function createSchedule(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { connectionId, name, frequency, cronExpression, retentionDays } = req.body;

    const conn = await prisma.connection.findFirst({
      where: { id: connectionId, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);

    const schedule = await prisma.schedule.create({
      data: {
        id: uuidv4(),
        connectionId,
        name,
        frequency,
        cronExpression,
        nextRunAt: getNextRunAt(cronExpression),
        retentionDays: retentionDays || 30,
        isActive: true,
      },
    });

    await addScheduleJob(schedule);
    res.status(201).json({ success: true, data: schedule });
  } catch (err) { next(err); }
}

export async function updateSchedule(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await prisma.schedule.findFirst({
      where: { id: req.params.id, connection: { userId: req.user!.userId } },
    });
    if (!existing) throw new AppError('Schedule not found', 404);

    const { name, frequency, cronExpression, isActive, retentionDays } = req.body;
    const nextRunAt = isActive === false
      ? null
      : (cronExpression ? getNextRunAt(cronExpression) : getNextRunAt(existing.cronExpression));

    const updated = await prisma.schedule.update({
      where: { id: req.params.id },
      data: { name, frequency, cronExpression, isActive, retentionDays, nextRunAt },
    });

    await removeScheduleJob(req.params.id);
    if (updated.isActive) await addScheduleJob(updated);

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
}

export async function deleteSchedule(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await prisma.schedule.findFirst({
      where: { id: req.params.id, connection: { userId: req.user!.userId } },
    });
    if (!existing) throw new AppError('Schedule not found', 404);

    await removeScheduleJob(req.params.id);
    await prisma.schedule.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) { next(err); }
}
