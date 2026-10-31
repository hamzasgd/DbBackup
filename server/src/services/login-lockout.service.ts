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

/**
 * Cross-IP brute-force detection: IP-hopping attackers defeat the per-IP
 * lock, so failures are ALSO counted per targeted account across all IPs.
 * Crossing the threshold from 2+ distinct IPs raises one consolidated
 * alert (visibility, not an account lock — a lock would let the attacker
 * grief-lock the owner).
 */
const ACCT_WINDOW_MS = 15 * 60 * 1000;
const ACCT_THRESHOLD = Math.max(2, parseInt(process.env.LOGIN_CROSS_IP_ALERT_THRESHOLD ?? '10', 10) || 10);

interface AcctState { windowStart: number; count: number; ips: Set<string>; lastAlertAt: number }
const acctState = new Map<string, AcctState>();

/** Record a failed attempt against a known account. True when the cross-IP threshold just tripped. */
export function recordAccountFailure(email: string, ip: string | undefined): boolean {
  const now = Date.now();
  let s = acctState.get(email);
  if (!s || now - s.windowStart > ACCT_WINDOW_MS) {
    s = { windowStart: now, count: 0, ips: new Set(), lastAlertAt: 0 };
    acctState.set(email, s);
  }
  s.count += 1;
  if (ip) s.ips.add(ip);

  if (s.count >= ACCT_THRESHOLD && s.ips.size >= 2 && now - s.lastAlertAt > ACCT_WINDOW_MS) {
    // trip once per window — reset so the next wave alerts again
    acctState.set(email, { windowStart: now, count: 0, ips: new Set(), lastAlertAt: now });
    return true;
  }
  return false;
}

/**
 * Throttle for per-attempt failure emails: during a distributed attack
 * every wrong password would otherwise send an email. One per 5 minutes.
 */
const FAILURE_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;
const lastFailureNotify = new Map<string, number>();

export function shouldNotifyFailure(email: string): boolean {
  const last = lastFailureNotify.get(email) ?? 0;
  if (Date.now() - last < FAILURE_NOTIFY_INTERVAL_MS) return false;
  lastFailureNotify.set(email, Date.now());
  return true;
}
