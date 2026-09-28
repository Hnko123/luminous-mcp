import { McpServer } from "@modelcontextprotocol/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  createMcpHandler,
  type StatelessMcpHandler,
} from "agents/mcp/server";

import { createOAuthHandler } from "./oauth-handler";
import { registerLuminousTools } from "./tools";
import { actorFromProps, type Env, type McpAuthProps } from "./types";

const CANONICAL_HOST = "mcp.luminousluxurycrafts.com.tr";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export type LuminousMcpHandler = StatelessMcpHandler;

export function createLuminousMcpServer(
  env: Env,
  authProps?: McpAuthProps,
): McpServer {
  const server = new McpServer({
    name: "Luminous MCP",
    version: "0.1.0",
  });
  if (authProps) {
    registerLuminousTools(server, { env, actor: actorFromProps(authProps) });
  }
  return server;
}

function allowedHosts(env: Env): string[] {
  const workersDevHost = String(env.MCP_WORKERS_DEV_HOST ?? "").trim();
  return [
    ...LOCAL_HOSTS,
    CANONICAL_HOST,
    ...(workersDevHost.endsWith(".workers.dev") ? [workersDevHost] : []),
  ];
}

export function createLuminousMcpHandler(
  env: Env,
  authProps?: McpAuthProps,
): LuminousMcpHandler {
  return createMcpHandler(() => createLuminousMcpServer(env, authProps), {
    route: "/mcp",
    legacy: "stateless",
    responseMode: "json",
    allowedHostnames: allowedHosts(env),
    allowedOriginHostnames: allowedHosts(env),
    corsOptions: {
      origin: `https://${CANONICAL_HOST}`,
      methods: "POST, OPTIONS",
      headers: "Authorization, Content-Type, MCP-Protocol-Version",
    },
    ...(authProps ? { authContext: { props: authProps } } : {}),
  });
}

const apiHandler = {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const oauthContext = context as ExecutionContext & { props?: McpAuthProps };
    const props = oauthContext.props;
    if (!props) return new Response("Unauthorized", { status: 401 });
    const handler = createLuminousMcpHandler(env, props);
    return handler(request, env, context);
  },
};

const oauthHandler = createOAuthHandler();

export const worker = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: oauthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: [
    "tasks:create",
    "tasks:read:self",
    "orders:note:append",
    "offline_access",
  ],
  resourceMetadata: {
    resource: "https://mcp.luminousluxurycrafts.com.tr/mcp",
    authorization_servers: ["https://mcp.luminousluxurycrafts.com.tr"],
    scopes_supported: ["tasks:read:self"],
    bearer_methods_supported: ["header"],
    resource_name: "Luminous MCP",
  },
});

export default worker;
