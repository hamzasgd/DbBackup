/**
 * IP-based login lockout: after N failed password attempts from one IP,
 * that IP is blocked from signing in for a window. Complements the
 * express-rate-limit on /api/auth (which caps volume) with a hard
 * "3 strikes" rule, and fires an email/Slack alert when tripped.
 *
 * Account-based lockout is deliberately avoided: this is a single-user
 * app, and locking the account would let anyone grief-lock the owner
 * by spamming wrong passwords for a known email.
 *
 * State is in-memory (single PM2 instance); a restart simply clears it.
 */

const ATTEMPTS = Math.max(1, parseInt(process.env.LOGIN_LOCKOUT_ATTEMPTS ?? '3', 10) || 3);
const LOCK_MINUTES = Math.max(1, parseInt(process.env.LOGIN_LOCKOUT_MINUTES ?? '15', 10) || 15);

interface LockState {
  fails: number;
  lockedUntil: number;
}

const state = new Map<string, LockState>();

export function isLoginLocked(ip: string | undefined): { locked: boolean; secondsLeft: number } {
  if (!ip) return { locked: false, secondsLeft: 0 };
  const s = state.get(ip);
  if (!s || s.lockedUntil < Date.now()) return { locked: false, secondsLeft: 0 };
  return { locked: true, secondsLeft: Math.ceil((s.lockedUntil - Date.now()) / 1000) };
}

/**
 * Record a failed attempt. Returns true when THIS call triggered a lockout
 * (used to fire the alert exactly once per lock).
 */
export function recordLoginFailure(ip: string | undefined): boolean {
  if (!ip) return false;
  const s = state.get(ip) ?? { fails: 0, lockedUntil: 0 };
  s.fails += 1;
  if (s.fails >= ATTEMPTS) {
    s.lockedUntil = Date.now() + LOCK_MINUTES * 60 * 1000;
    s.fails = 0; // after the lock expires, start counting fresh
    state.set(ip, s);
    return true;
  }
  state.set(ip, s);
  return false;
}

export function clearLoginFailures(ip: string | undefined): void {
  if (ip) state.delete(ip);
}
