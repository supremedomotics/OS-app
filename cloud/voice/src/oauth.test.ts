import { describe, expect, it } from "vitest";
import { OAuthError, OAuthProvider, type LinkIdentity } from "./oauth.js";

/**
 * OAuth2 account-linking IdP: the handshake Alexa/Google run to bind to a Supreme account. Proves
 * client/redirect validation, single-use codes, code→token exchange, refresh, revoke, and that
 * tokens are tamper-evident.
 */
function makeProvider(now = () => 1_000_000) {
  return new OAuthProvider({
    signingSecret: "test-secret",
    now,
    clients: [
      { clientId: "alexa-client", clientSecret: "alexa-secret", assistant: "alexa", redirectUris: ["https://layla.amazon.com/cb"] },
      { clientId: "google-client", clientSecret: "google-secret", assistant: "google", redirectUris: ["https://oauth-redirect.googleusercontent.com/cb"] },
    ],
  });
}
const identity: LinkIdentity = { accountId: "acct-1", homeId: "home-1", hubToken: "hub-token-xyz" };

describe("OAuth2 account linking", () => {
  it("validates the authorize request (client + redirect_uri + response_type)", () => {
    const p = makeProvider();
    expect(p.validateAuthorization({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", responseType: "code" }).assistant).toBe("alexa");
    expect(() => p.validateAuthorization({ clientId: "nope", redirectUri: "https://layla.amazon.com/cb", responseType: "code" })).toThrow(OAuthError);
    expect(() => p.validateAuthorization({ clientId: "alexa-client", redirectUri: "https://evil.example/cb", responseType: "code" })).toThrow(/redirect_uri/);
    expect(() => p.validateAuthorization({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", responseType: "token" })).toThrow(/response_type/);
  });

  it("runs the full code→token→resolve flow", () => {
    const p = makeProvider();
    const code = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    const tokens = p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/cb", clientId: "alexa-client", clientSecret: "alexa-secret" });
    expect(tokens.token_type).toBe("bearer");
    const link = p.resolve(tokens.access_token);
    expect(link?.homeId).toBe("home-1");
    expect(link?.hubToken).toBe("hub-token-xyz");
    expect(link?.assistant).toBe("alexa");
  });

  it("rejects a bad client secret", () => {
    const p = makeProvider();
    const code = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    expect(() => p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/cb", clientId: "alexa-client", clientSecret: "WRONG" })).toThrow(/client authentication/);
  });

  it("makes authorization codes single-use", () => {
    const p = makeProvider();
    const code = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/cb", clientId: "alexa-client", clientSecret: "alexa-secret" });
    expect(() => p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/cb", clientId: "alexa-client", clientSecret: "alexa-secret" })).toThrow(/used authorization code/);
  });

  it("rejects a code redeemed with a mismatched redirect_uri or different client", () => {
    const p = makeProvider();
    const code = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    expect(() => p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/other", clientId: "alexa-client", clientSecret: "alexa-secret" })).toThrow(/redirect_uri mismatch/);
    const code2 = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    expect(() => p.exchange({ grantType: "authorization_code", code: code2, redirectUri: "https://oauth-redirect.googleusercontent.com/cb", clientId: "google-client", clientSecret: "google-secret" })).toThrow();
  });

  it("refreshes an access token and keeps the same link", () => {
    const p = makeProvider();
    const code = p.issueCode({ clientId: "google-client", redirectUri: "https://oauth-redirect.googleusercontent.com/cb", identity });
    const t1 = p.exchange({ grantType: "authorization_code", code, redirectUri: "https://oauth-redirect.googleusercontent.com/cb", clientId: "google-client", clientSecret: "google-secret" });
    const t2 = p.exchange({ grantType: "refresh_token", refreshToken: t1.refresh_token, clientId: "google-client", clientSecret: "google-secret" });
    expect(p.resolve(t2.access_token)?.homeId).toBe("home-1");
  });

  it("revokes a link so the access token stops resolving", () => {
    const p = makeProvider();
    const code = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    const tokens = p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/cb", clientId: "alexa-client", clientSecret: "alexa-secret" });
    expect(p.resolve(tokens.access_token)).toBeDefined();
    expect(p.revoke(tokens.access_token)).toBe(true);
    expect(p.resolve(tokens.access_token)).toBeUndefined();
  });

  it("rejects tampered and expired tokens", () => {
    let t = 1_000_000;
    const p = makeProvider(() => t);
    const code = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    const tokens = p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/cb", clientId: "alexa-client", clientSecret: "alexa-secret" });
    // Tamper with the payload — signature no longer matches.
    const [body] = tokens.access_token.split(".");
    expect(p.resolve(`${body}.deadbeef`)).toBeUndefined();
    // Expire it (default access TTL is 1h).
    t += 2 * 60 * 60 * 1000;
    expect(p.resolve(tokens.access_token)).toBeUndefined();
  });

  it("expires authorization codes", () => {
    let t = 1_000_000;
    const p = makeProvider(() => t);
    const code = p.issueCode({ clientId: "alexa-client", redirectUri: "https://layla.amazon.com/cb", identity });
    t += 11 * 60 * 1000; // default code TTL is 10 min
    expect(() => p.exchange({ grantType: "authorization_code", code, redirectUri: "https://layla.amazon.com/cb", clientId: "alexa-client", clientSecret: "alexa-secret" })).toThrow(/expired/);
  });
});
