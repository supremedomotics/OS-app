/**
 * Password policy + strength/compromised checks (§ Authentication — password policies).
 *
 * Fully offline (no external "have I been pwned" call): a built-in blocklist rejects the most common
 * / trivially-guessable passwords, and a simple structural score drives a strength meter. The policy
 * is injectable so an OEM can tighten it; the default keeps the historical 8-char minimum (so it
 * doesn't invalidate existing credentials) while still blocking obviously-weak choices.
 */
export interface PasswordPolicy {
  minLength: number;
  requireLetter: boolean;
  requireNumber: boolean;
  /** Reject passwords on the common/compromised blocklist. */
  blockCommon: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireLetter: false,
  requireNumber: false,
  blockCommon: true,
};

/** Top common/compromised passwords (offline "compromised password detection", basic tier). */
const COMMON = new Set([
  "password", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop",
  "password1", "password123", "letmein1", "iloveyou1", "admin1234", "welcome1",
  "1q2w3e4r", "1qaz2wsx", "12341234", "changeme1", "supreme123", "abc12345",
  "11111111", "00000000", "trustno1", "sunshine1", "football1", "baseball1",
]);

export interface PasswordCheck {
  ok: boolean;
  /** Strength 0 (weak) … 4 (strong). */
  score: number;
  reason?: string;
}

/** Structural strength score 0..4 — length + character-class variety. */
export function passwordStrength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

/** Validate a candidate password against the policy; returns ok + a strength score (+reason if not). */
export function checkPassword(pw: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): PasswordCheck {
  if (pw.length < policy.minLength) {
    return { ok: false, score: passwordStrength(pw), reason: `Password must be at least ${policy.minLength} characters` };
  }
  if (policy.requireLetter && !/[a-zA-Z]/.test(pw)) {
    return { ok: false, score: passwordStrength(pw), reason: "Password must include a letter" };
  }
  if (policy.requireNumber && !/[0-9]/.test(pw)) {
    return { ok: false, score: passwordStrength(pw), reason: "Password must include a number" };
  }
  if (policy.blockCommon && COMMON.has(pw.toLowerCase())) {
    return { ok: false, score: 0, reason: "This password is too common — choose a less predictable one" };
  }
  return { ok: true, score: passwordStrength(pw) };
}
