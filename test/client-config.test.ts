import { describe, expect, it } from 'vitest';

// Vite supplies documentation fixtures as source text inside the Worker test runtime.
// @ts-expect-error Markdown raw imports are provided by Vite.
import markdown from '../README.md?raw';

const CANONICAL_URL = 'https://mcp.luminousluxurycrafts.com.tr/mcp';
function jsonExamples(markdown: string) {
  return [...markdown.matchAll(/```json\s+([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
}

function visit(value: unknown, callback: (key: string, value: unknown) => void, key = ''): void {
  callback(key, value);
  if (Array.isArray(value)) value.forEach((item) => visit(item, callback, key));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, callback, childKey));
  }
}

describe('documented client configurations', () => {
  const examples = jsonExamples(markdown);

  it('contains parseable examples for direct clients and one explicit bridge', () => {
    expect(examples).toHaveLength(5);
    expect(examples.filter((example) => JSON.stringify(example).includes('mcp-remote'))).toHaveLength(1);
  });

  it('uses only the canonical HTTPS MCP endpoint and contains no credentials', () => {
    for (const example of examples) {
      const serialized = JSON.stringify(example);
      expect(serialized).not.toMatch(/bearer|authorization|api[_-]?key|client[_-]?secret|access[_-]?token/i);

      visit(example, (key, value) => {
        if (typeof value !== 'string') return;
        if (/^https?:\/\//.test(value)) expect(value).toBe(CANONICAL_URL);
        if (key === 'url' || key === 'httpUrl' || key === 'serverUrl') expect(value).toBe(CANONICAL_URL);
      });
    }
  });

  it('documents remote HTTP/OAuth directly except for the named mcp-remote fallback', () => {
    for (const example of examples) {
      const serialized = JSON.stringify(example);
      const isBridge = serialized.includes('mcp-remote');
      if (isBridge) {
        expect(serialized).toContain(CANONICAL_URL);
        expect(serialized).toContain('npx');
      } else {
        expect(serialized).toContain(CANONICAL_URL);
        expect(serialized).not.toMatch(/"command"|"args"|stdio/);
      }
    }
  });

  it('covers all pilot clients, tools, and required secret names without values', () => {
    for (const client of ['Gemini', 'Codex', 'Claude', 'Antigravity', 'VS Code', 'LM Studio', 'MCP Inspector']) {
      expect(markdown).toContain(client);
    }
    for (const tool of ['create_task', 'add_order_note', 'list_my_tasks']) expect(markdown).toContain(tool);
    for (const variable of [
      'MCP_HANDOFF_REQUEST_SECRET',
      'MCP_HANDOFF_APPROVAL_SECRET',
      'MCP_ORIGIN_ASSERTION_SECRET',
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
    ]) expect(markdown).toContain(variable);
  });
});
