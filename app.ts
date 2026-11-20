// The HTTP server: routing, auth, and the git smart-HTTP endpoints. REST, GraphQL
// and MCP live in their own modules and share one in-memory store.
//
// Auth: the suite presents `Authorization: Bearer <token>` where the token is the
// process's MAKEFUN_SHOP_TOKEN. A request without a matching token is 401; the
// only unauthenticated route is /healthz. The token is a credential, not an
// identity: the owner in every path is the scenario viewer, derived from the
// suite's fixed public seed (see scenario.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { STORE } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  jsonError,
  jsonRes,
  parseJsonBody,
  type Req,
  type Res,
} from './http.ts';
import {
  applyPush,
  fetchResponse,
  lsRefs,
  parsePushBody,
  parseV2Request,
  pushResponse,
  receiveAdvertisement,
  v0Advertisement,
  v2Advertisement,
  type FetchRequest,
} from './gitproto.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

class MalformedJsonError extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

function isAuthenticated(headers: Headers): boolean {
  const token = bearerToken(headers);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function gitRepoFromPath(segments: string[]): { owner: string; name: string } | null {
  if (segments.length < 2) return null;
  const owner = segments[0] as string;
  const repoPart = segments[1] as string;
  if (!repoPart.endsWith('.git')) return null;
  return { owner, name: repoPart.slice(0, -'.git'.length) };
}

function handleGitInfoRefs(req: Req, owner: string, name: string): Res {
  const repo = STORE.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return jsonError(404, 'Not Found');
  const service = req.url.searchParams.get('service');
  if (service === 'git-upload-pack') {
    const protocol = req.headers.get('git-protocol');
    const body = protocol === 'version=2' ? v2Advertisement(repo) : v0Advertisement(repo);
    return { status: 200, body, contentType: 'application/x-git-upload-pack-advertisement', headers: {} };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, body: receiveAdvertisement(repo), contentType: 'application/x-git-receive-pack-advertisement', headers: {} };
  }
  return jsonError(400, 'service must be git-upload-pack or git-receive-pack');
}

function handleGitUploadPack(req: Req, owner: string, name: string): Res {
  const repo = STORE.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return jsonError(404, 'Not Found');
  let command;
  try {
    command = parseV2Request(req.body);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : 'malformed pkt-line request');
  }
  if (command.command === 'ls-refs') {
    const args = command.args;
    const body = lsRefs(repo, {
      peel: args.includes('peel'),
      symrefs: args.includes('symrefs'),
      unborn: args.includes('unborn'),
      prefixes: args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length)),
    });
    return { status: 200, body, contentType: 'application/x-git-upload-pack-result', headers: {} };
  }
  if (command.command === 'fetch') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [] };
    for (const arg of command.args) {
      if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) request.deepen = Number(arg.slice(7).trim());
    }
    const body = fetchResponse(repo, request);
    return { status: 200, body, contentType: 'application/x-git-upload-pack-result', headers: {} };
  }
  return jsonError(400, `unsupported command ${command.command}`);
}

function handleGitReceivePack(req: Req, owner: string, name: string): Res {
  const repo = STORE.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return jsonError(404, 'Not Found');
  let parsed;
  try {
    parsed = parsePushBody(req.body);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : 'malformed push');
  }
  const result = applyPush(repo, parsed.commands, parsed.pack);
  return { status: 200, body: pushResponse(result), contentType: 'application/x-git-receive-pack-result', headers: {} };
}

function dispatch(req: Req): Res {
  const segments = req.segments;

  if (req.pathname === '/healthz') {
    if (req.method !== 'GET') return jsonError(404, 'Not Found');
    return jsonRes(200, { ok: true });
  }

  if (!isAuthenticated(req.headers)) return jsonError(401, 'Unauthorized');

  if (req.pathname === '/api/graphql' || req.pathname.startsWith('/api/graphql/')) {
    return handleGraphQL(req);
  }
  if (req.pathname === '/mcp' || req.pathname.startsWith('/mcp/')) {
    return handleMcp(req);
  }
  if (req.pathname.startsWith('/api/v3')) {
    return handleRest(req);
  }

  const git = gitRepoFromPath(segments);
  if (git !== null && segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    if (req.method !== 'GET') return jsonError(404, 'Not Found');
    return handleGitInfoRefs(req, git.owner, git.name);
  }
  if (git !== null && segments.length === 3 && segments[2] === 'git-upload-pack') {
    if (req.method !== 'POST') return jsonError(404, 'Not Found');
    return handleGitUploadPack(req, git.owner, git.name);
  }
  if (git !== null && segments.length === 3 && segments[2] === 'git-receive-pack') {
    if (req.method !== 'POST') return jsonError(404, 'Not Found');
    return handleGitReceivePack(req, git.owner, git.name);
  }

  return jsonError(404, 'Not Found');
}

export function createApp(): Server {
  const server = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    try {
      const body = await readBody(nodeReq);
      const url = new URL(nodeReq.url ?? '/', `http://${nodeReq.headers.host ?? '127.0.0.1'}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(nodeReq.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value !== undefined) headers.set(key, value);
      }
      const pathname = url.pathname;
      const segments = pathname
        .split('/')
        .filter((part) => part !== '')
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        });
      let parsedJson: unknown = null;
      let jsonFailed = false;
      const isJsonRoute = pathname.startsWith('/api/v3') || pathname.startsWith('/api/graphql') || pathname === '/mcp';
      if (isJsonRoute && body.length > 0) {
        try {
          parsedJson = parseJsonBody(body);
        } catch {
          jsonFailed = true;
        }
      }
      const req: Req = {
        method: nodeReq.method ?? 'GET',
        url,
        pathname,
        segments,
        headers,
        body,
        viewer: VIEWER.login,
        json: () => {
          if (jsonFailed) throw new MalformedJsonError('Request body must be valid JSON');
          return parsedJson;
        },
      };
      let result: Res;
      try {
        result = dispatch(req);
      } catch (error) {
        if (error instanceof MalformedJsonError) {
          result = pathname === '/mcp'
            ? jsonRes(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
            : jsonError(400, 'Request body must be valid JSON');
        } else {
          console.error('[entry] handler error:', error instanceof Error ? error.stack ?? error.message : String(error));
          result = jsonError(500, 'Internal Server Error');
        }
      }
      const payload = typeof result.body === 'string' ? Buffer.from(result.body, 'utf8') : result.body;
      nodeRes.writeHead(result.status, {
        'content-type': result.contentType,
        'content-length': payload.length,
        ...result.headers,
      });
      nodeRes.end(payload);
    } catch (error) {
      console.error('[entry] request error:', error instanceof Error ? error.stack ?? error.message : String(error));
      try {
        nodeRes.writeHead(500, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ message: 'Internal Server Error' }));
      } catch {
        // The response is already gone; nothing more to do.
      }
    }
  });
  return server;
}
