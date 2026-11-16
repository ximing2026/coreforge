// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP, over one store.
// main.ts owns the entry <-> env lifecycle; this file is the server the suite drives.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGitHttp } from './src/githttp.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Decode one path segment; a malformed escape is left as-is rather than throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      requestSeq += 1;
      const requestId = `forge-${requestSeq}`;

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const authHeader = req.headers.authorization ?? '';
      const presented = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
      const authed = token !== '' && presented === token;

      const body = await readBody(req);

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const segments = path.split('/').filter((part) => part !== '').slice(2).map(decodeSegment);
        const isPublic = segments.length === 0 || segments[0] === 'meta';
        if (!isPublic && !authed) {
          sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
          return;
        }
        let parsed: unknown;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            parsed = undefined;
          }
        }
        const reply = handleRest(forge, {
          method,
          segments,
          query: url.searchParams,
          body: parsed,
          rawBody: body.toString('utf8'),
          baseUrl: `http://${req.headers.host ?? 'forge.invalid'}`,
        });
        if (reply.status === 204 || reply.body === undefined) {
          res.writeHead(reply.status, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.body, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (!authed) {
          sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
          return;
        }
        const reply = handleGraphql(forge, body.toString('utf8'));
        sendJson(res, reply.status, reply.body, { 'x-github-request-id': requestId });
        return;
      }

      // MCP.
      if (path === '/mcp') {
        const reply = await handleMcp(forge, {
          method,
          body: body.toString('utf8'),
          authed,
          headers: req.headers,
        });
        if (reply.body === undefined) {
          res.writeHead(reply.status, reply.headers ?? {});
          res.end();
          return;
        }
        const text = typeof reply.body === 'string' ? reply.body : `${JSON.stringify(reply.body)}\n`;
        res.writeHead(reply.status, {
          'content-type': reply.contentType ?? JSON_TYPE,
          'content-length': Buffer.byteLength(text),
          ...(reply.headers ?? {}),
        });
        res.end(text);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch !== null) {
        if (!authed) {
          res.writeHead(401, { 'content-type': JSON_TYPE, 'www-authenticate': 'Basic realm="forge"' });
          res.end(`${JSON.stringify({ message: 'Bad credentials' })}\n`);
          return;
        }
        const reply = handleGitHttp(forge, {
          method,
          owner: decodeSegment(gitMatch[1]),
          repo: decodeSegment(gitMatch[2]),
          tail: gitMatch[3] ?? '',
          query: url.searchParams,
          headers: req.headers,
          body,
        });
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      else res.end();
    });
  });
}
