import { describe, expect, test, vi } from "vitest";

import type {
  AuthRequest,
  ClientInfo,
  CompleteAuthorizationOptions,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import { signJwt, verifyJwt } from "../src/jwt";
import { createOAuthHandler } from "../src/oauth-handler";
import type { Env } from "../src/types";

const NOW = new Date("2026-09-26T16:00:00.000Z");
const REQUEST_SECRET = "handoff-request-secret-that-is-long-enough";
const APPROVAL_SECRET = "handoff-approval-secret-that-is-long-enough";

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function authRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: "code",
    clientId: "client-1",
    redirectUri: "https://client.example/callback",
    scope: ["tasks:read:self", "offline_access"],
    state: "oauth-client-state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    resource: "https://mcp.luminousluxurycrafts.com.tr/mcp",
    issuer: "https://mcp.luminousluxurycrafts.com.tr",
    ...overrides,
  };
}

function client(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    clientId: "client-1",
    clientName: "<Gemini\u0000 Custom App>",
    redirectUris: ["https://client.example/callback"],
    tokenEndpointAuthMethod: "none",
    ...overrides,
  };
}

function harness(overrides: {
  request?: AuthRequest;
  client?: ClientInfo | null;
} = {}) {
  const kv = new MemoryKv();
  const completed: CompleteAuthorizationOptions[] = [];
  const provider = {
    parseAuthRequest: vi.fn(async () => overrides.request ?? authRequest()),
    lookupClient: vi.fn(async () => overrides.client === undefined ? client() : overrides.client),
    completeAuthorization: vi.fn(async (options: CompleteAuthorizationOptions) => {
      completed.push(options);
      return { redirectTo: "https://client.example/callback?code=issued" };
    }),
  } as unknown as OAuthHelpers;
  const env = {
    OAUTH_KV: kv as unknown as KVNamespace,
    OAUTH_PROVIDER: provider,
    LUMINOUS_AUTHORIZATION_URL: "https://luminousluxurycrafts.com.tr/#mcp-authorize",
    MCP_HANDOFF_REQUEST_SECRET: REQUEST_SECRET,
    MCP_HANDOFF_APPROVAL_SECRET: APPROVAL_SECRET,
  } as Env;
  const handler = createOAuthHandler({ now: () => NOW });
  return { kv, provider, completed, env, handler };
}

async function begin(h: ReturnType<typeof harness>) {
  const response = await h.handler.fetch(
    new Request("https://mcp.luminousluxurycrafts.com.tr/authorize?client_id=client-1"),
    h.env,
    {} as ExecutionContext,
  );
  const location = new URL(response.headers.get("Location")!);
  const fragment = new URLSearchParams(location.hash.split("?")[1]);
  return {
    response,
    location,
    handoffId: fragment.get("state")!,
    requestToken: fragment.get("request")!,
  };
}

async function approvalToken(handoffId: string, overrides: Record<string, unknown> = {}) {
  return signJwt({
    sub: "42",
    email: "user@example.com",
    connection_id: "conn-origin-1",
    client_id: "client-1",
    client_name: "Gemini Custom App",
    scope: "tasks:create tasks:read:self orders:note:append devices:read devices:jobs:write devices:jobs:read",
    handoff_id: handoffId,
    ...overrides,
  }, APPROVAL_SECRET, {
    issuer: "luminous-origin",
    audience: "luminous-mcp-worker",
    expiresInSeconds: 600,
    now: NOW,
  });
}

