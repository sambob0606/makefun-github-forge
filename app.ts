// app.ts — the HTTP server: auth, routing, and response framing.
//
// Every route except /healthz requires the bearer token from
// MAKEFUN_SHOP_TOKEN. A wrong or missing token is a 401 with a JSON body;
// an unknown owner or repo is a 404, never a 403. Every response carries
// X-GitHub-Request-Id; REST responses also carry X-OAuth-Scopes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER, SHOP_TOKEN, allocRequestId, getRepo } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  infoRefsBody,
  lsRefsResponse,
  parseLsRefsRequest,
  parseReceivePackRequest,
  parseV0FetchRequest,
  parseV2FetchRequest,
  applyReceivePack,
  receivePackResponse,
  v0FetchResponse,
  v2FetchResponse,
} from './gitproto.ts';

const MAX_BODY_BYTES = 100 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': allocRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': allocRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'X-GitHub-Request-Id': allocRequestId() });
  res.end();
}

function badCredentials(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

/** The bearer token a request carries, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return false;
  const token = bearerToken(req);
  return token !== null && token === SHOP_TOKEN;
}

interface GitRoute {
  owner: string;
  repo: string;
  tail: string;
}

function parseGitRoute(pathname: string): GitRoute | null {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 3) return null;
  const [owner, repoWithSuffix, ...tail] = segments as [string, string, ...string[]];
  // The git client addresses repos as <owner>/<repo>.git.
  const repo = repoWithSuffix.endsWith('.git') ? repoWithSuffix.slice(0, -'.git'.length) : repoWithSuffix;
  return { owner, repo, tail: tail.join('/') };
}

export function createAppServer(): Server {
  return createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      // Never crash the server on a malformed request.
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : 'Internal server error';
      sendJson(res, 500, { message });
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Liveness probe, no auth.
  if (pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (!authorized(req)) {
    badCredentials(res);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    let body: unknown = null;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8')) as unknown;
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const result = handleRest({ method, segments, query: url.searchParams, body, origin });
    if (result.empty === true) {
      sendEmpty(res, result.status);
      return;
    }
    sendJson(res, result.status, result.json ?? {}, {
      'X-OAuth-Scopes': 'repo, user',
      ...(result.headers ?? {}),
    });
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
        return;
      }
    }
    sendJson(res, 200, executeGraphQL(body));
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        body = null;
      }
    }
    const result = handleMcp(body);
    if (result.empty === true) {
      sendEmpty(res, result.status);
      return;
    }
    sendJson(res, result.status, result.json ?? {});
    return;
  }

  // Git smart HTTP.
  const gitRoute = parseGitRoute(pathname);
  if (gitRoute !== null && gitRoute.owner === VIEWER.login) {
    const repo = getRepo(gitRoute.owner, gitRoute.repo);
    if (repo === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'X-GitHub-Request-Id': allocRequestId() });
      res.end('Not Found');
      return;
    }
    if (method === 'GET' && gitRoute.tail === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'X-GitHub-Request-Id': allocRequestId() });
        res.end('Bad Request: unknown service');
        return;
      }
      const wantV2 = req.headers['git-protocol'] === 'version=2';
      const body = infoRefsBody(repo, service, wantV2);
      sendBuffer(res, 200, body, `application/x-${service}-advertisement`);
      return;
    }
    if (method === 'POST' && gitRoute.tail === 'git-upload-pack') {
      const body = await readBody(req);
      const wantV2 = req.headers['git-protocol'] === 'version=2';
      try {
        const firstLine = body.subarray(0, Math.min(body.length, 64)).toString('utf8');
        if (wantV2 && firstLine.includes('command=ls-refs')) {
          const request = parseLsRefsRequest(body);
          sendBuffer(res, 200, lsRefsResponse(repo, request), 'application/x-git-upload-pack-result');
          return;
        }
        const response = wantV2 ? v2FetchResponse(repo, parseV2FetchRequest(body)) : v0FetchResponse(repo, parseV0FetchRequest(body));
        sendBuffer(res, 200, response, 'application/x-git-upload-pack-result');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'bad request';
        res.writeHead(400, { 'Content-Type': 'text/plain', 'X-GitHub-Request-Id': allocRequestId() });
        res.end(`Bad Request: ${message}`);
      }
      return;
    }
    if (method === 'POST' && gitRoute.tail === 'git-receive-pack') {
      const body = await readBody(req);
      try {
        const { commands, pack } = parseReceivePackRequest(body);
        const result = applyReceivePack(repo, commands, pack);
        sendBuffer(res, 200, receivePackResponse(result), 'application/x-git-receive-pack-result');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'bad request';
        res.writeHead(400, { 'Content-Type': 'text/plain', 'X-GitHub-Request-Id': allocRequestId() });
        res.end(`Bad Request: ${message}`);
      }
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}
