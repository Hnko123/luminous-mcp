import { describe, expect, test } from "vitest";

import {
  createLuminousMcpHandler,
  type LuminousMcpHandler,
  worker,
} from "../src/index";
import type { Env } from "../src/types";

const env = {} as Env;

function request(
  path: string,
  init: RequestInit = {},
  host = "mcp.luminousluxurycrafts.com.tr",
  origin = `https://${host}`,
): Request {
  const headers = new Headers(init.headers);
  headers.set("Host", host);
  headers.set("Origin", origin);
  return new Request(`https://${host}${path}`, { ...init, headers });
}

async function fetchWith(
  handler: LuminousMcpHandler,
  target: Request,
): Promise<Response> {
  return handler(target, env, {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext);
}

describe("stateless MCP transport", () => {
  test("advertises DCR without CIMD for Gemini compatibility", async () => {
    const response = await worker.fetch(
      request("/.well-known/oauth-authorization-server", { method: "GET" }),
      env,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    const metadata = await response.json() as Record<string, unknown>;
    expect(metadata.registration_endpoint).toBe(
      "https://mcp.luminousluxurycrafts.com.tr/oauth/register",
    );
    expect(metadata.client_id_metadata_document_supported).toBe(false);
  });

  test("exported worker has no authentication-free MCP lane", async () => {
    const response = await worker.fetch(
      request("/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      env,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  test("publishes_only_the_streamable_mcp_route", async () => {
    const handler = createLuminousMcpHandler(env);
    const initialize = await fetchWith(
      handler,
      request("/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "transport-test", version: "1.0.0" },
          },
        }),
      }),
    );

    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();

    for (const method of ["GET", "DELETE"]) {
      const response = await fetchWith(handler, request("/mcp", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("mcp-session-id")).toBeNull();
    }

    expect((await fetchWith(handler, request("/sse"))).status).toBe(404);
  });

  test("rejects_unapproved_host_and_origin", async () => {
    const handler = createLuminousMcpHandler(env);
    const wrongHost = await fetchWith(
      handler,
      request("/mcp", { method: "POST" }, "attacker.example"),
    );
    expect(wrongHost.status).toBe(403);

    const wrongOrigin = request(
      "/mcp",
      { method: "POST" },
      "mcp.luminousluxurycrafts.com.tr",
      "https://attacker.example",
    );
    expect((await fetchWith(handler, wrongOrigin)).status).toBe(403);
  });
});
