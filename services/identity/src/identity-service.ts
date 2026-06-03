import { hash, verify } from "@node-rs/argon2";
import {
  newId,
  type Home,
  type HomeId,
  type User,
  type UserId,
  type UserType,
} from "@supreme/domain-model";
import { SupremeError, type LoginResponse, type TokenPair } from "@supreme/contracts";
import { InMemoryIdentityStore, type IIdentityStore } from "./store.js";
import { TokenService } from "./tokens.js";

/**
 * Supreme identity service (§8, §12).
 *
 * Owns the Supreme user model — HA users do NOT exist here. The first
 * commissioning user becomes the Master User. Passwords use Argon2id; login can
 * require TOTP MFA before tokens are issued. All of this runs on the hub and
 * validates offline.
 */
export interface IdentityServiceOptions {
  tokenSecret: string;
  store?: IIdentityStore;
}

// OWASP-recommended Argon2id parameters.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export class IdentityService {
  private readonly store: IIdentityStore;
  readonly tokens: TokenService;

  constructor(opts: IdentityServiceOptions) {
    this.store = opts.store ?? new InMemoryIdentityStore();
    this.tokens = new TokenService({ secret: opts.tokenSecret });
  }

  /**
   * Commission the home: creates the home and its Master User. Idempotent-guarded —
   * a second call throws so commissioning can only happen once.
   */
  async commission(input: {
    homeName: string;
    email: string;
    password: string;
    displayName: string;
  }): Promise<{ home: Home; master: User }> {
    if (await this.store.getHome()) {
      throw new SupremeError("conflict", "home is already commissioned");
    }
    const homeId = newId("home") as HomeId;
    const userId = newId("user") as UserId;
    const now = new Date().toISOString();

    const master: User = {
      id: userId,
      homeId,
      email: input.email,
      phone: null,
      displayName: input.displayName,
      userType: "master",
      status: "active",
      createdAt: now,
      expiresAt: null,
    };
    const home: Home = {
      id: homeId,
      name: input.homeName,
      address: null,
      tier: "signature",
      masterUserId: userId,
      createdAt: now,
    };

    await this.store.putHome(home);
    await this.store.putUser(master);
    await this.store.putCredential({
      userId,
      passwordHash: await hash(input.password, ARGON2),
      mfaSecret: null,
    });
    return { home, master };
  }

  /** Add a user (family/guest/staff/installer/…). Caller enforces authorization. */
  async createUser(input: {
    email: string;
    password: string;
    displayName: string;
    userType: UserType;
    expiresAt?: string | null;
  }): Promise<User> {
    const home = await this.requireHome();
    if (await this.store.findUserByEmail(input.email)) {
      throw new SupremeError("conflict", "a user with that email already exists");
    }
    const user: User = {
      id: newId("user") as UserId,
      homeId: home.id,
      email: input.email,
      phone: null,
      displayName: input.displayName,
      userType: input.userType,
      status: "active",
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
    };
    await this.store.putUser(user);
    await this.store.putCredential({
      userId: user.id,
      passwordHash: await hash(input.password, ARGON2),
      mfaSecret: null,
    });
    return user;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.store.findUserByEmail(email);
    const cred = user ? await this.store.getCredential(user.id) : null;

    // Always run a verification to keep timing uniform whether or not the user exists.
    const ok = cred ? await verify(cred.passwordHash, password).catch(() => false) : await dummyVerify(password);
    if (!user || !cred || !ok) {
      throw new SupremeError("unauthorized", "invalid email or password");
    }
    if (user.status !== "active") {
      throw new SupremeError("forbidden", `account is ${user.status}`);
    }

    const base = { sub: user.id, homeId: user.homeId, userType: user.userType };
    if (cred.mfaSecret) {
      return { status: "mfa_required", mfaToken: await this.tokens.issueMfa(base) };
    }
    return { status: "ok", ...(await this.issueTokens(user)) };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const claims = await this.tokens.verify(refreshToken, "refresh");
    const user = await this.store.getUser(claims.sub);
    if (!user || user.status !== "active") {
      throw new SupremeError("unauthorized", "session is no longer valid");
    }
    return this.issueTokens(user);
  }

  /** Verify an access token and return the live user. Used by the gateway authn. */
  async authenticate(accessToken: string): Promise<User> {
    const claims = await this.tokens.verify(accessToken, "access");
    const user = await this.store.getUser(claims.sub);
    if (!user || user.status !== "active") {
      throw new SupremeError("unauthorized", "session is no longer valid");
    }
    return user;
  }

  listUsers(): Promise<User[]> {
    return this.store.listUsers();
  }

  private async issueTokens(user: User): Promise<TokenPair> {
    const base = { sub: user.id, homeId: user.homeId, userType: user.userType };
    return {
      accessToken: await this.tokens.issueAccess(base),
      refreshToken: await this.tokens.issueRefresh(base),
      expiresIn: this.tokens.accessTtl,
      tokenType: "Bearer",
    };
  }

  private async requireHome(): Promise<Home> {
    const home = await this.store.getHome();
    if (!home) throw new SupremeError("conflict", "home is not commissioned yet");
    return home;
  }
}

// A fixed-cost hash to equalize timing for unknown emails (anti-enumeration).
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zYWx0LXZhbHVl$3hAOFZ8gQ0z0r0o3o1mYg2hF0p1JxqZ2";
async function dummyVerify(password: string): Promise<boolean> {
  try {
    await verify(DUMMY_HASH, password);
  } catch {
    /* expected */
  }
  return false;
}
