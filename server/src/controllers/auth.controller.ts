import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  saveRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
} from '../services/token.service';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../services/audit.service';

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, email, password } = req.body;

    // Lock down registration after first user is created
    const userCount = await prisma.user.count();
    if (userCount > 0) throw new AppError('Registration is disabled', 403);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError('Email already in use', 409);

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { id: uuidv4(), name, email, passwordHash },
      select: { id: true, name: true, email: true, createdAt: true },
    });

    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });
    await saveRefreshToken(user.id, refreshToken);

    await logAudit(user.id, 'REGISTER', 'user', { email: user.email }, req.ip);

    res.status(201).json({ success: true, data: { user, accessToken, refreshToken } });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) throw new AppError('Invalid credentials', 401);

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) throw new AppError('Invalid credentials', 401);

    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });
    await saveRefreshToken(user.id, refreshToken);

    await logAudit(user.id, 'LOGIN', 'user', { email: user.email }, req.ip);

    res.json({
      success: true,
      data: {
        user: { id: user.id, name: user.name, email: user.email },
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken: token } = req.body;
    if (!token) throw new AppError('Refresh token required', 400);

    // Use a transaction to prevent race conditions when multiple 401 retries
    // hit the refresh endpoint simultaneously with the same token.
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.refreshToken.findUnique({ where: { token } });
      if (!existing || existing.expiresAt < new Date()) {
        throw new AppError('Invalid or expired refresh token', 401);
      }

      // Revoke the old token inside the transaction
      await tx.refreshToken.delete({ where: { id: existing.id } });

      const payload = verifyRefreshToken(token);

      const newAccessToken = generateAccessToken({ userId: payload.userId, email: payload.email });
      const newRefreshToken = generateRefreshToken({ userId: payload.userId, email: payload.email });

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      await tx.refreshToken.create({
        data: { id: uuidv4(), token: newRefreshToken, userId: payload.userId, expiresAt },
      });

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken: token } = req.body;
    if (token) await revokeRefreshToken(token);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

export async function getMe(req: Request & { user?: { userId: string; email: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
    });
    if (!user) throw new AppError('User not found', 404);
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req: Request & { user?: { userId: string; email: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) throw new AppError('User not found', 404);

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) throw new AppError('Current password is incorrect', 401);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await revokeAllUserTokens(user.id);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
}
