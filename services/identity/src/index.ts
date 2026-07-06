/**
 * @supreme/identity — Supreme-branded authentication & session service (§8, §12).
 * No Home Assistant login is ever exposed; this is the only identity in the system.
 */
export { IdentityService, type IdentityServiceOptions } from "./identity-service.js";
export { TokenService, type SupremeClaims, type TokenServiceOptions } from "./tokens.js";
export { generateTotpSecret, otpauthUrl, totpAt, verifyTotp } from "./totp.js";
export {
  checkPassword,
  passwordStrength,
  DEFAULT_PASSWORD_POLICY,
  type PasswordPolicy,
  type PasswordCheck,
} from "./password-policy.js";
export {
  InMemoryIdentityStore,
  InMemorySessionStore,
  InMemoryApiTokenStore,
  type IIdentityStore,
  type ISessionStore,
  type IApiTokenStore,
  type ApiTokenRecord,
  type ApiTokenRecordMeta,
  type Session,
  type StoredCredential,
} from "./store.js";
