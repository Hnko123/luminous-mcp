# Luminous Remote MCP

Luminous Remote MCP is the vendor-neutral Cloudflare Worker gateway for three
Luminous operations. Its canonical Streamable HTTP endpoint is:

`https://mcp.luminousluxurycrafts.com.tr/mcp`

The endpoint always uses OAuth. Users sign in to the normal Luminous PWA,
review the requesting client and scopes, and explicitly approve or deny the
connection. Do not paste a Luminous password, PWA token, Cloudflare credential,
or any other secret into an MCP client configuration.

## Supported tools

- `create_task` previews, confirms, and creates a task assigned to the signed-in user.
- `add_order_note` finds an accessible order by exact normalized buyer name, then previews, confirms, and appends a note.
- `list_my_tasks` lists only tasks assigned to the signed-in user.

Writes use a short-lived confirmation token and a stable request ID. A preview
does not modify Luminous. When a buyer name matches multiple accessible orders,
the user must select a returned candidate before a note can be previewed.

Example user prompts:

- `Yarın için “ürün fotoğraflarını kontrol et” görevi oluştur.`
- `Loska Geraldine siparişinin notuna “müşteri renk onayı verdi” ekle.`
- `Görevlerim neler?`

## Client setup

Every direct setup below points to the same URL and lets the client discover
OAuth. The browser approval page is the security boundary; no static bearer
token or custom authorization header belongs in these files.

### Gemini CLI

Merge this entry into `~/.gemini/settings.json`, restart Gemini CLI, then use
`/mcp` to connect and complete browser authorization.

```json
{
  "mcpServers": {
    "luminous": {
      "httpUrl": "https://mcp.luminousluxurycrafts.com.tr/mcp"
    }
  }
}
```

### Codex CLI and IDE extension

Codex shares MCP configuration between the CLI and IDE extension:

```sh
codex mcp add luminous --url https://mcp.luminousluxurycrafts.com.tr/mcp
codex mcp list
```

The equivalent `~/.codex/config.toml` entry is:

```toml
[mcp_servers.luminous]
url = "https://mcp.luminousluxurycrafts.com.tr/mcp"
```

When Codex first uses the server, finish the browser authorization flow.

### Claude Code

Add the remote HTTP server, verify it, and run `/mcp` inside Claude Code to
complete OAuth:

```sh
claude mcp add --transport http --scope user luminous https://mcp.luminousluxurycrafts.com.tr/mcp
claude mcp get luminous
```

### VS Code clients

For VS Code with GitHub Copilot Agent mode, place this in `.vscode/mcp.json` or
the user MCP configuration. VS Code opens the OAuth browser flow on first use.

```json
{
  "servers": {
    "luminous": {
      "type": "http",
      "url": "https://mcp.luminousluxurycrafts.com.tr/mcp"
    }
  }
}
```

Other VS Code extensions are compatible only if they support remote
Streamable HTTP plus OAuth discovery. If they only launch local processes, use
the explicit bridge fallback below.

### Antigravity

Open the Agent panel, choose **MCP Servers → Manage MCP Servers → View raw
config**, and merge this into the global or workspace `mcp_config.json`:

```json
{
  "mcpServers": {
    "luminous": {
      "serverUrl": "https://mcp.luminousluxurycrafts.com.tr/mcp"
    }
  }
}
```

Reload the MCP manager and choose Authenticate. Antigravity versions differ;
use a current release with remote OAuth support or the bridge fallback.

### LM Studio

LM Studio 0.3.17 or newer supports remote MCP servers. In the Program panel,
choose **Install → Edit mcp.json** and merge:

```json
{
  "mcpServers": {
    "luminous": {
      "url": "https://mcp.luminousluxurycrafts.com.tr/mcp"
    }
  }
}
```

LM Studio opens the Luminous authorization page. The local model's ability to
choose tools and fill arguments varies by model; access itself is not limited
to a model vendor.

### Explicit `mcp-remote` fallback

Use this only for a host that cannot connect to remote HTTP MCP directly. It
requires Node.js locally and starts the standard local bridge; Luminous still
performs browser OAuth and the bridge does not receive a manually copied PWA
token.

