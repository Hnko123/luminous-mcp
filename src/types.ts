export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  LUMINOUS_ORIGIN_URL: string;
  LUMINOUS_AUTHORIZATION_URL: string;
  MCP_PUBLIC_URL: string;
  MCP_WORKERS_DEV_HOST?: string;
  MCP_HANDOFF_REQUEST_SECRET: string;
  MCP_HANDOFF_APPROVAL_SECRET: string;
  MCP_ORIGIN_ASSERTION_SECRET: string;
  MCP_CLIENT_MANAGEMENT_SECRET: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
}

export interface McpAuthProps extends Record<string, unknown> {
  userId: string;
  email: string;
  connectionId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
}

export interface McpActor {
  userId: string;
  email: string;
  connectionId: string;
  clientId: string;
  clientName: string;
  scopes: ReadonlySet<string>;
}

export function actorFromProps(props: McpAuthProps): McpActor {
  return {
    userId: String(props.userId),
    email: String(props.email).trim().toLowerCase(),
    connectionId: String(props.connectionId),
    clientId: String(props.clientId),
    clientName: String(props.clientName),
    scopes: new Set(props.scopes.map(String)),
  };
}
