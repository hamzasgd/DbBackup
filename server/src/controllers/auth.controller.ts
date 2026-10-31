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
import { notify } from '../services/notification.service';
import { isLoginLocked, recordLoginFailure, clearLoginFailures } from '../services/login-lockout.service';


/** Fire-and-forget login alert (email/Slack) respecting the user's notifyOnLogin toggle. */
function sendLoginAlert(userId: string, event: 'LOGIN' | 'PASSKEY_LOGIN', email: string, ip: string | undefined, userAgent: string | string[] | undefined): void {
  const ua = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  const { browser, os } = parseUserAgent(ua);
  void notify(userId, {
    event,
    title: '🔐 New Login',
    message: `Sign-in from ${browser} on ${os} (${ip ?? 'unknown IP'})`,
    details: {
      Account: email,
      Browser: browser,
      OS: os,
      IP: ip ?? 'unknown',
      Time: new Date().toISOString(),
    },
  }).catch(() => undefined);
}


/** True when the account is inside the post-password-change cool-down. */
function loginLockRemaining(user: { loginLockedUntil?: Date | null }): number /* ms */ {
  if (!user.loginLockedUntil) return 0;
  return Math.max(0, new Date(user.loginLockedUntil).getTime() - Date.now());
}

function lockMessage(msLeft: number): string {
  const mins = Math.ceil(msLeft / 60000);
  const human = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return `Sign-in is locked for ${human} after the password change (security cool-down). Try again later.`;
}

/**
 * Count the failure and, when the threshold trips, audit + alert the owner
 * by email/Slack exactly once per lockout.
 */
async function maybeLockout(ip: string | undefined): Promise<void> {
  if (!recordLoginFailure(ip)) return;
  const minutes = parseInt(process.env.LOGIN_LOCKOUT_MINUTES ?? '15', 10) || 15;
  await logAudit(null, 'LOGIN_IP_LOCKOUT', 'user', { ip, attempts: process.env.LOGIN_LOCKOUT_ATTEMPTS ?? '3', minutes }, ip);
  await notifyOwner({
    event: 'LOGIN_IP_LOCKOUT',
    title: '🚨 Login Lockout Triggered',
    message: `${process.env.LOGIN_LOCKOUT_ATTEMPTS ?? 3} failed sign-in attempts from ${ip ?? 'unknown IP'} — this address is now locked for ${minutes} minutes.`,
    details: { IP: ip ?? 'unknown', Attempts: process.env.LOGIN_LOCKOUT_ATTEMPTS ?? '3', 'Locked for': `${minutes} minutes`, Time: new Date().toISOString() },
  });
}