describe("OAuth handoff", () => {
  test("authorize validates client metadata and stores a ten-minute signed handoff", async () => {
    const h = harness();
    const started = await begin(h);
    expect(started.response.status).toBe(302);
    expect(started.location.origin).toBe("https://luminousluxurycrafts.com.tr");
    expect(started.location.hash.startsWith("#mcp-authorize?")).toBe(true);
    expect(h.provider.parseAuthRequest).toHaveBeenCalledOnce();
    expect(h.provider.lookupClient).toHaveBeenCalledWith("client-1");
    expect(h.kv.puts[0]?.options).toEqual({ expirationTtl: 600 });

    const claims = await verifyJwt(started.requestToken, REQUEST_SECRET, {
      issuer: "luminous-mcp-worker",
      audience: "luminous-mcp-authorization",
      maxAgeSeconds: 600,
      now: NOW,
    });
    expect(claims.handoff_id).toBe(started.handoffId);
    expect(claims.client_id).toBe("client-1");
    expect(claims.client_name).toBe("Gemini Custom App");
    expect(claims.scope).toBe("tasks:create tasks:read:self orders:note:append devices:read devices:jobs:write devices:jobs:read");
    expect(JSON.stringify(h.kv.puts[0])).not.toContain("<Gemini");
  });

  test("callback verifies approval, consumes state once, and completes authorization", async () => {
    const h = harness();
    const started = await begin(h);
    const approval = await approvalToken(started.handoffId);
    const callback = new URL("https://mcp.luminousluxurycrafts.com.tr/oauth/callback");
    callback.searchParams.set("state", started.handoffId);
    callback.searchParams.set("approval", approval);

    const response = await h.handler.fetch(new Request(callback), h.env, {} as ExecutionContext);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://client.example/callback?code=issued");
    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]).toMatchObject({
      request: authRequest(),
      userId: "42",
      scope: ["tasks:create", "tasks:read:self", "orders:note:append", "devices:read", "devices:jobs:write", "devices:jobs:read", "offline_access"],
      props: {
        userId: "42",
        email: "user@example.com",
        connectionId: "conn-origin-1",
        clientId: "client-1",
        clientName: "Gemini Custom App",
        scopes: ["tasks:create", "tasks:read:self", "orders:note:append", "devices:read", "devices:jobs:write", "devices:jobs:read"],
      },
    });
    expect(await h.kv.get(`mcp-handoff:${started.handoffId}`)).toBeNull();

    const replay = await h.handler.fetch(new Request(callback), h.env, {} as ExecutionContext);
    expect(replay.status).toBe(400);
    expect(h.completed).toHaveLength(1);
  });

  test("denial consumes state and safely redirects to the validated OAuth client", async () => {
    const h = harness();
    const started = await begin(h);
    const callback = new URL("https://mcp.luminousluxurycrafts.com.tr/oauth/callback");
    callback.searchParams.set("state", started.handoffId);
    callback.searchParams.set("error", "access_denied");
    const denied = await h.handler.fetch(new Request(callback), h.env, {} as ExecutionContext);
    expect(denied.status).toBe(302);
    const redirect = new URL(denied.headers.get("Location")!);
    expect(redirect.origin).toBe("https://client.example");
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("oauth-client-state");
    expect(h.completed).toHaveLength(0);
    expect(await h.kv.get(`mcp-handoff:${started.handoffId}`)).toBeNull();
  });

  test("rejects missing base scope, unknown clients, and non-fixed authorization URLs", async () => {
    const missingScope = harness({ request: authRequest({ scope: ["tasks:create"] }) });
    expect((await missingScope.handler.fetch(
      new Request("https://mcp.luminousluxurycrafts.com.tr/authorize"), missingScope.env, {} as ExecutionContext,
    )).status).toBe(400);

    const unknown = harness({ client: null });
    expect((await unknown.handler.fetch(
      new Request("https://mcp.luminousluxurycrafts.com.tr/authorize"), unknown.env, {} as ExecutionContext,
    )).status).toBe(400);

    const unsafe = harness();
    unsafe.env.LUMINOUS_AUTHORIZATION_URL = "http://attacker.example/#mcp-authorize";
    expect((await unsafe.handler.fetch(
      new Request("https://mcp.luminousluxurycrafts.com.tr/authorize"), unsafe.env, {} as ExecutionContext,
    )).status).toBe(500);
  });

  test("requires PKCE S256 for confidential clients while preserving public-client compatibility", async () => {
    for (const request of [
      authRequest({ codeChallenge: undefined }),
      authRequest({ codeChallengeMethod: "plain" }),
    ]) {
      const confidential = harness({
        request,
        client: client({ tokenEndpointAuthMethod: "client_secret_basic" }),
      });
      const response = await confidential.handler.fetch(
        new Request("https://mcp.luminousluxurycrafts.com.tr/authorize"),
        confidential.env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(400);
      expect(confidential.kv.puts).toHaveLength(0);
    }

    const publicClient = harness({
      request: authRequest({ codeChallenge: undefined, codeChallengeMethod: undefined }),
      client: client({ tokenEndpointAuthMethod: "none" }),
    });
    expect((await publicClient.handler.fetch(
      new Request("https://mcp.luminousluxurycrafts.com.tr/authorize"),
      publicClient.env,
      {} as ExecutionContext,
    )).status).toBe(302);
  });

  test("rejects state mismatch, expiry, wrong client, malformed user, and blank connection", async () => {
    const cases = [
      { name: "wrong state", queryState: "different-state", claims: {} },
      { name: "wrong client", claims: { client_id: "client-2" } },
      { name: "malformed user", claims: { sub: "admin" } },
      { name: "blank connection", claims: { connection_id: "" } },
    ];
    for (const item of cases) {
      const h = harness();
      const started = await begin(h);
      const approval = await approvalToken(started.handoffId, item.claims);
      const callback = new URL("https://mcp.luminousluxurycrafts.com.tr/oauth/callback");
      callback.searchParams.set("state", item.queryState ?? started.handoffId);
      callback.searchParams.set("approval", approval);
      const response = await h.handler.fetch(new Request(callback), h.env, {} as ExecutionContext);
      expect(response.status, item.name).toBe(400);
      expect(h.completed, item.name).toHaveLength(0);
    }

    const expired = harness();
    const started = await begin(expired);
    const expiredApproval = await signJwt({
      sub: "42", email: "user@example.com", connection_id: "conn-origin-1",
      client_id: "client-1", client_name: "Gemini Custom App",
      scope: "tasks:create tasks:read:self orders:note:append", handoff_id: started.handoffId,
    }, APPROVAL_SECRET, {
      issuer: "luminous-origin", audience: "luminous-mcp-worker", expiresInSeconds: 60,
      now: new Date("2026-09-26T15:00:00.000Z"),
    });
    const callback = new URL("https://mcp.luminousluxurycrafts.com.tr/oauth/callback");
    callback.searchParams.set("state", started.handoffId);
    callback.searchParams.set("approval", expiredApproval);
    expect((await expired.handler.fetch(new Request(callback), expired.env, {} as ExecutionContext)).status).toBe(400);
    expect(expired.completed).toHaveLength(0);
  });
});
