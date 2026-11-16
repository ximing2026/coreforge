// MCP — implemented after the git surface; a JSON-RPC error until then.

import type { Forge } from './store.ts';

export interface McpRequest {
  method: string;
  body: string;
  authed: boolean;
  headers: Record<string, string | string[] | undefined>;
}

export interface McpReply {
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export async function handleMcp(forge: Forge, req: McpRequest): Promise<McpReply> {
  void forge;
  if (!req.authed) return { status: 401, body: { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null } };
  return { status: 200, body: { jsonrpc: '2.0', error: { code: -32601, message: 'not implemented' }, id: null } };
}
