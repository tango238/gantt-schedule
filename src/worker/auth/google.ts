import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string }): string {
  const u = new URL(AUTH_ENDPOINT);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: "openid email profile",
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return u.toString();
}

export interface GoogleIdentity {
  email: string;
  name: string;
  picture: string | null;
  /** Workspace のホストドメイン。無ければ null */
  hd: string | null;
}

export class IdTokenError extends Error {}

export async function exchangeCode(p: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
      grant_type: "authorization_code",
    }),
  });
  } catch {
    throw new IdTokenError("token endpoint unreachable");
  }
  if (!res.ok) throw new IdTokenError(`token endpoint returned ${res.status}`);
  let body: { id_token?: unknown };
  try {
    body = (await res.json()) as { id_token?: unknown };
  } catch {
    throw new IdTokenError("token endpoint returned invalid JSON");
  }
  if (typeof body?.id_token !== "string") throw new IdTokenError("no id_token");
  return body.id_token;
}

/** 署名 (Google JWKS)・iss・aud・exp・nonce・email_verified を検証して身元を返す。 */
export async function verifyIdToken(idToken: string, p: { clientId: string; nonce: string }): Promise<GoogleIdentity> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: ISSUERS,
      audience: p.clientId,
      algorithms: ["RS256"],
    }));
  } catch (e) {
    throw new IdTokenError(`id_token verification failed: ${(e as Error).message}`);
  }
  if (payload.nonce !== p.nonce) throw new IdTokenError("nonce mismatch");
  if (payload.email_verified !== true) throw new IdTokenError("email not verified");
  if (typeof payload.email !== "string" || payload.email === "") throw new IdTokenError("no email");
  const email = payload.email.toLowerCase();
  return {
    email,
    name: typeof payload.name === "string" && payload.name ? payload.name : email,
    picture: typeof payload.picture === "string" ? payload.picture : null,
    hd: typeof payload.hd === "string" ? payload.hd : null,
  };
}
