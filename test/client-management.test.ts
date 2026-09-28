import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { createClientManagementHandler } from "../src/client-management";
import { signJwt } from "../src/jwt";
import type { Env } from "../src/types";

const NOW = new Date("2026-09-28T01:00:00.000Z");
const SECRET = "management-secret-that-is-at-least-32-bytes";

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function digest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

async function assertion(operation: "create" | "delete", body: string, overrides: Record<string, unknown> = {}) {
  return signJwt({
    sub: "42",
    operation,
    body_sha256: digest(body),
    request_id: "request-12345678",
    ...overrides,
  }, SECRET, {
    issuer: "luminous-origin",
    audience: "luminous-mcp-client-management",
    expiresInSeconds: 60,
    now: NOW,
  });
}

function harness() {
  const kv = new MemoryKv();
  const createClient = vi.fn(async () => ({
    clientId: "generated-client-id",
    clientSecret: "generated-client-secret",
    clientName: "Gemini Work",
    redirectUris: ["https://client.example/callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
  }));
  const deleteClient = vi.fn(async () => undefined);
  const env = {
    OAUTH_KV: kv,
    OAUTH_PROVIDER: { createClient, deleteClient },
    MCP_CLIENT_MANAGEMENT_SECRET: SECRET,
  } as unknown as Env;
  return {
    kv,
    createClient,
    deleteClient,
    env,
    handler: createClientManagementHandler({ now: () => NOW }),
  };
}

async function managedRequest(
  h: ReturnType<typeof harness>,
  path: string,
  method: "POST" | "DELETE",
  body: string,
  token?: string,
  extraHeaders: Record<string, string> = {},
) {
  return h.handler.fetch(new Request(`https://mcp.luminousluxurycrafts.com.tr${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Luminous-Management-Assertion": token } : {}),
      ...extraHeaders,
    },
    ...(body ? { body } : {}),
  }), h.env, {} as ExecutionContext);
}

describe("private OAuth client management", () => {
  test("creates a confidential OAuth client from a signed body-bound request", async () => {
    const h = harness();
    const body = JSON.stringify({
      clientName: "Gemini Work",
      redirectUris: ["https://client.example/callback"],
    });
    const response = await managedRequest(h, "/internal/oauth-clients", "POST", body, await assertion("create", body));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      clientId: "generated-client-id",
      clientSecret: "generated-client-secret",
      clientName: "Gemini Work",
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    expect(h.createClient).toHaveBeenCalledWith({
      clientName: "Gemini Work",
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("deletes the client and its grants through OAuthHelpers", async () => {
    const h = harness();
    const token = await assertion("delete", "", { client_id: "generated-client-id" });
    const response = await managedRequest(h, "/internal/oauth-clients/generated-client-id", "DELETE", "", token);

    expect(response.status).toBe(204);
    expect(h.deleteClient).toHaveBeenCalledWith("generated-client-id");
  });

  test("rejects a delete assertion issued for a different client id", async () => {
    const h = harness();
    const token = await assertion("delete", "", { client_id: "different-client-id" });
    const response = await managedRequest(h, "/internal/oauth-clients/generated-client-id", "DELETE", "", token);

    expect(response.status).toBe(401);
    expect(h.deleteClient).not.toHaveBeenCalled();
  });

  test("rejects missing, expired, mismatched, replayed, and browser assertions", async () => {
    const body = JSON.stringify({ clientName: "Gemini Work", redirectUris: ["https://client.example/callback"] });
    const cases = [
      { name: "missing", token: undefined },
      { name: "wrong operation", token: await assertion("delete", body) },
      { name: "wrong digest", token: await assertion("create", body, { body_sha256: "0".repeat(64) }) },
      { name: "expired", token: await signJwt({ sub: "42", operation: "create", body_sha256: digest(body), request_id: "expired-request" }, SECRET, {
        issuer: "luminous-origin", audience: "luminous-mcp-client-management", expiresInSeconds: 60,
        now: new Date("2026-09-27T23:00:00.000Z"),
      }) },
    ];

    for (const item of cases) {
      const h = harness();
      const response = await managedRequest(h, "/internal/oauth-clients", "POST", body, item.token);
      expect(response.status, item.name).toBe(401);
      expect(h.createClient, item.name).not.toHaveBeenCalled();
    }

    const replay = harness();
    const replayToken = await assertion("create", body);
    expect((await managedRequest(replay, "/internal/oauth-clients", "POST", body, replayToken)).status).toBe(201);
    expect((await managedRequest(replay, "/internal/oauth-clients", "POST", body, replayToken)).status).toBe(401);
    expect(replay.createClient).toHaveBeenCalledTimes(1);

    const browser = harness();
    const browserResponse = await managedRequest(
      browser, "/internal/oauth-clients", "POST", body, await assertion("create", body),
      { Origin: "https://luminousluxurycrafts.com.tr" },
    );
    expect(browserResponse.status).toBe(403);
    expect(browser.createClient).not.toHaveBeenCalled();
  });

  test("rejects unsafe redirect URIs before creating a client", async () => {
    const h = harness();
    const body = JSON.stringify({ clientName: "Unsafe", redirectUris: ["http://attacker.example/callback"] });
    const response = await managedRequest(h, "/internal/oauth-clients", "POST", body, await assertion("create", body));

    expect(response.status).toBe(400);
    expect(h.createClient).not.toHaveBeenCalled();
  });

  test("rejects Unicode control and format characters before creating a client", async () => {
    for (const clientName of ["\u202e", "\u200b", "Client\u0085Name"]) {
      const h = harness();
      const body = JSON.stringify({ clientName, redirectUris: ["https://client.example/callback"] });
      const response = await managedRequest(h, "/internal/oauth-clients", "POST", body, await assertion("create", body));

      expect(response.status, JSON.stringify(clientName)).toBe(400);
      expect(h.createClient).not.toHaveBeenCalled();
    }
  });
});
