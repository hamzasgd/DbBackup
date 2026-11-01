import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { randomUUID as uuidv4 } from 'crypto';
import { prisma } from '../config/database';
import { getKeyManager } from './crypto/key-manager';

/**
 * JWT secrets: explicit env vars (JWT_ACCESS_SECRET / JWT_REFRESH_SECRET) win.
 * When absent, they are DERIVED from the master encryption key (local or the
 * KMS-unwrapped memory-only key) — two fewer plaintext secrets in .env, and in
 * KMS mode the JWT signing material never touches the disk either.
 * Derived lazily so the KMS key can be unwrapped at boot before first use.
 */
function jwtSecret(kind: 'access' | 'refresh'): string {
  const env = kind === 'access' ? process.env.JWT_ACCESS_SECRET : process.env.JWT_REFRESH_SECRET;
  if (env) return env;
  return crypto
    .createHmac('sha256', getKeyManager().getPrimaryKey())
    .update(`dbbackup:jwt:${kind}`)
    .digest('base64url');
}

export interface TokenPayload {
  userId: string;
  email: string;
}

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, jwtSecret('access'), {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  } as jwt.SignOptions);
}

export function generateRefreshToken(payload: TokenPayload): string {
  // jwtid makes every token unique: two logins (or a login and a refresh) in the
  // same second otherwise produced the same token and hit the unique index (HTTP 409)
  return jwt.sign({ userId: payload.userId, email: payload.email }, jwtSecret('refresh'), {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    jwtid: uuidv4(),
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, jwtSecret('access')) as unknown as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, jwtSecret('refresh')) as unknown as TokenPayload;
}

/**
 * Refresh tokens are stored as a SHA-256 hash, like MCP keys: a leaked database
 * dump then contains no usable session. The token is a signed JWT with plenty
 * of entropy, so an unsalted hash is enough.
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Hash refresh tokens stored before hashing was introduced (they are JWTs, so they contain dots). */
export async function upgradeLegacyRefreshTokens(): Promise<number> {
  const legacy = await prisma.refreshToken.findMany({
    where: { token: { contains: '.' } },
    select: { id: true, token: true },
  });
  for (const row of legacy) {
    await prisma.refreshToken.update({ where: { id: row.id }, data: { token: hashRefreshToken(row.token) } });
  }
  return legacy.length;
}

export async function saveRefreshToken(
  userId: string,
  token: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({
    data: { id: uuidv4(), token: hashRefreshToken(token), userId, expiresAt, ipAddress, userAgent },
  });
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { token: hashRefreshToken(token) } });
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}
