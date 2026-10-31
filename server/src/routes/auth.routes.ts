import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  register, login, refreshToken, logout, getMe, changePassword,
  getSessions, revokeSession, revokeAllSessions,
  passkeyRegisterOptions, passkeyRegisterVerify, passkeyList, passkeyDelete,
  passkeyLoginOptions, passkeyLoginVerify,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { registerSchema, loginSchema, changePasswordSchema, refreshTokenSchema, logoutSchema } from '../middleware/validation.schemas';

const router = Router();

// Strict rate limit for auth endpoints — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later' },
});

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', authLimiter, validate(refreshTokenSchema), refreshToken);
router.post('/logout', validate(logoutSchema), logout);
router.get('/me', authenticate, getMe);
router.put('/change-password', authenticate, validate(changePasswordSchema), changePassword);

// Active sessions (refresh tokens) — view + revoke
router.get('/sessions', authenticate, getSessions);
router.delete('/sessions', authenticate, revokeAllSessions);
router.delete('/sessions/:id', authenticate, revokeSession);

// Passkeys (WebAuthn) — registration/management require auth; login is open
router.post('/passkey/register/options', authenticate, passkeyRegisterOptions);
router.post('/passkey/register/verify', authenticate, passkeyRegisterVerify);
router.get('/passkey/list', authenticate, passkeyList);
router.delete('/passkey/:id', authenticate, passkeyDelete);
router.post('/passkey/login/options', passkeyLoginOptions);
router.post('/passkey/login/verify', passkeyLoginVerify);

export default router;
