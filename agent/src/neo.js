import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export function validateNeoUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) {
    throw new Error('NEO_URL_INVALID');
  }
  return url;
}

export function countTabs(result) {
  if (result?.isError) throw new Error('NEO_TABS_UNAVAILABLE');
  const value = result?.structuredContent;
  if (Array.isArray(value?.pages)) return value.pages.length;
  if (Array.isArray(value?.tabs)) return value.tabs.length;
  if (Array.isArray(value)) return value.length;
  const text = result?.content?.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n') || '';
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length;
    if (Array.isArray(parsed.tabs)) return parsed.tabs.length;
  } catch { /* Neo may return a numbered text list. */ }
  if (/\(no open pages\)|no (open )?tabs|0 tabs|tabs:\s*\[\s*\]/i.test(text)) return 0;
  const numbered = text.split('\n').filter((line) => /^\s*(?:\d+[.):-]|\[\d+\])\s+/.test(line));
  if (numbered.length) return numbered.length;
  throw new Error('NEO_RESPONSE_INVALID');
}

export async function testNeoConnection(neoUrl, connect = async (url) => {
  const client = new Client({ name: 'luminous-neo-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}) {
  let client;
  try {
    client = await connect(validateNeoUrl(neoUrl));
    const listed = await client.listTools();
    const toolNames = (listed.tools || []).map((tool) => tool.name).filter((name) => /^[A-Za-z0-9_.:-]{1,80}$/.test(name)).slice(0, 80);
    if (!toolNames.includes('tabs')) throw new Error('NEO_TABS_UNAVAILABLE');
    const tabs = await client.callTool({ name: 'tabs', arguments: { action: 'list' } });
    return { status: 'completed', tool_names: toolNames, tab_count: countTabs(tabs) };
  } catch (err) {
    const code = err?.message;
    return { status: 'failed', error_code: ['NEO_URL_INVALID', 'NEO_TABS_UNAVAILABLE', 'NEO_RESPONSE_INVALID'].includes(code) ? code : 'NEO_UNAVAILABLE' };
  } finally {
    await client?.close?.().catch(() => {});
  }
}
