import { randomUUID } from "node:crypto";

import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";

import { createClientManagementHandler } from "./client-management";
import { signJwt, verifyJwt } from "./jwt";
import type { Env, McpAuthProps } from "./types";

const HANDOFF_TTL_SECONDS = 600;
const HANDOFF_KEY_PREFIX = "mcp-handoff:";
const PILOT_SCOPES = [
  "tasks:create",
  "tasks:read:self",
  "orders:note:append",
  "devices:read",
  "devices:jobs:write",
  "devices:jobs:read",
] as const;
const BASE_SCOPE = "tasks:read:self";
const ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

interface StoredHandoff {
  request: AuthRequest;
  clientId: string;
  clientName: string;
  pilotScopes: string[];
  includeOfflineAccess: boolean;
  createdAt: string;
}

interface OAuthHandlerOptions {
  now?: () => Date;
}

export interface LuminousOAuthHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

function sanitizeClientName(value: unknown): string {
  const result = String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return result || "AI Client";
}

function authorizationTarget(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash !== "#mcp-authorize"
    ) {
      throw new Error("invalid authorization target");
    }
    return url;
  } catch {
    throw new Error("OAuth handoff is not configured");
  }
}

function localError(status = 400): Response {
  return Response.json(
    { error: status >= 500 ? "authorization_unavailable" : "invalid_authorization_request" },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function oauthDenialRedirect(request: AuthRequest): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "The user denied the authorization request.");
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect.href, 302);
}

function parseStoredHandoff(value: string | null): StoredHandoff | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as StoredHandoff;
    if (
      !parsed
      || typeof parsed !== "object"
      || !parsed.request
      || typeof parsed.clientId !== "string"
      || typeof parsed.clientName !== "string"
      || !Array.isArray(parsed.pilotScopes)
      || typeof parsed.includeOfflineAccess !== "boolean"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validApprovalClaims(
  claims: Record<string, unknown>,
  handoffId: string,
  stored: StoredHandoff,
): claims is Record<string, unknown> & {
  sub: string;
  email: string;
  connection_id: string;
  client_id: string;
  client_name: string;
  scope: string;
  handoff_id: string;
} {
  return Boolean(
    typeof claims.sub === "string"
    && /^[1-9]\d*$/.test(claims.sub)
    && typeof claims.email === "string"
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
    && typeof claims.connection_id === "string"
    && ID_PATTERN.test(claims.connection_id)
    && claims.client_id === stored.clientId
    && claims.client_name === stored.clientName
    && claims.handoff_id === handoffId
    && claims.scope === stored.pilotScopes.join(" ")
  );
}

export function createOAuthHandler(options: OAuthHandlerOptions = {}): LuminousOAuthHandler {
  const now = options.now ?? (() => new Date());
  const clientManagement = createClientManagementHandler({ now });
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const url = new URL(request.url);
      if (
        url.pathname === "/internal/oauth-clients"
        || url.pathname.startsWith("/internal/oauth-clients/")
      ) {
        return clientManagement.fetch(request, env, ctx);
      }
      if (url.pathname === "/authorize") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
        }
        try {
          const target = authorizationTarget(env.LUMINOUS_AUTHORIZATION_URL);
          const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
          if (!parsed.scope.includes(BASE_SCOPE)) return localError();
          const resolvedClient = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
          if (!resolvedClient) return localError();
          const clientMetadata = resolvedClient as ClientInfo;
          if (
            clientMetadata.tokenEndpointAuthMethod !== "none"
            && (!parsed.codeChallenge || parsed.codeChallengeMethod !== "S256")
          ) return localError();
          const clientName = sanitizeClientName(clientMetadata.clientName);
          const handoffId = randomUUID();
          const stored: StoredHandoff = {
            request: parsed,
            clientId: parsed.clientId,
            clientName,
            pilotScopes: [...PILOT_SCOPES],
            includeOfflineAccess: parsed.scope.includes("offline_access"),
            createdAt: now().toISOString(),
          };
          await env.OAUTH_KV.put(
            `${HANDOFF_KEY_PREFIX}${handoffId}`,
            JSON.stringify(stored),
            { expirationTtl: HANDOFF_TTL_SECONDS },
          );
          const handoffToken = await signJwt({
            sub: handoffId,
            handoff_id: handoffId,
            client_id: parsed.clientId,
            client_name: clientName,
            scope: PILOT_SCOPES.join(" "),
          }, env.MCP_HANDOFF_REQUEST_SECRET, {
            issuer: "luminous-mcp-worker",
            audience: "luminous-mcp-authorization",
            expiresInSeconds: HANDOFF_TTL_SECONDS,
            now: now(),
          });
          target.hash = `mcp-authorize?${new URLSearchParams({
            request: handoffToken,
            state: handoffId,
          }).toString()}`;
          return Response.redirect(target.href, 302);
        } catch (error) {
          return localError(error instanceof AuthorizationError ? 400 : 500);
        }
      }

      if (url.pathname === "/oauth/callback") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
        }
        const handoffId = String(url.searchParams.get("state") ?? "");
        if (!ID_PATTERN.test(handoffId)) return localError();
        const key = `${HANDOFF_KEY_PREFIX}${handoffId}`;
        const stored = parseStoredHandoff(await env.OAUTH_KV.get(key));
        if (!stored) return localError();

        if (url.searchParams.get("error") === "access_denied") {
          await env.OAUTH_KV.delete(key);
          return oauthDenialRedirect(stored.request);
        }
        const approval = String(url.searchParams.get("approval") ?? "");
        if (!approval) return localError();
        try {
          const claims = await verifyJwt(approval, env.MCP_HANDOFF_APPROVAL_SECRET, {
            issuer: "luminous-origin",
            audience: "luminous-mcp-worker",
            maxAgeSeconds: HANDOFF_TTL_SECONDS,
            now: now(),
          });
          if (!validApprovalClaims(claims, handoffId, stored)) return localError();
          await env.OAUTH_KV.delete(key);
          const scopes = [...stored.pilotScopes];
          const props: McpAuthProps = {
            userId: claims.sub,
            email: claims.email.trim().toLowerCase(),
            connectionId: claims.connection_id,
            clientId: claims.client_id,
            clientName: claims.client_name,
            scopes,
          };
          const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
            request: stored.request,
            userId: claims.sub,
            scope: stored.includeOfflineAccess ? [...scopes, "offline_access"] : scopes,
            props,
            metadata: {
              clientName: stored.clientName,
              connectionId: claims.connection_id,
            },
          });
          return Response.redirect(redirectTo, 302);
        } catch {
          return localError();
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}

export {
  BASE_SCOPE,
  HANDOFF_KEY_PREFIX,
  HANDOFF_TTL_SECONDS,
  PILOT_SCOPES,
  sanitizeClientName,
};
