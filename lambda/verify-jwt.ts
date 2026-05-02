import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface BrokerJwtClaims extends JWTPayload {
  jti: string;
  exp: number;
  workspaceId?: string;
  jobId?: string;
  jobType?: string;
  bh?: string;
  aud?: string | string[];
}

interface VerifyOpts {
  jwksUrl: string;
  expectedAud: string;
  rawBody: string;
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksUrl: string | undefined;

function getJwks(jwksUrl: string) {
  if (!cachedJwks || cachedJwksUrl !== jwksUrl) {
    cachedJwks = createRemoteJWKSet(new URL(jwksUrl), {
      // jose's default 30 s cooldown is fine; cache lives for the warm
      // Lambda's lifetime (which is itself bounded).
      cooldownDuration: 30_000,
    });
    cachedJwksUrl = jwksUrl;
  }

  return cachedJwks;
}

/**
 * Verify a hereya-cloud-issued broker JWT. Throws an `Error` whose message
 * starts with `jwt:` on any failure, so the handler can map to 401.
 */
export async function verifyBrokerJwt(
  token: string,
  opts: VerifyOpts
): Promise<BrokerJwtClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getJwks(opts.jwksUrl), {
      audience: opts.expectedAud,
    });
    payload = result.payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`jwt: signature/verification failed (${message})`);
  }

  if (typeof payload.jti !== "string") {
    throw new Error("jwt: missing jti");
  }

  if (typeof payload.exp !== "number") {
    throw new Error("jwt: missing exp");
  }

  // Body-hash binding — protects against the JWT being lifted off one webhook
  // and replayed against a different body (the AWS_IAM SigV4 layer normally
  // catches this too, but defense in depth).
  const bh = (payload as { bh?: string }).bh;
  if (typeof bh !== "string") {
    throw new Error("jwt: missing bh");
  }

  const expectedBh = sha256Hex(opts.rawBody);
  if (bh !== expectedBh) {
    throw new Error("jwt: body hash mismatch");
  }

  return payload as BrokerJwtClaims;
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
