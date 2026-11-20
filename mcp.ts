// MCP: JSON-RPC 2.0 over Streamable HTTP at /mcp. Modern era first
// (server/discover, no handshake), with the legacy initialize fallback. The six
// tools the suite requires map straight onto the same store the REST surface uses.

import { VIEWER } from './scenario.ts';
import { STORE } from './store.ts';
import { isRecord, jsonRes, type Req, type Res } from './http.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    structuredContent: isRecord(data) ? data : { result: data },
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const out: Record<string, unknown> = { ...args };
  // The suite may spell arguments with synonyms; map them to the canonical names.
  const aliases: Record<string, string> = {
    owner_login: 'owner',
    repository: 'repo',
    repository_name: 'repo',
    repo_name: 'repo',
    issue_number: 'pull_number',
    number: 'pull_number',
    pr_number: 'pull_number',
  };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (out[canonical] === undefined && out[alias] !== undefined) out[canonical] = out[alias];
  }
  if (typeof out.repo === 'string' && (out.repo as string).includes('/')) {
    const [ownerPart, repoPart] = (out.repo as string).split('/', 2);
    if (out.owner === undefined && ownerPart !== undefined) out.owner = ownerPart;
    out.repo = repoPart;
  }
  return out;
}

function findRepo(owner: unknown, repo: unknown): ReturnType<typeof STORE.getRepo> {
  if (typeof owner !== 'string' || typeof repo !== 'string') return undefined;
  const found = STORE.getRepo(owner, repo);
  if (found === undefined || found.owner !== VIEWER.login) return undefined;
  return found;
}

function callTool(name: string, rawArgs: unknown): Record<string, unknown> {
  const args = normalizeArgs(rawArgs);
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return toolError('Missing required argument: name');
      if (STORE.getRepo(VIEWER.login, repoName) !== undefined) return toolError(`Repository ${VIEWER.login}/${repoName} already exists`);
      const repo = STORE.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return toolResult({
        id: repo.databaseId,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
        default_branch: repo.defaultBranch,
        description: repo.description,
      });
    }
    case 'get_repo': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === undefined) return toolError('Repository not found');
      return toolResult({
        id: repo.databaseId,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
        default_branch: repo.defaultBranch,
        description: repo.description,
      });
    }
    case 'create_issue': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === undefined) return toolError('Repository not found');
      const title = args.title;
      if (typeof title !== 'string' || title === '') return toolError('Missing required argument: title');
      const issue = STORE.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}` });
    }
    case 'list_issues': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === undefined) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
      return toolResult({
        issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      });
    }
    case 'create_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === undefined) return toolError('Repository not found');
      const title = args.title;
      const head = args.head;
      const base = args.base;
      if (typeof title !== 'string' || title === '') return toolError('Missing required argument: title');
      if (typeof head !== 'string' || head === '') return toolError('Missing required argument: head');
      if (typeof base !== 'string' || base === '') return toolError('Missing required argument: base');
      const headSha = STORE.refCommit(repo, head);
      const baseSha = STORE.refCommit(repo, base);
      if (headSha === null || baseSha === null) return toolError('head or base branch does not exist');
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      const pull = existing ?? STORE.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      if (repo === undefined) return toolError('Repository not found');
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isInteger(pullNumber)) return toolError('Missing required argument: pull_number');
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.merged) return toolResult({ merged: true, sha: pull.mergeCommitSha, message: 'Already merged' });
      if (STORE.pullConflict(repo, pull)) return toolError('This branch has conflicts that must be resolved');
      const mergeOid = STORE.mergePull(repo, pull);
      if (mergeOid === null) return toolError('This branch has conflicts that must be resolved');
      return toolResult({ merged: true, sha: mergeOid, message: pull.title });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

function rpcResult(id: string | number | null | undefined, result: unknown, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    result,
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION }, ...meta },
  };
}

function rpcError(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
  };
}

function handleRpc(request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request: method is required');
  const params = isRecord(request.params) ? (request.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const version = requested !== undefined && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string') return rpcError(id, -32602, 'Missing required argument: name');
    const known = TOOLS.find((tool) => tool.name === name);
    if (known === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const result = callTool(name, params.arguments);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(req: Req): Res {
  if (req.method === 'GET') return jsonRes(405, { error: 'Method not allowed' });
  if (req.method === 'DELETE') return jsonRes(200, {});
  if (req.method !== 'POST') return jsonRes(405, { error: 'Method not allowed' });
  let body: unknown;
  try {
    body = req.json();
  } catch {
    return jsonRes(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!isRecord(body)) {
    return jsonRes(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const request = body as JsonRpcRequest;
  if (request.jsonrpc !== undefined && request.jsonrpc !== '2.0') {
    return jsonRes(400, { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const response = handleRpc(request);
  if (response === null) return { status: 202, body: '', contentType: 'application/json', headers: {} };
  return jsonRes(200, response);
}

