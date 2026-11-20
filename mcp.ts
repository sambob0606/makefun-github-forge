// mcp.ts — the Model Context Protocol surface of the forge (POST /mcp).
//
// JSON-RPC 2.0 over HTTP. The modern era negotiates through
// `server/discover` (revision 2026-07-28); the legacy `initialize` +
// `notifications/initialized` handshake works as a fallback. `tools/list`
// is a constant table, so two calls answer byte-identical lists. Tool calls
// act on the same store as REST and GraphQL, and every result carries both
// a text block (the JSON) and the same object as structuredContent.

import { ZERO_OID } from './gitcore.ts';
import {
  DEFAULT_AUTHOR,
  buildTree,
  diffTrees,
  getObject,
  makeCommit,
  mergeBase,
  parseCommit,
  threeWayMerge,
  type Issue,
  type Pull,
  type Store,
} from './store.ts';
import { issueObj, pullObj, repoObj, type Ctx, type Reply } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

/** The tool table: built once, returned verbatim on every tools/list. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
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
    description: 'Read one repository by owner and name.',
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
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
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
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown): Reply {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Reply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A tool result: a text block carrying the JSON plus the same structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Resolve owner/repo from the arguments, accepting a full_name fallback. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = str(args.owner);
  let repo = str(args.repo);
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const [o, r] = args.full_name.split('/');
    if (!owner) owner = o ?? '';
    if (!repo) repo = r ?? '';
  }
  return { owner, repo };
}

function missingArgs(args: Record<string, unknown>, required: string[]): string[] {
  return required.filter((key) => {
    const v = args[key];
    return v === undefined || v === null || v === '';
  });
}

// ---------------------------------------------------------------------------
// Tool implementations (all act on the shared store)
// ---------------------------------------------------------------------------

function doCreateRepo(store: Store, ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const name = str(args.name);
  const created = store.createRepo(
    ctx.viewer,
    name,
    str(args.description),
    'main',
    args.private === true,
  );
  if (!created) return toolError(`Repository ${ctx.viewer}/${name} already exists`);
  return toolResult(repoObj(created));
}

function doGetRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = resolveOwnerRepo(args);
  const found = store.getRepo(owner, repo);
  if (!found) return toolError(`Repository ${owner}/${repo} not found`);
  return toolResult(repoObj(found));
}

function doCreateIssue(store: Store, ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = resolveOwnerRepo(args);
  const found = store.getRepo(owner, repo);
  if (!found) return toolError(`Repository ${owner}/${repo} not found`);
  const seq = store.nextSeq();
  const issue: Issue = {
    id: found.nextIssue,
    number: found.nextIssue++,
    title: str(args.title),
    body: str(args.body),
    state: 'open',
    labels: [],
    user: ctx.viewer,
    createdSeq: seq,
    updatedSeq: seq,
    comments: [],
  };
  found.issues.push(issue);
  return toolResult(issueObj(found, issue));
}

function doListIssues(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = resolveOwnerRepo(args);
  const found = store.getRepo(owner, repo);
  if (!found) return toolError(`Repository ${owner}/${repo} not found`);
  const state = str(args.state, 'open');
  let list = [...found.issues];
  if (state !== 'all') list = list.filter((i) => i.state === state);
  list.sort((a, b) => b.createdSeq - a.createdSeq);
  const value = { issues: list.map((i) => issueObj(found, i)) };
  return toolResult(value);
}

function doCreatePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = resolveOwnerRepo(args);
  const found = store.getRepo(owner, repo);
  if (!found) return toolError(`Repository ${owner}/${repo} not found`);
  const head = str(args.head);
  const base = str(args.base, found.defaultBranch);
  const headSha = found.refs.get(`refs/heads/${head}`);
  const baseSha = found.refs.get(`refs/heads/${base}`);
  if (!headSha) return toolError(`Head branch ${head} does not exist`);
  if (!baseSha) return toolError(`Base branch ${base} does not exist`);
  const mb = mergeBase(found, baseSha, headSha);
  const mbTree = mb ? parseCommit(getObject(found, mb)!.data).tree : ZERO_OID;
  const headTree = parseCommit(getObject(found, headSha)!.data).tree;
  const files = diffTrees(found, mbTree, headTree);
  const { conflicts } = threeWayMerge(found, baseSha, headSha);
  const seq = store.nextSeq();
  const pull: Pull = {
    id: found.nextPull,
    number: found.nextPull++,
    title: str(args.title),
    body: str(args.body),
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergeSha: null,
    createdSeq: seq,
    updatedSeq: seq,
    files,
    mergeable: conflicts.length === 0,
    conflicts,
  };
  found.pulls.push(pull);
  return toolResult(pullObj(found, pull));
}

function doMergePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = resolveOwnerRepo(args);
  const found = store.getRepo(owner, repo);
  if (!found) return toolError(`Repository ${owner}/${repo} not found`);
  const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
  const pull = found.pulls.find((p) => p.number === number);
  if (!pull) return toolError(`Pull request #${number} not found`);
  if (pull.state !== 'open') return toolError('Pull request is not open');
  const baseCommit = found.refs.get(`refs/heads/${pull.baseRef}`);
  const headCommit = found.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseCommit || !headCommit) return toolError('Branch not found');
  const { files: mergedFiles, conflicts } = threeWayMerge(found, baseCommit, headCommit);
  if (conflicts.length > 0) return toolError('Merge conflict');
  const mergedTree = buildTree(found, mergedFiles);
  const seq = store.nextSeq();
  const mergeCommit = makeCommit(found, mergedTree, [baseCommit], `${pull.title} (#${pull.number})`, DEFAULT_AUTHOR, seq);
  found.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  pull.state = 'merged';
  pull.merged = true;
  pull.mergeSha = mergeCommit;
  pull.updatedSeq = seq;
  return toolResult(pullObj(found, pull));
}

function callTool(store: Store, ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = missingArgs(args, def.inputSchema.required);
  if (missing.length > 0) {
    return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo':
      return doCreateRepo(store, ctx, args);
    case 'get_repo':
      return doGetRepo(store, args);
    case 'create_issue':
      return doCreateIssue(store, ctx, args);
    case 'list_issues':
      return doListIssues(store, args);
    case 'create_pull_request':
      return doCreatePullRequest(store, args);
    case 'merge_pull_request':
      return doMergePullRequest(store, args);
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export function handleMcp(store: Store, ctx: Ctx): Reply {
  // A body that is not JSON is a parse error, HTTP 400.
  if (ctx.badJson) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const envelope = ctx.json;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const record = envelope as Record<string, unknown>;
  const id = (record.id ?? null) as JsonRpcId;
  const method = String(record.method ?? '');
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no reply.
  if (record.id === undefined) {
    return { status: 202, body: undefined };
  }

  if (method === 'server/discover') {
    return result(id, {
      supportedVersions: [PROTOCOL_VERSION],
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return result(id, {});
  }
  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = str(params.name);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, ctx, name, args);
    if ('__rpcError' in outcome) {
      const rpc = outcome.__rpcError as { code: number; message: string };
      return rpcError(id, rpc.code, rpc.message);
    }
    return result(id, outcome);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
