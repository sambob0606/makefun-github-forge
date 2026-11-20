// mcp.ts — the Model Context Protocol surface (POST /mcp).
//
// JSON-RPC 2.0 over plain application/json. Implements the modern era the
// suite speaks (2026-07-28 `server/discover`) plus the legacy `initialize`
// handshake as a fallback. Tool results always carry both a text JSON
// payload and `structuredContent`, so either reading of a result works.

import { VIEWER, globalId, repos } from './store.ts';
import {
  createIssue,
  createPull,
  createRepo,
  getPull,
  isError,
  issueJson,
  listIssues,
  listPulls,
  mergePull,
  pullJson,
  repoJson,
  type ServiceError,
} from './service.ts';
import { getRepo, type Repo } from './store.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpResponse {
  status: number;
  json?: unknown;
  empty?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch (the branch with the changes).' },
        base: { type: 'string', description: 'The base branch (the branch to merge into).' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The pull request number to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function resolveRepoParam(args: Record<string, unknown>): Repo | ServiceError {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login) return { status: 404, message: `Repository ${owner}/${repo} not found` };
  const found = getRepo(owner, repo);
  if (found === undefined) return { status: 404, message: `Repository ${owner}/${repo} not found` };
  return found;
}

function missingArg(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') return required;
  }
  return null;
}

function callTool(name: string, rawArgs: unknown): Record<string, unknown> {
  const tool = TOOLS.find((item) => item.name === name);
  if (tool === undefined) {
    return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  // Synonyms the caller may use for the documented argument names.
  if (name === 'merge_pull_request' && args.pull_number === undefined) {
    if (typeof args.pullNumber === 'number') args.pull_number = args.pullNumber;
    else if (typeof args.number === 'number') args.pull_number = args.number;
  }
  if (name === 'get_issue' && args.issue_number === undefined) {
    if (typeof args.issueNumber === 'number') args.issue_number = args.issueNumber;
    else if (typeof args.number === 'number') args.issue_number = args.number;
  }
  const missing = missingArg(tool, args);
  if (missing !== null) {
    return toolError(`Missing required argument: ${missing}`);
  }
  switch (name) {
    case 'create_repo': {
      const created = createRepo(String(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
      if (isError(created)) return toolError(created.message);
      const view = repoJson(created);
      return toolResult({ id: view.id, name: view.name, full_name: view.full_name, private: view.private, default_branch: view.default_branch, html_url: view.html_url });
    }
    case 'get_repo': {
      const repo = resolveRepoParam(args);
      if (isError(repo)) return toolError(repo.message);
      const view = repoJson(repo);
      return toolResult({ id: view.id, name: view.name, full_name: view.full_name, private: view.private, default_branch: view.default_branch, description: view.description, html_url: view.html_url });
    }
    case 'list_repos': {
      const list = [...repos.values()].sort((a, b) => a.seq - b.seq);
      return toolResult({ repositories: list.map((repo) => ({ name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.isPrivate, default_branch: repo.defaultBranch })) });
    }
    case 'create_issue': {
      const repo = resolveRepoParam(args);
      if (isError(repo)) return toolError(repo.message);
      const created = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if (isError(created)) return toolError(created.message);
      const view = issueJson(repo, created);
      return toolResult({ id: view.id, number: view.number, title: view.title, body: view.body, state: view.state, html_url: view.html_url });
    }
    case 'list_issues': {
      const repo = resolveRepoParam(args);
      if (isError(repo)) return toolError(repo.message);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = listIssues(repo, state, 'created', 'desc');
      return toolResult({ issues: list.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })) });
    }
    case 'get_issue': {
      const repo = resolveRepoParam(args);
      if (isError(repo)) return toolError(repo.message);
      const issue = repo.issues.find((item) => item.number === (args.issue_number as number));
      if (issue === undefined) return toolError(`Issue ${String(args.issue_number)} not found`);
      const view = issueJson(repo, issue);
      return toolResult({ id: view.id, number: view.number, title: view.title, body: view.body, state: view.state, html_url: view.html_url });
    }
    case 'create_pull_request': {
      const repo = resolveRepoParam(args);
      if (isError(repo)) return toolError(repo.message);
      const created = createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      if (isError(created)) return toolError(created.message);
      const view = pullJson(repo, created);
      return toolResult({ id: view.id, number: view.number, title: view.title, body: view.body, state: view.state, head: { ref: (view.head as { ref: string }).ref }, base: { ref: (view.base as { ref: string }).ref }, html_url: view.html_url });
    }
    case 'list_pull_requests': {
      const repo = resolveRepoParam(args);
      if (isError(repo)) return toolError(repo.message);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = listPulls(repo, state);
      return toolResult({ pull_requests: list.map((pull) => ({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, merged: pull.merged, head: pull.headRef, base: pull.baseRef })) });
    }
    case 'merge_pull_request': {
      const repo = resolveRepoParam(args);
      if (isError(repo)) return toolError(repo.message);
      const pull = getPull(repo, args.pull_number as number);
      if (pull === undefined) return toolError(`Pull request ${String(args.pull_number)} not found`);
      const merged = mergePull(repo, pull);
      if (isError(merged)) return toolError(merged.message);
      return toolResult({ merged: true, sha: merged.sha, message: merged.message, number: pull.number });
    }
    default:
      return toolError(`Tool ${name} is not implemented`);
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function handleOne(request: McpRequest): { response: Record<string, unknown> | null; status: number } {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { response: null, status: 202 };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      response: rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    return {
      status: 200,
      response: rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge. Use the tools to create repositories, issues and pull requests.',
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, response: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    // A module-level constant: two calls serialize byte-identically.
    return { status: 200, response: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const result = callTool(toolName, params.arguments);
    if ('__rpcError' in result) {
      const error = result.__rpcError as { code: number; message: string };
      return { status: 200, response: rpcError(id, error.code, error.message) };
    }
    return { status: 200, response: rpcResult(id, result) };
  }
  return { status: 200, response: rpcError(id, -32601, `Method not found: ${method}`) };
}

/**
 * Handle a parsed JSON body for POST /mcp. Returns the HTTP status and the
 * JSON-RPC response (null for a notification, which answers 202 empty).
 */
export function handleMcp(body: unknown): McpResponse {
  if (body === null || typeof body !== 'object') {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: expected a JSON-RPC object' } } };
  }
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const item of body) {
      const handled = handleOne(item as McpRequest);
      if (handled.response !== null) results.push(handled.response);
    }
    return { status: 200, json: results };
  }
  const handled = handleOne(body as McpRequest);
  if (handled.response === null) return { status: 202, empty: true };
  return { status: handled.status, json: handled.response };
}

export { globalId };
