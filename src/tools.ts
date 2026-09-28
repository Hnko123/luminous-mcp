import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createOriginClient,
  OriginClientError,
} from "./origin-client";
import type { Env, McpActor } from "./types";

const requestId = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional();
const confirmationToken = z.string().min(1).max(4096).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createTaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  deadline: isoDate.optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  request_id: requestId,
  confirmation_token: confirmationToken,
}).strict();

const addOrderNoteInput = z.object({
  buyer_name: z.string().trim().min(1).max(200),
  note_text: z.string().trim().min(1).max(5000),
  selected_order_id: z.number().int().positive().optional(),
  request_id: requestId,
  confirmation_token: confirmationToken,
}).strict();

const listTasksInput = z.object({
  statuses: z.array(z.enum(["todo", "in-progress", "done"])).min(1).max(3).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  deadline_from: isoDate.optional(),
  deadline_to: isoDate.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

const SAFE_MESSAGES: Record<string, string> = {
  SCOPE_DENIED: "Bu işlem için Luminous bağlantı izni bulunmuyor.",
  VALIDATION_FAILED: "Gönderilen bilgiler geçerli değil.",
  CONFIRMATION_EXPIRED: "İşlem onayının süresi doldu; yeniden önizleme oluşturun.",
  CONFIRMATION_MISMATCH: "Onay, istenen işlemle eşleşmiyor.",
  ORDER_NOT_FOUND: "Bu alıcı adına erişilebilir bir sipariş bulunamadı.",
  ORDER_AMBIGUOUS: "Bu alıcı adına birden fazla sipariş bulundu; doğru siparişi seçin.",
  AUTH_REQUIRED: "Luminous bağlantısı geçersiz veya iptal edilmiş.",
  USER_INACTIVE: "Luminous kullanıcı hesabı aktif değil.",
  RATE_LIMITED: "Çok fazla istek gönderildi; kısa süre sonra yeniden deneyin.",
  ORIGIN_UNAVAILABLE: "Luminous şu anda isteği tamamlayamıyor.",
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function result(value: Record<string, unknown>, text?: string): ToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(error: unknown): ToolResult {
  const originError = error instanceof OriginClientError ? error : null;
  const code = originError?.code && SAFE_MESSAGES[originError.code]
    ? originError.code
    : "ORIGIN_UNAVAILABLE";
  const structured: Record<string, unknown> = {
    code,
    message: SAFE_MESSAGES[code],
  };
  if (code === "ORDER_AMBIGUOUS" && originError?.details.candidates) {
    structured.candidates = originError.details.candidates;
  }
  return {
    ...result(structured, SAFE_MESSAGES[code]),
    isError: true,
  };
}

function scopeError(): ToolResult {
  return {
    ...result({ code: "SCOPE_DENIED", message: SAFE_MESSAGES.SCOPE_DENIED }, SAFE_MESSAGES.SCOPE_DENIED),
    isError: true,
  };
}

function hasScope(actor: McpActor, scope: string): boolean {
  return actor.scopes.has(scope);
}

function boundedTasks(value: unknown): Record<string, unknown> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rows = Array.isArray(source.tasks) ? source.tasks : [];
  const tasks = rows.slice(0, 50).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    return [{
      id: item.id,
      title: String(item.title ?? "").slice(0, 200),
      description: String(item.description ?? "").slice(0, 500),
      deadline: item.deadline ?? null,
      priority: item.priority,
      status: item.status,
      startDate: item.startDate ?? null,
      updatedAt: item.updatedAt ?? null,
    }];
  });
  return {
    tasks,
    nextCursor: typeof source.nextCursor === "string" ? source.nextCursor.slice(0, 2048) : null,
  };
}

export function registerLuminousTools(
  server: McpServer,
  { env, actor }: { env: Env; actor: McpActor },
): void {
  const origin = createOriginClient(env, actor);

  server.registerTool(
    "create_task",
    {
      title: "Luminous görevi oluştur / Create Luminous task",
      description: "Kullanıcının kendisine atanmış bir Luminous görevi için güvenli önizleme oluşturur; açık onaydan sonra aynı araçla kaydeder. Creates a self-assigned task after explicit confirmation.",
      inputSchema: createTaskInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (!hasScope(actor, "tasks:create")) return scopeError();
      if (input.confirmation_token && !input.request_id) {
        return errorResult(new OriginClientError("VALIDATION_FAILED", 400));
      }
      const body = {
        ...input,
        request_id: input.request_id ?? randomUUID(),
      };
      try {
        const response = await origin.request<Record<string, unknown>>(
          input.confirmation_token
            ? "/api/integrations/mcp/worker/tasks/commit"
            : "/api/integrations/mcp/worker/tasks/preview",
          { method: "POST", body: JSON.stringify(body) },
        );
        return result(response);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "add_order_note",
    {
      title: "Sipariş notu ekle / Append order note",
      description: "Alıcı adını yalnızca erişilebilir siparişlerde tam normalize eşleşmeyle bulur; belirsizlikte seçim ister ve açık onaydan sonra mevcut Note alanının sonuna ekler. Resolves a buyer safely and appends after confirmation.",
      inputSchema: addOrderNoteInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (!hasScope(actor, "orders:note:append")) return scopeError();
      if (input.confirmation_token && !input.request_id) {
        return errorResult(new OriginClientError("VALIDATION_FAILED", 400));
      }
      try {
        const resolved = await origin.request<{
          status: string;
          order: { id: number };
        }>("/api/integrations/mcp/worker/order-notes/resolve", {
          method: "POST",
          body: JSON.stringify({
            buyer_name: input.buyer_name,
            ...(input.selected_order_id ? { selected_order_id: input.selected_order_id } : {}),
          }),
        });
        const body = {
          ...input,
          selected_order_id: resolved.order.id,
          request_id: input.request_id ?? randomUUID(),
        };
        const response = await origin.request<Record<string, unknown>>(
          input.confirmation_token
            ? "/api/integrations/mcp/worker/order-notes/commit"
            : "/api/integrations/mcp/worker/order-notes/preview",
          { method: "POST", body: JSON.stringify(body) },
        );
        return result(response);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_my_tasks",
    {
      title: "Görevlerim / My tasks",
      description: "Luminous'ta yalnızca size atanmış görevleri listeler. Şu doğal ifadeler için kullan: “Görevlerim ne?”, “Görevler”, “Görevlerim neler?”, “Benim görev”. Lists only the authenticated user's assigned tasks, with optional status, priority and date filters.",
      inputSchema: listTasksInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (!hasScope(actor, "tasks:read:self")) return scopeError();
      const query = new URLSearchParams();
      if (input.statuses) query.set("statuses", input.statuses.join(","));
      if (input.priority) query.set("priority", input.priority);
      if (input.deadline_from) query.set("deadline_from", input.deadline_from);
      if (input.deadline_to) query.set("deadline_to", input.deadline_to);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.cursor) query.set("cursor", input.cursor);
      const suffix = query.size ? `?${query.toString()}` : "";
      try {
        const response = await origin.request<Record<string, unknown>>(
          `/api/integrations/mcp/worker/tasks/assigned${suffix}`,
        );
        const bounded = boundedTasks(response);
        const summary = (bounded.tasks as Array<Record<string, unknown>>)
          .map((task) => `#${String(task.id)} ${String(task.title)} — ${String(task.status)}${task.deadline ? ` — ${String(task.deadline)}` : ""}`)
          .join("\n");
        return result(bounded, summary || "Atanmış görev bulunamadı.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

export {
  addOrderNoteInput,
  createTaskInput,
  listTasksInput,
};
