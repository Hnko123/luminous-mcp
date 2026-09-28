import { afterEach, describe, expect, test, vi } from "vitest";

import { createLuminousMcpHandler } from "../src/index";
import type { Env, McpAuthProps } from "../src/types";

const props: McpAuthProps = {
  userId: "42",
  email: "user@example.com",
  connectionId: "conn-1",
  clientId: "client-1",
  clientName: "Gemini",
  scopes: ["tasks:create", "tasks:read:self", "orders:note:append"],
};

function env(): Env {
  return {
    LUMINOUS_ORIGIN_URL: "https://luminousluxurycrafts.com.tr",
    MCP_ORIGIN_ASSERTION_SECRET: "origin-assertion-secret-that-is-long-enough",
    CF_ACCESS_CLIENT_ID: "access-id",
    CF_ACCESS_CLIENT_SECRET: "access-secret",
  } as Env;
}

function request(body: unknown): Request {
  return new Request("https://mcp.luminousluxurycrafts.com.tr/mcp", {
    method: "POST",
    headers: {
      Host: "mcp.luminousluxurycrafts.com.tr",
      Origin: "https://mcp.luminousluxurycrafts.com.tr",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function rpc(
  body: unknown,
  authProps: McpAuthProps = props,
): Promise<Record<string, any>> {
  const handler = createLuminousMcpHandler(env(), authProps);
  const response = await handler(request(body), env(), {
    waitUntil() {},
    passThroughOnException() {},
    props: authProps,
  } as unknown as ExecutionContext);
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : text;
  return JSON.parse(payload ?? "{}") as Record<string, any>;
}

async function listTools(authProps: McpAuthProps = props) {
  const response = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, authProps);
  return response.result.tools as Array<Record<string, any>>;
}

async function callTool(name: string, args: Record<string, unknown>, authProps: McpAuthProps = props) {
  const response = await rpc({
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args },
  }, authProps);
  return response.result as Record<string, any>;
}

afterEach(() => vi.unstubAllGlobals());

describe("Luminous MCP tools", () => {
  test("publishes exactly three bounded tools with safe annotations", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "create_task",
      "add_order_note",
      "list_my_tasks",
    ]);
    expect(tools.some((tool) => /admin|database|sql/i.test(tool.name))).toBe(false);

    const create = tools.find((tool) => tool.name === "create_task")!;
    expect(create.inputSchema.properties.title.minLength).toBe(1);
    expect(create.inputSchema.properties.title.maxLength).toBe(200);
    expect(create.inputSchema.properties.description.maxLength).toBe(5000);
    expect(create.inputSchema.properties.priority.enum).toEqual(["low", "medium", "high"]);
    expect(create.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: false, idempotentHint: true,
    });

    const note = tools.find((tool) => tool.name === "add_order_note")!;
    expect(note.inputSchema.properties.buyer_name.maxLength).toBe(200);
    expect(note.inputSchema.properties.note_text.maxLength).toBe(5000);
    expect(note.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: false, idempotentHint: true,
    });

    const list = tools.find((tool) => tool.name === "list_my_tasks")!;
    expect(list.inputSchema.properties.limit.maximum).toBe(50);
    expect(list.annotations.readOnlyHint).toBe(true);
    const descriptions = tools.map((tool) => tool.description).join(" ");
    for (const phrase of ["Görevlerim ne?", "Görevler", "Görevlerim neler?", "Benim görev"]) {
      expect(descriptions).toContain(phrase);
    }
  });

  test("enforces tool scopes before any origin request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const readOnlyProps = { ...props, scopes: ["tasks:read:self"] };
    const result = await callTool("create_task", { title: "No access" }, readOnlyProps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("SCOPE_DENIED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("create_task maps preview and confirmed calls without accepting identity fields", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (incoming: Request) => {
      const body = await incoming.json() as Record<string, unknown>;
      calls.push({ path: new URL(incoming.url).pathname, body });
      return Response.json(calls.length === 1
        ? { code: "CONFIRMATION_REQUIRED", preview: { title: "Follow up" }, requestId: body.request_id, confirmationToken: "confirm-1" }
        : { taskId: 91, replayed: false });
    }));

    const preview = await callTool("create_task", { title: "Follow up" });
    expect(preview.structuredContent.code).toBe("CONFIRMATION_REQUIRED");
    const requestId = preview.structuredContent.requestId;
    const committed = await callTool("create_task", {
      title: "Follow up", request_id: requestId, confirmation_token: "confirm-1",
    });
    expect(committed.structuredContent.taskId).toBe(91);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/integrations/mcp/worker/tasks/preview",
      "/api/integrations/mcp/worker/tasks/commit",
    ]);
    expect(calls[0].body).not.toHaveProperty("created_by");

    const invalid = await callTool("create_task", { title: "x", created_by: 77 });
    expect(invalid.isError).toBe(true);
  });

  test("add_order_note resolves first, preserves ambiguity privacy, and then previews or commits", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (incoming: Request) => {
      const path = new URL(incoming.url).pathname;
      paths.push(path);
      if (path.endsWith("/resolve")) {
        return Response.json({
          code: "ORDER_AMBIGUOUS",
          candidates: [{ id: 1, transactionId: "TX-1", shopName: "Shop", orderDate: "2026-09-25", full_address: "private" }],
        }, { status: 409, headers: { "X-Correlation-ID": "corr-note-1" } });
      }
      return Response.json({});
    }));
    const ambiguous = await callTool("add_order_note", {
      buyer_name: "Loska Geraldine", note_text: "Call buyer",
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.structuredContent.code).toBe("ORDER_AMBIGUOUS");
    expect(ambiguous.structuredContent.candidates[0]).not.toHaveProperty("full_address");
    expect(paths).toEqual(["/api/integrations/mcp/worker/order-notes/resolve"]);
  });

  test("list_my_tasks maps active defaults, explicit completed filters, and bounds local-model context", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (incoming: Request) => {
      requestedUrls.push(incoming.url);
      return Response.json({
        tasks: Array.from({ length: 50 }, (_, index) => ({
          id: index + 1,
          title: `Task ${index + 1}`,
          description: "x".repeat(2000),
          deadline: null,
          priority: "medium",
          status: "done",
          startDate: "2026-09-26",
          updatedAt: "2026-09-26 16:00:00",
        })),
        nextCursor: null,
      });
    }));

    const active = await callTool("list_my_tasks", {});
    const completed = await callTool("list_my_tasks", { statuses: ["done"], limit: 50 });
    expect(new URL(requestedUrls[0]).searchParams.has("statuses")).toBe(false);
    expect(new URL(requestedUrls[1]).searchParams.get("statuses")).toBe("done");
    expect(active.isError).not.toBe(true);
    expect(JSON.stringify(completed).length).toBeLessThan(50_000);
    expect(completed.structuredContent.tasks).toHaveLength(50);
    expect(completed.structuredContent.tasks[0].description.length).toBeLessThanOrEqual(500);
  });

  test("natural-language discovery text covers agreed variants and punctuation/case", async () => {
    const description = (await listTools())
      .find((tool) => tool.name === "list_my_tasks")!.description;
    const normalized = description.toLocaleLowerCase("tr-TR").replace(/[?!.,]/g, "");
    for (const phrase of ["görevlerim ne", "görevler", "görevlerim neler", "benim görev"]) {
      expect(normalized).toContain(phrase);
    }
  });
});
