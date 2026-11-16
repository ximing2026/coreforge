// Git smart HTTP — implemented in the next step; a JSON 404 until then.

import type { Forge } from './store.ts';

export interface GitHttpRequest {
  method: string;
  owner: string;
  repo: string;
  tail: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitHttpReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function handleGitHttp(forge: Forge, req: GitHttpRequest): GitHttpReply {
  void forge;
  void req;
  return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from('{"message":"Not Found"}\n') };
}
