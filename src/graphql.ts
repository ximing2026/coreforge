// GraphQL v4 — implemented after the git surface; an errors reply until then.

import type { Forge } from './store.ts';

export interface GraphqlReply {
  status: number;
  body: unknown;
}

export function handleGraphql(forge: Forge, rawBody: string): GraphqlReply {
  void forge;
  void rawBody;
  return { status: 200, body: { errors: [{ message: 'not implemented' }] } };
}