/** This is a single-user deployment — alerts go to the primary account. */
async function notifyOwner(payload: Parameters<typeof notify>[1]): Promise<void> {
  const owner = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (owner) void notify(owner.id, payload).catch(() => undefined);
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, email, password } = req.body;
    // acceptTerms is schema-enforced (must be true) — record the acceptance

    // Lock down registration after first user is created
    const userCount = await prisma.user.count();
    if (userCount > 0) throw new AppError('Registration is disabled', 403);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError('Email already in use', 409);

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { id: uuidv4(), name, email, passwordHash, termsAcceptedAt: new Date() },
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

    // Hard "3 strikes" lock — blocks the IP before password checking
    const lock = isLoginLocked(req.ip);
    if (lock.locked) {
      const mins = Math.ceil(lock.secondsLeft / 60);
      await logAudit(null, 'LOGIN_IP_LOCKED', 'user', { ip: req.ip, secondsLeft: lock.secondsLeft }, req.ip, req.headers['user-agent']);
      res.status(429).json({ success: false, message: `Too many failed attempts — this address is locked for ${mins} more minute${mins > 1 ? 's' : ''}.` });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      await logAudit(null, 'LOGIN_FAILED', 'user', { email, reason: 'unknown or inactive user' }, req.ip, req.headers['user-agent']);
      maybeLockout(req.ip);
      throw new AppError('Invalid credentials', 401);
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      await logAudit(null, 'LOGIN_FAILED', 'user', { email, reason: 'wrong password' }, req.ip, req.headers['user-agent']);
      maybeLockout(req.ip);
      void notify(user.id, {
        event: 'LOGIN_FAILED',
        title: '🚨 Failed Login Attempt',
        message: `Wrong password for ${user.email} from ${req.ip ?? 'unknown IP'}`,
        details: { Account: user.email, IP: req.ip ?? 'unknown', Time: new Date().toISOString() },
      }).catch(() => undefined);
      throw new AppError('Invalid credentials', 401);
    }

    clearLoginFailures(req.ip);

    const lockMs = loginLockRemaining(user);
    if (lockMs > 0) {
      await logAudit(user.id, 'LOGIN_BLOCKED_LOCKDOWN', 'user', { email: user.email, msRemaining: lockMs }, req.ip, req.headers['user-agent']);
      res.status(423).json({ success: false, message: lockMessage(lockMs) });
      return;
    }

    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });
    await saveRefreshToken(user.id, refreshToken, req.ip, req.headers['user-agent']);

    await logAudit(user.id, 'LOGIN', 'user', { email: user.email }, req.ip, req.headers['user-agent']);
    sendLoginAlert(user.id, 'LOGIN', user.email, req.ip, req.headers['user-agent']);

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
        data: { id: uuidv4(), token: newRefreshToken, userId: payload.userId, expiresAt, ipAddress: req.ip, userAgent: req.headers['user-agent'] },
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
    let userId: string | null = null;
    if (token) {
      try {
        userId = verifyRefreshToken(token).userId;
      } catch {
        /* expired or invalid token — still a logout, just unattributable */
      }
      await revokeRefreshToken(token);
    }
    await logAudit(userId, 'LOGOUT', 'user', {}, req.ip, req.headers['user-agent']);
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
    // Security cool-down: block re-login for N hours after a password change
    // (default 2, PASSWORD_CHANGE_LOCKDOWN_HOURS=0 disables) so an attacker who
    // manages to change the password cannot immediately sign back in.
    const lockdownHours = Math.max(0, parseFloat(process.env.PASSWORD_CHANGE_LOCKDOWN_HOURS ?? '2') || 0);
    const loginLockedUntil = lockdownHours > 0 ? new Date(Date.now() + lockdownHours * 60 * 60 * 1000) : null;
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash, loginLockedUntil } });
    await revokeAllUserTokens(user.id);

    await logAudit(user.id, 'PASSWORD_CHANGE', 'user', { email: user.email, sessionsRevoked: true, loginLockedUntil }, req.ip, req.headers['user-agent']);

    const lockMsg = lockdownHours > 0 ? ` For security, sign-in is locked for ${lockdownHours} hour(s).` : '';
    res.json({ success: true, message: `Password changed successfully.${lockMsg}` });
  } catch (err) {
    next(err);
  }
}

/** Very small user-agent parser — enough to name the browser/OS per session. */
function parseUserAgent(ua?: string | null): { browser: string; os: string } {
  const s = ua ?? '';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\//.test(s) ? 'Opera'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari'
    : 'Unknown browser';
  const os = /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad/.test(s) ? 'iOS'
    : /Linux/.test(s) ? 'Linux'
    : 'Unknown OS';
  return { browser, os };
}

export async function getSessions(req: Request & { user?: { userId: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const tokens = await prisma.refreshToken.findMany({
      where: { userId: req.user!.userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, expiresAt: true, ipAddress: true, userAgent: true },
    });

    const sessions = tokens.map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      ipAddress: t.ipAddress,
      userAgent: t.userAgent,
      ...parseUserAgent(t.userAgent),
    }));

    res.json({ success: true, data: { sessions, count: sessions.length } });
  } catch (err) {
    next(err);
  }
}

