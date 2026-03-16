import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { addScheduleJob, removeScheduleJob } from '../queue/schedule.queue';

export async function getSchedules(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const schedules = await prisma.schedule.findMany({
      where: { connection: { userId: req.user!.userId } },
      include: { connection: { select: { id: true, name: true, type: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: schedules });
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
    const updated = await prisma.schedule.update({
      where: { id: req.params.id },
      data: { name, frequency, cronExpression, isActive, retentionDays },
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
