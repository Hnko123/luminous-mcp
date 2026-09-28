import { decodeProtectedHeader, decodeJwt } from "jose";
import { describe, expect, test } from "vitest";

import {
  createOriginAssertion,
  signJwt,
  verifyJwt,
} from "../src/jwt";
import type { Env, McpActor } from "../src/types";

const NOW = new Date("2026-09-26T16:00:00.000Z");
const SECRET = "worker-test-secret-that-is-long-enough-for-hs256";

const actor: McpActor = {
  userId: "42",
  email: "user@example.com",
  connectionId: "conn-1",
  clientId: "client-1",
  clientName: "Gemini",
  scopes: new Set(["tasks:create", "tasks:read:self"]),
};

describe("JWT helpers", () => {
  test("signs and verifies only the exact HS256 issuer, audience, and lifetime", async () => {
    const token = await signJwt(
      { sub: "42", purpose: "test" },
      SECRET,
      { issuer: "issuer-a", audience: "audience-a", expiresInSeconds: 60, now: NOW },
    );
    expect(decodeProtectedHeader(token).alg).toBe("HS256");
    const claims = decodeJwt(token);
    expect(claims.iss).toBe("issuer-a");
    expect(claims.aud).toBe("audience-a");
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60);

    const verified = await verifyJwt(token, SECRET, {
      issuer: "issuer-a",
      audience: "audience-a",
      maxAgeSeconds: 60,
      now: NOW,
    });
    expect(verified.sub).toBe("42");
    await expect(verifyJwt(token, SECRET, {
      issuer: "wrong", audience: "audience-a", maxAgeSeconds: 60, now: NOW,
    })).rejects.toMatchObject({ code: "JWT_INVALID" });
  });

  test("origin assertions are exactly sixty seconds and bind the full actor", async () => {
    const token = await createOriginAssertion(
      { MCP_ORIGIN_ASSERTION_SECRET: SECRET } as Env,
      actor,
      { now: NOW },
    );
    const claims = await verifyJwt(token, SECRET, {
      issuer: "luminous-mcp-worker",
      audience: "luminous-mcp-origin",
      maxAgeSeconds: 60,
      now: NOW,
    });
    expect(claims).toMatchObject({
      sub: "42",
      email: "user@example.com",
      connection_id: "conn-1",
      client_id: "client-1",
      scope: "tasks:create tasks:read:self",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60);
    expect(typeof claims.jti).toBe("string");
  });

  test("validation failures never include the token or secret", async () => {
    const token = await signJwt({ sub: "42" }, SECRET, {
      issuer: "issuer-a", audience: "audience-a", expiresInSeconds: 60, now: NOW,
    });
    let failure: unknown;
    try {
      await verifyJwt(`${token}tampered`, SECRET, {
        issuer: "issuer-a", audience: "audience-a", maxAgeSeconds: 60, now: NOW,
      });
    } catch (error) {
      failure = error;
    }
    const rendered = String(failure);
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(SECRET);
  });
});
