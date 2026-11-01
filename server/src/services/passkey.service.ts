import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { prisma } from '../config/database';

/**
 * Passkey (WebAuthn) login support.
 * Relying-party config derives from the request host (behind the aaPanel
 * nginx proxy) unless overridden via env:
 *   PASSKEY_RP_ID       e.g. dbbackup.hamza.codes
 *   PASSKEY_EXTRA_ORIGINS  comma list, e.g. http://localhost:5173
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Registration challenges keyed by userId
const regChallenges = new Map<string, { challenge: string; expiresAt: number }>();
// Login challenges keyed by the challenge itself (usernameless flow)
const authChallenges = new Map<string, number>();

function sweepChallenges() {
  const now = Date.now();
  for (const [k, v] of regChallenges) if (v.expiresAt < now) regChallenges.delete(k);
  for (const [k, v] of authChallenges) if (v < now) authChallenges.delete(k);
}

export interface WebAuthnEnv {
  rpID: string;
  rpName: string;
  origins: string[];
}

export function getWebAuthnEnv(req: { headers: Record<string, string | string[] | undefined> }): WebAuthnEnv {
  const forwardedHost = Array.isArray(req.headers['x-forwarded-host']) ? req.headers['x-forwarded-host'][0] : req.headers['x-forwarded-host'];
  const host = (forwardedHost as string) || (req.headers['host'] as string) || 'localhost';
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto']) ? req.headers['x-forwarded-proto'][0] : req.headers['x-forwarded-proto'];
  const proto = (forwardedProto as string) || (host.includes('localhost') ? 'http' : 'https');

  const rpID = process.env.PASSKEY_RP_ID || host.split(':')[0];
  const origins = new Set<string>([`${proto}://${host}`]);
  // An explicit RP ID implies its https origin — covers reverse proxies that
  // don't forward Host/X-Forwarded-Proto correctly (host resolves to localhost).
  if (process.env.PASSKEY_RP_ID) origins.add(`https://${process.env.PASSKEY_RP_ID}`);
  for (const o of (process.env.PASSKEY_EXTRA_ORIGINS ?? '').split(',')) {
    if (o.trim()) origins.add(o.trim());
  }
  return { rpID, rpName: 'DbBackup', origins: [...origins] };
}

export async function createRegistrationChallenge(
  userId: string,
  email: string,
  existingCredentialIds: string[],
  env: WebAuthnEnv,
): Promise<string /* options JSON for the browser */> {
  sweepChallenges();
  const options = await generateRegistrationOptions({
    rpName: env.rpName,
    rpID: env.rpID,
    userName: email,
    // Don't re-register credentials that already exist
    excludeCredentials: existingCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: 'required', // discoverable — enables usernameless login
      userVerification: 'preferred',
    },
  });
  regChallenges.set(userId, { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return JSON.stringify(options);
}

export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  env: WebAuthnEnv,
  name: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const stored = regChallenges.get(userId);
  if (!stored || stored.expiresAt < Date.now()) return { ok: false, error: 'Challenge expired — try again' };
  regChallenges.delete(userId);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin: env.origins,
    expectedRPID: env.rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'Registration could not be verified' };
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await prisma.passkeyCredential.create({
    data: {
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: name || 'Passkey',
    },
  });
  return { ok: true, id: credential.id };
}

export async function createAuthenticationChallenge(env: WebAuthnEnv): Promise<string> {
  sweepChallenges();
  const options = await generateAuthenticationOptions({
    rpID: env.rpID,
    // Usernameless: empty allowCredentials → browser offers all discoverable passkeys for this RP
    allowCredentials: [],
  });
  authChallenges.set(options.challenge, Date.now() + CHALLENGE_TTL_MS);
  return JSON.stringify(options);
}

/** Extract the challenge from the assertion's clientDataJSON (v13 no longer surfaces it directly). */
function challengeFromAssertion(response: AuthenticationResponseJSON): string {
  const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge: string };
  return clientData.challenge;
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  env: WebAuthnEnv,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const challenge = challengeFromAssertion(response);
  const expected = authChallenges.get(challenge);
  if (!expected || expected < Date.now()) return { ok: false, error: 'Challenge expired — try again' };
  authChallenges.delete(challenge);

  const cred = await prisma.passkeyCredential.findUnique({
    where: { credentialId: response.id },
    include: { user: { select: { id: true, isActive: true } } },
  });
  if (!cred || !cred.user.isActive) return { ok: false, error: 'Unknown passkey' };

  const transports = cred.transports ? (JSON.parse(cred.transports) as string[]) : undefined;
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: env.origins,
    expectedRPID: env.rpID,
    credential: {
      id: cred.credentialId,
      publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
      counter: cred.counter,
      transports,
    },
    requireUserVerification: false,
  });
  if (!verification.verified) return { ok: false, error: 'Passkey verification failed' };

  await prisma.passkeyCredential.update({
    where: { id: cred.id },
    data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() },
  });
  return { ok: true, userId: cred.user.id };
}

export async function listPasskeys(userId: string) {
  return prisma.passkeyCredential.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, deviceType: true, backedUp: true,
      createdAt: true, lastUsedAt: true,
    },
  });
}

export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  const deleted = await prisma.passkeyCredential.deleteMany({ where: { id, userId } });
  return deleted.count > 0;
}