export async function revokeSession(req: Request & { user?: { userId: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const deleted = await prisma.refreshToken.deleteMany({ where: { id, userId: req.user!.userId } });
    if (deleted.count === 0) {
      res.status(404).json({ success: false, message: 'Session not found' });
      return;
    }
    await logAudit(req.user!.userId, 'SESSION_REVOKE', 'user', { sessionId: id }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
}

export async function revokeAllSessions(req: Request & { user?: { userId: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const deleted = await prisma.refreshToken.deleteMany({ where: { userId: req.user!.userId } });
    await logAudit(req.user!.userId, 'SESSIONS_REVOKE_ALL', 'user', { count: deleted.count }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: `Revoked ${deleted.count} session(s). You will need to log in again.` });
  } catch (err) {
    next(err);
  }
}

// ─── Passkeys (WebAuthn) ─────────────────────────────────────────────────────

import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  getWebAuthnEnv,
  createRegistrationChallenge,
  verifyRegistration,
  createAuthenticationChallenge,
  verifyAuthentication,
  listPasskeys,
  deletePasskey,
} from '../services/passkey.service';

export async function passkeyRegisterOptions(req: Request & { user?: { userId: string; email: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await prisma.passkeyCredential.findMany({
      where: { userId: req.user!.userId },
      select: { credentialId: true },
    });
    const options = await createRegistrationChallenge(req.user!.userId, req.user!.email, existing.map((c) => c.credentialId), getWebAuthnEnv(req));
    res.json({ success: true, data: { options: JSON.parse(options) } });
  } catch (err) {
    next(err);
  }
}

export async function passkeyRegisterVerify(req: Request & { user?: { userId: string; email: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const { response, name } = req.body as { response: RegistrationResponseJSON; name?: string };
    const env = getWebAuthnEnv(req);
    const result = await verifyRegistration(req.user!.userId, response, env, name ?? 'Passkey');
    if (!result.ok) {
      await logAudit(req.user!.userId, 'PASSKEY_REGISTER_FAILED', 'user', { error: result.error }, req.ip, req.headers['user-agent']);
      res.status(400).json({ success: false, message: result.error });
      return;
    }
    await logAudit(req.user!.userId, 'PASSKEY_REGISTERED', 'user', { name: name ?? 'Passkey', credentialId: result.id }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: 'Passkey registered' });
  } catch (err) {
    next(err);
  }
}

export async function passkeyList(req: Request & { user?: { userId: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const passkeys = await listPasskeys(req.user!.userId);
    res.json({ success: true, data: { passkeys } });
  } catch (err) {
    next(err);
  }
}

export async function passkeyDelete(req: Request & { user?: { userId: string } }, res: Response, next: NextFunction): Promise<void> {
  try {
    const removed = await deletePasskey(req.user!.userId, req.params.id);
    if (!removed) {
      res.status(404).json({ success: false, message: 'Passkey not found' });
      return;
    }
    await logAudit(req.user!.userId, 'PASSKEY_REMOVED', 'user', { passkeyId: req.params.id }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: 'Passkey removed' });
  } catch (err) {
    next(err);
  }
}

export async function passkeyLoginOptions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const env = getWebAuthnEnv(req);
    const options = await createAuthenticationChallenge(env);
    res.json({ success: true, data: { options: JSON.parse(options) } });
  } catch (err) {
    next(err);
  }
}

export async function passkeyLoginVerify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { response } = req.body as { response: AuthenticationResponseJSON };
    const env = getWebAuthnEnv(req);
    const result = await verifyAuthentication(response, env);
    if (!result.ok) {
      await logAudit(null, 'PASSKEY_LOGIN_FAILED', 'user', { error: result.error }, req.ip, req.headers['user-agent']);
      res.status(401).json({ success: false, message: result.error });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: result.userId } });
    if (!user) {
      res.status(401).json({ success: false, message: 'User not found' });
      return;
    }

    clearLoginFailures(req.ip);

    const lockMs = loginLockRemaining(user);
    if (lockMs > 0) {
      await logAudit(user.id, 'LOGIN_BLOCKED_LOCKDOWN', 'user', { email: user.email, msRemaining: lockMs, method: 'passkey' }, req.ip, req.headers['user-agent']);
      res.status(423).json({ success: false, message: lockMessage(lockMs) });
      return;
    }

    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });
    await saveRefreshToken(user.id, refreshToken, req.ip, req.headers['user-agent']);

    await logAudit(user.id, 'PASSKEY_LOGIN', 'user', { email: user.email }, req.ip, req.headers['user-agent']);
    sendLoginAlert(user.id, 'PASSKEY_LOGIN', user.email, req.ip, req.headers['user-agent']);

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
