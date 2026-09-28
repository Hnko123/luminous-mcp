import type { ClientInfo } from "@cloudflare/workers-oauth-provider";

import { verifyJwt } from "./jwt";
import type { Env } from "./types";

const MANAGEMENT_ISSUER = "luminous-origin";
const MANAGEMENT_AUDIENCE = "luminous-mcp-client-management";
const MANAGEMENT_TTL_SECONDS = 60;
const REPLAY_TTL_SECONDS = 120;
const REPLAY_PREFIX = "mcp-client-management-replay:";
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface ClientManagementOptions {
  now?: () => Date;
}

export interface ClientManagementHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(status: number): Response {
  return json({ error: status === 400 ? "invalid_request" : "unauthorized" }, status);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function normalizeClientName(value: unknown): string {
  const normalized = String(value ?? "").normalize("NFKC");
  if (/[\p{Cc}\p{Cf}]/u.test(normalized.replace(/[\u0000-\u001f\u007f]/g, ""))) {
    throw new Error("invalid client name");
  }
  const name = normalized
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > 120) throw new Error("invalid client name");
  return name;
}

function normalizeRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new Error("invalid redirect URIs");
  }
  const uris = value.map((item) => {
    const url = new URL(String(item ?? ""));
    const acceptedScheme = url.protocol === "https:"
      || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    if (!acceptedScheme || url.username || url.password || url.hash) {
      throw new Error("unsafe redirect URI");
    }
    return url.href;
  });
  if (new Set(uris).size !== uris.length) throw new Error("duplicate redirect URI");
  return uris;
}

function operationFor(request: Request, url: URL): "create" | "delete" | null {
  if (request.method === "POST" && url.pathname === "/internal/oauth-clients") return "create";
  if (request.method === "DELETE" && url.pathname.startsWith("/internal/oauth-clients/")) return "delete";
  return null;
}

async function authorize(
  request: Request,
  env: Env,
  operation: "create" | "delete",
  body: string,
  now: Date,
  clientId?: string,
): Promise<boolean> {
  const token = String(request.headers.get("X-Luminous-Management-Assertion") ?? "").trim();
  if (!token) return false;
  try {
    const claims = await verifyJwt(token, env.MCP_CLIENT_MANAGEMENT_SECRET, {
      issuer: MANAGEMENT_ISSUER,
      audience: MANAGEMENT_AUDIENCE,
      maxAgeSeconds: MANAGEMENT_TTL_SECONDS,
      now,
    });
    if (
      !/^[1-9]\d*$/.test(String(claims.sub ?? ""))
      || claims.operation !== operation
      || claims.body_sha256 !== await sha256(body)
      || typeof claims.request_id !== "string"
      || !/^[A-Za-z0-9._:-]{8,128}$/.test(claims.request_id)
      || typeof claims.jti !== "string"
      || (operation === "delete" && claims.client_id !== clientId)
    ) return false;
    const replayKey = `${REPLAY_PREFIX}${claims.jti}`;
    if (await env.OAUTH_KV.get(replayKey)) return false;
    await env.OAUTH_KV.put(replayKey, claims.request_id, { expirationTtl: REPLAY_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}

function publicClient(client: ClientInfo): Record<string, unknown> {
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
  };
}

export function createClientManagementHandler(
  options: ClientManagementOptions = {},
): ClientManagementHandler {
  const now = options.now ?? (() => new Date());
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      const operation = operationFor(request, url);
      if (!operation) return new Response("Not Found", { status: 404 });
      if (request.headers.has("Origin")) return errorResponse(403);
      const body = operation === "create" ? await request.text() : "";
      let deleteClientId: string | undefined;
      if (operation === "delete") {
        try {
          deleteClientId = decodeURIComponent(url.pathname.slice("/internal/oauth-clients/".length));
        } catch {
          return errorResponse(400);
        }
        if (!CLIENT_ID_PATTERN.test(deleteClientId)) return errorResponse(400);
      }
      if (!(await authorize(request, env, operation, body, now(), deleteClientId))) return errorResponse(401);

      if (operation === "delete") {
        await env.OAUTH_PROVIDER.deleteClient(deleteClientId!);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }

      try {
        if (body.length > 32 * 1024) return errorResponse(400);
        const input = JSON.parse(body) as Record<string, unknown>;
        const created = await env.OAUTH_PROVIDER.createClient({
          clientName: normalizeClientName(input.clientName),
          redirectUris: normalizeRedirectUris(input.redirectUris),
          tokenEndpointAuthMethod: "client_secret_basic",
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
        });
        return json(publicClient(created), 201);
      } catch {
        return errorResponse(400);
      }
    },
  };
}

export {
  MANAGEMENT_AUDIENCE,
  MANAGEMENT_ISSUER,
  MANAGEMENT_TTL_SECONDS,
};
