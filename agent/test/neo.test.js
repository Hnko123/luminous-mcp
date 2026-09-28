import test from 'node:test';
import assert from 'node:assert/strict';
import { countTabs, testNeoConnection, validateNeoUrl } from '../src/neo.js';

test('Neo URL stays on local MCP endpoint', () => {
  assert.equal(validateNeoUrl('http://127.0.0.1:9010/mcp').pathname, '/mcp');
  for (const url of ['https://example.com/mcp', 'http://192.168.1.1:9010/mcp', 'http://localhost:9010/other']) {
    assert.throws(() => validateNeoUrl(url));
  }
});

test('tab count handles structured and text result without forwarding tab data', () => {
  assert.equal(countTabs({ structuredContent: { tabs: [{ url: 'private' }, {}] } }), 2);
  assert.equal(countTabs({ structuredContent: { pages: [{ url: 'private' }] } }), 1);
  assert.equal(countTabs({ content: [{ type: 'text', text: '[{"url":"private"}]' }] }), 1);
});

test('connection test only calls tabs list', async () => {
  const calls = [];
  const result = await testNeoConnection('http://127.0.0.1:9010/mcp', async () => ({
    listTools: async () => ({ tools: [{ name: 'tabs' }, { name: 'snapshot' }] }),
    callTool: async (input) => { calls.push(input); return { structuredContent: { tabs: [{ url: 'private' }] } }; },
    close: async () => {},
  }));
  assert.deepEqual(calls, [{ name: 'tabs', arguments: { action: 'list' } }]);
  assert.deepEqual(result, { status: 'completed', tool_names: ['tabs', 'snapshot'], tab_count: 1 });
});

test('Neo offline yields bounded failure', async () => {
  const result = await testNeoConnection('http://127.0.0.1:9010/mcp', async () => { throw new Error('private local URL'); });
  assert.deepEqual(result, { status: 'failed', error_code: 'NEO_UNAVAILABLE' });
});