```json
{
  "mcpServers": {
    "luminous": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.luminousluxurycrafts.com.tr/mcp"
      ]
    }
  }
}
```

## Local development

Node.js 22 is required. From this directory:

```sh
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
npm ci
npm test
npm run typecheck
npm run dev
```

Wrangler reads non-secret local bindings from `wrangler.jsonc`. For isolated
local testing, create an untracked `.dev.vars` containing development-only
values and never copy production secret values into it. The required bindings
are:

- KV binding: `OAUTH_KV`
- variables: `LUMINOUS_ORIGIN_URL`, `LUMINOUS_AUTHORIZATION_URL`,
  `MCP_PUBLIC_URL`, and `MCP_WORKERS_DEV_HOST`
- Worker secrets: `MCP_HANDOFF_REQUEST_SECRET`,
  `MCP_HANDOFF_APPROVAL_SECRET`, `MCP_ORIGIN_ASSERTION_SECRET`,
  `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET`

The first three secrets have matching protected values at the Luminous origin.
Do not print, commit, paste into tickets, or include any secret value in test
logs. The placeholder KV ID and invalid staging host in the committed Wrangler
file intentionally keep deployment fail-closed.

## MCP Inspector verification

Start the official MCP Inspector locally:

```sh
npx -y @modelcontextprotocol/inspector
```

In its browser UI choose Streamable HTTP and enter the canonical endpoint.
Complete OAuth as a dedicated pilot user. Confirm that discovery exposes
exactly `create_task`, `add_order_note`, and `list_my_tasks`. Preview each write
first, inspect the proposed action, and approve only dedicated test records.

## Staging acceptance

Deployment is a separate, explicitly approved operation. Before staging,
replace the Wrangler KV placeholder and invalid `MCP_WORKERS_DEV_HOST` with the
provisioned staging values, store secrets with `wrangler secret put`, and
confirm Cloudflare Access permits only the Worker service identity at the
origin integration routes.

Verify in this order:

1. OAuth discovery and browser denial without any write.
2. Successful authorization for one dedicated pilot user.
3. `list_my_tasks` returns only that user's assignments.
4. A `create_task` preview makes no change; explicit confirmation creates one task.
5. An `add_order_note` preview makes no change; explicit confirmation appends once.
6. An ambiguous buyer name performs no write.
7. Revocation blocks later calls and refresh attempts.
8. Repeated request IDs do not duplicate writes.
9. Unauthenticated direct Worker and origin requests fail.

Use only test users, test tasks, and test orders during staging.

## Monitoring and revocation

Users revoke access in **Luminous → Profile → AI Asistan Bağlantıları**. They
may also clear the client's local authentication. Server-side revocation is
authoritative, so clearing only a local client is not a substitute for the
Luminous action.

During an approved staging or production window, follow Worker events with:

```sh
npx wrangler tail luminous-mcp
```

Logs may include correlation IDs, tool names, status classes, and latency.
They must not include OAuth tokens, signed assertions, task/order content,
buyer names, note text, or Cloudflare Access credentials.

## Rollback

If authorization, existing PWA behavior, or origin health regresses:

1. Disable the custom MCP route or roll the Worker back to the last known-good deployment.
2. Revoke pilot connections and disable the Cloudflare Access service policy.
3. Remove the MCP origin variables through the established secret-management process.
4. Restart only `luminous-oms` in an approved window if origin variables changed.
5. Re-run PWA login, Tasks, Orders, health checks, and direct unauthenticated-denial checks.

Do not edit or restart PM2 merely to test local Worker code. Production rollout
requires the separate deployment checklist and explicit approval for the
Cloudflare account, zone, DNS, secrets, pilot users, and maintenance window.

## Client reference documentation

- [Codex remote MCP configuration](https://developers.openai.com/learn/docs-mcp)
- [Gemini CLI MCP configuration](https://codelabs.developers.google.com/google-workspace-mcp-gemini-cli)
- [Claude Code remote MCP and OAuth](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Antigravity MCP configuration](https://www.antigravity.google/docs/cli/mcp/)
- [LM Studio remote MCP and OAuth](https://lmstudio.ai/docs/integrations/mcp-remote)
