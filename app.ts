// app.ts — the HTTP server for the forge.
//
// One Store, one token, four surfaces: /healthz (no auth), the git
// smart-HTTP paths (a wrong token is rejected, a missing one is allowed),
// and /api/v3, /api/graphql and /mcp (a missing or wrong token is a 401).
// Every reply carries X-GitHub-Request-Id; REST replies also carry the
// OAuth scopes header. Bodies are collected in full before dispatch, so a
// malformed JSON body can be answered 400 without touching a handler.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type Ctx, type Reply } from './rest.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(store?: Store, token?: string) {
  const data = store ?? new Store();
  const expectedToken = token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] request failed: ${(err as Error).message}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, `req-${requestSeq}`);
      } else {
        res.destroy();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = `req-${++requestSeq}`;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, { message: 'Request body too large' }, id);
        return;
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }

    const ctx: Ctx = {
      method: req.method ?? 'GET',
      pathname: url.pathname,
      query: url.searchParams,
      headers,
      json: undefined,
      body,
      viewer: VIEWER_LOGIN,
      token: expectedToken || undefined,
      badJson: false,
    };

    if (ctx.pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, id);
      return;
    }

    // JSON bodies, parsed once for every handler that needs them.
    const isJsonBody =
      body.length > 0 &&
      (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'PATCH');
    if (isJsonBody) {
      const contentType = ctx.headers.get('content-type') ?? '';
      if (contentType.includes('application/json') || body[0] === 0x7b || body[0] === 0x5b) {
        try {
          ctx.json = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          ctx.badJson = true;
        }
      }
    }

    const isGitPath = /^\/[^/]+\/[^/]+\.git\//.test(ctx.pathname);
    if (!isGitPath && expectedToken !== '') {
      const auth = ctx.headers.get('authorization');
      if (auth !== `Bearer ${expectedToken}`) {
        if (ctx.pathname === '/mcp') {
          sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }, id);
        } else {
          sendJson(res, 401, { message: 'Bad credentials' }, id);
        }
        return;
      }
    }

    let reply: Reply | null = null;
    try {
      if (isGitPath) {
        reply = handleGit(data, ctx);
      } else if (ctx.pathname === '/api/graphql') {
        if (ctx.method !== 'POST') reply = { status: 405, body: { message: 'Method Not Allowed' } };
        else if (ctx.badJson) reply = { status: 400, body: { errors: [{ message: 'Request body is not valid JSON.' }] } };
        else reply = handleGraphQL(data, ctx);
      } else if (ctx.pathname === '/mcp') {
        if (ctx.method !== 'POST') reply = { status: 405, body: { message: 'Method Not Allowed' } };
        else reply = handleMcp(data, ctx);
      } else if (ctx.pathname.startsWith('/api/v3')) {
        if (ctx.badJson) reply = { status: 400, body: { message: 'Request body is not valid JSON.' } };
        else reply = handleRest(data, ctx);
      }
    } catch (err) {
      process.stderr.write(`[forge] handler threw: ${(err as Error).stack ?? (err as Error).message}\n`);
      reply = { status: 500, body: { message: 'Internal Server Error' } };
    }

    if (reply === null) {
      sendJson(res, 404, { message: 'Not Found' }, id);
      return;
    }
    sendReply(res, reply, id, ctx.pathname.startsWith('/api/v3'));
  }

  return server;
}

function sendReply(res: ServerResponse, reply: Reply, id: string, isRest: boolean): void {
  const headers: Record<string, string> = {
    'X-GitHub-Request-Id': id,
    ...(reply.headers ?? {}),
  };
  if (isRest) headers['X-OAuth-Scopes'] = 'repo, read:org';
  if (reply.buf !== undefined) {
    headers['Content-Type'] = reply.contentType ?? 'application/octet-stream';
    headers['Content-Length'] = String(reply.buf.length);
    res.writeHead(reply.status, headers);
    res.end(reply.buf);
    return;
  }
  if (reply.status === 204 || reply.body === undefined) {
    res.writeHead(reply.status, headers);
    res.end();
    return;
  }
  const text = reply.raw ?? JSON.stringify(reply.body);
  headers['Content-Type'] = reply.contentType ?? 'application/json';
  headers['Content-Length'] = String(Buffer.byteLength(text));
  res.writeHead(reply.status, headers);
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, value: unknown, id: string): void {
  sendReply(res, { status, body: value }, id, false);
}
