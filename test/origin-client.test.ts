import { afterEach, describe, expect, test, vi } from "vitest";

import { verifyJwt } from "../src/jwt";
import {
  createOriginClient,
  OriginClientError,
} from "../src/origin-client";
import type { Env, McpActor } from "../src/types";

const SECRET = "origin-assertion-secret-that-is-long-enough";
const actor: McpActor = {
  userId: "42",
  email: "user@example.com",
  connectionId: "conn-1",
  clientId: "client-1",
  clientName: "Gemini",
  scopes: new Set(["tasks:create", "tasks:read:self"]),
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    LUMINOUS_ORIGIN_URL: "https://luminousluxurycrafts.com.tr",
    MCP_ORIGIN_ASSERTION_SECRET: SECRET,
    CF_ACCESS_CLIENT_ID: "access-id",
    CF_ACCESS_CLIENT_SECRET: "access-secret",
    ...overrides,
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Luminous origin client", () => {
  test("uses only the configured origin and sends assertion, Access, and correlation headers", async () => {
    let captured: Request | undefined;
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      captured = request;
      return Response.json({ ok: true }, {
        headers: { "X-Correlation-ID": "corr-response-1" },
      });
    }));
    const client = createOriginClient(env(), actor);
    const result = await client.request<{ ok: boolean }>(
      "/api/integrations/mcp/worker/tasks/preview",
      {
        method: "POST",
        headers: { "X-Correlation-ID": "corr-request-1" },
        body: JSON.stringify({ title: "Task" }),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(captured?.url).toBe("https://luminousluxurycrafts.com.tr/api/integrations/mcp/worker/tasks/preview");
    expect(captured?.headers.get("CF-Access-Client-Id")).toBe("access-id");
    expect(captured?.headers.get("CF-Access-Client-Secret")).toBe("access-secret");
    expect(captured?.headers.get("X-Correlation-ID")).toBe("corr-request-1");
    expect(captured?.headers.get("Content-Type")).toBe("application/json");
    const assertion = captured?.headers.get("X-Luminous-MCP-Assertion") ?? "";
    const claims = await verifyJwt(assertion, SECRET, {
      issuer: "luminous-mcp-worker",
      audience: "luminous-mcp-origin",
      maxAgeSeconds: 60,
    });
    expect(claims.sub).toBe("42");
  });

  test("rejects absolute, traversal, and non-allowlisted paths without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createOriginClient(env(), actor);
    for (const path of [
      "https://attacker.example/api/integrations/mcp/worker/tasks/preview",
      "/api/integrations/mcp/../admin",
      "/api/users",
      "//attacker.example/api/integrations/mcp/tasks/preview",
    ]) {
      await expect(client.request(path)).rejects.toMatchObject({ code: "ORIGIN_PATH_DENIED" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fails closed on an invalid configured origin", () => {
    expect(() => createOriginClient(env({ LUMINOUS_ORIGIN_URL: "https://origin.example/base" }), actor))
      .toThrowError(OriginClientError);
    expect(() => createOriginClient(env({ LUMINOUS_ORIGIN_URL: "http://origin.example" }), actor))
      .toThrowError(OriginClientError);
  });

  test("aborts origin requests after ten seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((request: Request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const pending = createOriginClient(env(), actor).request("/api/integrations/mcp/worker/tasks/assigned");
    const rejection = expect(pending).rejects.toMatchObject({
      code: "ORIGIN_UNAVAILABLE",
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
  });

  test("rejects non-JSON and maps bounded origin error codes without response content leakage", async () => {
    const responses = [
      new Response("<html>proxy secret</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
      Response.json(
        { code: "ORDER_AMBIGUOUS", message: "Private buyer and note text", token: "secret-token" },
        { status: 409, headers: { "X-Correlation-ID": "corr-origin-1" } },
      ),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const client = createOriginClient(env(), actor);

    await expect(client.request("/api/integrations/mcp/worker/tasks/assigned"))
      .rejects.toMatchObject({ code: "ORIGIN_UNAVAILABLE", status: 502 });
    let failure: unknown;
    try {
      await client.request("/api/integrations/mcp/worker/order-notes/resolve", {
        method: "POST", body: JSON.stringify({ buyer_name: "Buyer" }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "ORDER_AMBIGUOUS", status: 409, correlationId: "corr-origin-1",
    });
    expect(String(failure)).not.toContain("Private buyer");
    expect(String(failure)).not.toContain("secret-token");
    expect(String(failure)).not.toContain("access-secret");
  });
});
