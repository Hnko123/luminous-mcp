import { randomUUID } from "node:crypto";

import {
  SignJWT,
  jwtVerify,
  type JWTPayload,
} from "jose";

import type { Env, McpActor } from "./types";

const encoder = new TextEncoder();

export const ORIGIN_ASSERTION_ISSUER = "luminous-mcp-worker";
export const ORIGIN_ASSERTION_AUDIENCE = "luminous-mcp-origin";
export const ORIGIN_ASSERTION_TTL_SECONDS = 60;

export interface JwtPolicy {
  issuer: string;
  audience: string;
  maxAgeSeconds: number;
  now?: Date;
}

export interface JwtSignPolicy {
  issuer: string;
  audience: string;
  expiresInSeconds: number;
  now?: Date;
}

export class JwtValidationError extends Error {
  readonly code = "JWT_INVALID";

  constructor() {
    super("JWT validation failed");
    this.name = "JwtValidationError";
  }
}

function secretKey(secret: string): Uint8Array {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new JwtValidationError();
  }
  return encoder.encode(secret);
}

function validPolicy(policy: JwtPolicy | JwtSignPolicy): boolean {
  return Boolean(
    policy.issuer
    && policy.audience
    && Number.isSafeInteger(
      "maxAgeSeconds" in policy ? policy.maxAgeSeconds : policy.expiresInSeconds,
    )
    && ("maxAgeSeconds" in policy ? policy.maxAgeSeconds : policy.expiresInSeconds) > 0,
  );
}
export async function signJwt(
  payload: JWTPayload,
  secret: string,
  policy: JwtSignPolicy,
): Promise<string> {
  if (!validPolicy(policy)) throw new JwtValidationError();
  const issuedAt = Math.floor((policy.now ?? new Date()).getTime() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(policy.issuer)
    .setAudience(policy.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + policy.expiresInSeconds)
    .setJti(randomUUID())
    .sign(secretKey(secret));
}

export async function verifyJwt(
  token: string,
  secret: string,
  policy: JwtPolicy,
): Promise<JWTPayload> {
  if (!validPolicy(policy)) throw new JwtValidationError();
  try {
    const { payload, protectedHeader } = await jwtVerify(token, secretKey(secret), {
      algorithms: ["HS256"],
      issuer: policy.issuer,
      audience: policy.audience,
      currentDate: policy.now,
      maxTokenAge: `${policy.maxAgeSeconds}s`,
    });
    const lifetime = Number(payload.exp) - Number(payload.iat);
    if (
      protectedHeader.alg !== "HS256"
      || typeof payload.jti !== "string"
      || payload.jti.length === 0
      || !Number.isFinite(lifetime)
      || lifetime <= 0
      || lifetime > policy.maxAgeSeconds
    ) {
      throw new JwtValidationError();
    }
    return payload;
  } catch {
    throw new JwtValidationError();
  }
}

export async function createOriginAssertion(
  env: Pick<Env, "MCP_ORIGIN_ASSERTION_SECRET">,
  actor: McpActor,
  options: { now?: Date } = {},
): Promise<string> {
  const scopes = [...actor.scopes].map(String).sort();
  if (
    !/^[1-9]\d*$/.test(actor.userId)
    || !actor.email
    || !actor.connectionId
    || !actor.clientId
    || scopes.length === 0
  ) {
    throw new JwtValidationError();
  }
  return signJwt(
    {
      sub: actor.userId,
      email: actor.email.trim().toLowerCase(),
      connection_id: actor.connectionId,
      client_id: actor.clientId,
      scope: scopes.join(" "),
    },
    env.MCP_ORIGIN_ASSERTION_SECRET,
    {
      issuer: ORIGIN_ASSERTION_ISSUER,
      audience: ORIGIN_ASSERTION_AUDIENCE,
      expiresInSeconds: ORIGIN_ASSERTION_TTL_SECONDS,
      now: options.now,
    },
  );
}
