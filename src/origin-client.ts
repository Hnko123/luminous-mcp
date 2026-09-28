import { randomUUID } from "node:crypto";

import { createOriginAssertion } from "./jwt";
import type { Env, McpActor } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_PATHS = new Set([
  "/api/integrations/mcp/worker/tasks/preview",
  "/api/integrations/mcp/worker/tasks/commit",
  "/api/integrations/mcp/worker/tasks/assigned",
  "/api/integrations/mcp/worker/order-notes/resolve",
  "/api/integrations/mcp/worker/order-notes/preview",
  "/api/integrations/mcp/worker/order-notes/commit",
  "/api/integrations/mcp/worker/neo/devices",
  "/api/integrations/mcp/worker/neo/jobs",
  "/api/integrations/mcp/worker/neo/tool-jobs",
]);
const NEO_JOB_PATH = /^\/api\/integrations\/mcp\/worker\/neo\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

interface SafeErrorDetails {
  candidates?: Array<{
    id: number | string;
    transactionId: string;
    shopName: string;
    orderDate: string;
  }>;
}

export class OriginClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | null;
  readonly details: SafeErrorDetails;

  constructor(
    code: string,
    status = 503,
    correlationId: string | null = null,
    details: SafeErrorDetails = {},
  ) {
    super(`Luminous origin request failed (${code})`);
    this.name = "OriginClientError";
    this.code = code;
    this.status = status;
    this.correlationId = correlationId;
    this.details = details;
  }
}

function fixedOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new OriginClientError("ORIGIN_UNAVAILABLE");
  }
}

function allowedTarget(path: string, origin: string): URL {
  if (
    typeof path !== "string"
    || !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("\\")
    || /%2e/i.test(path)
    || /(^|\/)\.{1,2}($|[/?#])/u.test(path)
  ) {
    throw new OriginClientError("ORIGIN_PATH_DENIED", 400);
  }
  let target: URL;
  try {
    target = new URL(path, origin);
  } catch {
    throw new OriginClientError("ORIGIN_PATH_DENIED", 400);
  }
  if (target.origin !== origin || (!ALLOWED_PATHS.has(target.pathname) && !NEO_JOB_PATH.test(target.pathname))) {
    throw new OriginClientError("ORIGIN_PATH_DENIED", 400);
  }
  if (target.search && target.pathname !== "/api/integrations/mcp/worker/tasks/assigned") {
    throw new OriginClientError("ORIGIN_PATH_DENIED", 400);
  }
  return target;
}

function safeDetails(value: unknown): SafeErrorDetails {
  if (!value || typeof value !== "object") return {};
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return {};
  return {
    candidates: candidates.slice(0, 50).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Record<string, unknown>;
      if (
        !(typeof item.id === "number" || typeof item.id === "string")
        || typeof item.transactionId !== "string"
        || typeof item.shopName !== "string"
        || typeof item.orderDate !== "string"
      ) return [];
      return [{
        id: item.id,
        transactionId: item.transactionId.slice(0, 200),
        shopName: item.shopName.slice(0, 200),
        orderDate: item.orderDate.slice(0, 40),
      }];
    }),
  };
}
export function createOriginClient(env: Env, actor: McpActor) {
  const origin = fixedOrigin(env.LUMINOUS_ORIGIN_URL);
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
    throw new OriginClientError("ORIGIN_UNAVAILABLE");
  }

  return {
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const target = allowedTarget(path, origin);
      const headers = new Headers(init.headers);
      const suppliedCorrelation = String(headers.get("X-Correlation-ID") ?? "").trim();
      const correlationId = CORRELATION_ID.test(suppliedCorrelation)
        ? suppliedCorrelation
        : randomUUID();
      headers.set("Accept", "application/json");
      if (init.body !== undefined && init.body !== null) headers.set("Content-Type", "application/json");
      headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
      headers.set("X-Correlation-ID", correlationId);
      headers.set("X-Luminous-MCP-Assertion", await createOriginAssertion(env, actor));

      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      init.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(new Request(target, {
          ...init,
          headers,
          signal: controller.signal,
        }));
      } catch {
        throw new OriginClientError("ORIGIN_UNAVAILABLE", 503, correlationId);
      } finally {
        clearTimeout(timeout);
        init.signal?.removeEventListener("abort", abortFromCaller);
      }

      const responseCorrelation = response.headers.get("X-Correlation-ID") || correlationId;
      const contentType = response.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new OriginClientError("ORIGIN_UNAVAILABLE", response.ok ? 502 : response.status, responseCorrelation);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new OriginClientError("ORIGIN_UNAVAILABLE", 502, responseCorrelation);
      }
      if (!response.ok) {
        const rawCode = body && typeof body === "object"
          ? (body as { code?: unknown }).code
          : null;
        const code = typeof rawCode === "string" && SAFE_CODE.test(rawCode)
          ? rawCode
          : "ORIGIN_UNAVAILABLE";
        throw new OriginClientError(code, response.status, responseCorrelation, safeDetails(body));
      }
      return body as T;
    },
  };
}
