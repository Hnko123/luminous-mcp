import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { callNeoTool, testNeoConnection, validateNeoUrl } from './neo.js';

const configDir = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'LuminousNeoAgent');
const configPath = path.join(configDir, 'config.json');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function powershell(script, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(stderr.trim() || 'DPAPI failed')));
    child.stdin.end(input);
  });
}

async function setup() {
  if (process.platform !== 'win32') throw new Error('This agent is for Windows.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const baseUrl = (await rl.question('Luminous URL [https://luminousluxurycrafts.com.tr]: ')).trim() || 'https://luminousluxurycrafts.com.tr';
    const origin = new URL(baseUrl);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('HTTPS Luminous origin required');
    const neoUrl = (await rl.question('Neo MCP URL (copy from Neo connection screen): ')).trim();
    validateNeoUrl(neoUrl);
    const token = (await rl.question('One-time device token from Luminous profile: ')).trim();
    if (!/^neo_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid device token');
    const encryptedToken = await powershell('$s=[Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString', token);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ baseUrl: origin.origin, neoUrl, encryptedToken }, null, 2), { mode: 0o600 });
    console.log(`Configured. Start with: npm start`);
  } finally { rl.close(); }
}

async function api(config, token, method, route, body) {
  const response = await fetch(`${config.baseUrl}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('DEVICE_REVOKED');
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function run() {
  if (process.platform !== 'win32') throw new Error('This agent is for Windows.');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const token = await powershell('$s=[Console]::In.ReadToEnd().Trim() | ConvertTo-SecureString; [System.Net.NetworkCredential]::new("",$s).Password', config.encryptedToken);
  validateNeoUrl(config.neoUrl);
  while (true) {
    try {
      const { job } = await api(config, token, 'POST', '/api/integrations/mcp/neo/agent/claim');
      if (job) {
        const operation = job.kind === 'neo_connection_test'
          ? testNeoConnection(config.neoUrl)
          : job.kind === 'neo_tool_call'
            ? callNeoTool(config.neoUrl, job.toolName, job.arguments)
            : Promise.resolve({ status: 'failed', error_code: 'UNKNOWN_JOB_TYPE' });
        const result = await Promise.race([operation, delay(90_000).then(() => ({ status: 'failed', error_code: 'NEO_TIMEOUT' }))]);
        await api(config, token, 'POST', `/api/integrations/mcp/neo/agent/jobs/${encodeURIComponent(job.id)}/complete`, { lease_id: job.leaseId, ...result });
      }
      await delay(job ? 1000 : 10_000);
    } catch (err) {
      if (err.message === 'DEVICE_REVOKED') { console.error('Device authorization revoked. Stopping.'); return; }
      console.error(`Connection retry: ${err.message}`);
      await delay(10_000);
    }
  }
}

if (process.argv[2] === 'setup') await setup();
else if (process.argv[2] === 'run') await run();
else console.log('Usage: node src/index.js setup|run');
