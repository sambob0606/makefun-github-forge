// graphql.ts — the GitHub GraphQL v4 surface (POST /api/graphql).
//
// A small recursive-descent parser plus resolvers over the same store the
// REST surface uses, so the two views can never disagree. Supports the
// documents the competition suite sends: viewer, repository (+ issue,
// issues, pullRequest, pullRequests connections), node, __type, and the
// createIssue / closeIssue / createPullRequest / mergePullRequest /
// addComment mutations. Unknown fields are reported in `errors` (HTTP 200),
// exactly as the suite expects. Batched bodies (JSON arrays) run in order.

import {
  VIEWER,
  globalId,
  parseGlobalId,
  repos,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  createIssue,
  createIssueComment,
  createPull,
  getIssue,
  getPull,
  isError,
  listPulls,
  mergePull,
  patchIssue,
  pullFiles,
  pullMergeable,
} from './service.ts';

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'variable'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push(value.includes('.') || value.includes('e') || value.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if (ch === '$') {
      i += 1;
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'variable', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export interface Selection {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selections: Selection[];
  /** Inline fragment type condition, or a fragment spread name. */
  fragment?: { kind: 'inline'; type: string | null } | { kind: 'spread'; name: string };
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

export interface GraphQLDocument {
  operations: Operation[];
  fragments: Map<string, { type: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): GraphQLDocument {
    const doc: GraphQLDocument = { operations: [], fragments: new Map() };
    while (this.peek() !== null) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const type = this.expectName();
        const selections = this.parseSelectionSet();
        doc.fragments.set(name, { type, selections });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next !== null && next.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalanced('(', ')');
        // Directives.
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
          this.next();
          this.expectName();
          if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalanced('(', ')');
        }
        const selections = this.parseSelectionSet();
        doc.operations.push({ kind: token.value as 'query' | 'mutation', name, selections });
      } else if (token.kind === 'punct' && token.value === '{') {
        const selections = this.parseSelectionSet();
        doc.operations.push({ kind: 'query', name: null, selections });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
      }
    }
    return doc;
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    for (;;) {
      const token = this.peek();
      if (token === null) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next !== null && next.kind === 'name' && next.value === 'on') {
        this.next();
        const type = this.expectName();
        const selections = this.parseSelectionSet();
        return { name: '', alias: null, args: {}, selections, fragment: { kind: 'inline', type } };
      }
      if (next !== null && next.kind === 'name') {
        const name = this.next().value;
        return { name: '', alias: null, args: {}, selections: [], fragment: { kind: 'spread', name } };
      }
      const selections = this.parseSelectionSet();
      return { name: '', alias: null, args: {}, selections, fragment: { kind: 'inline', type: null } };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    const maybeColon = this.peek();
    if (maybeColon !== null && maybeColon.kind === 'punct' && maybeColon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    const maybeParen = this.peek();
    if (maybeParen !== null && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      args = this.parseArguments();
    }
    // Directives (@skip/@include): parsed and ignored.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalanced('(', ')');
    }
    let selections: Selection[] = [];
    const maybeBrace = this.peek();
    if (maybeBrace !== null && maybeBrace.kind === 'punct' && maybeBrace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { name, alias, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    for (;;) {
      const token = this.peek();
      if (token === null) throw new Error('unterminated argument list');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number(token.value);
    if (token.kind === 'float') return Number(token.value);
    if (token.kind === 'variable') return { __var: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      for (;;) {
        const next = this.peek();
        if (next === null) throw new Error('unterminated list');
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          return list;
        }
        list.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      for (;;) {
        const next = this.peek();
        if (next === null) throw new Error('unterminated object');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return obj;
        }
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

export function parseGraphQL(source: string): GraphQLDocument {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, { type: string; selections: Selection[] }>;
  errors: Array<{ message: string }>;
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__var' in (value as Record<string, unknown>)) {
      const name = (value as { __var: string }).__var;
      return variables[name] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as { __enum: string }).__enum;
    }
    if (Array.isArray(value)) return value.map((item) => resolveVariables(item, variables));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = resolveVariables(item, variables);
    return out;
  }
  return value;
}

function argsOf(selection: Selection, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(selection.args)) out[key] = resolveVariables(value, ctx.variables);
  return out;
}

function enumValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function cursorSeq(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** A Relay-style connection over a seq-ordered list. */
function connection<T extends { seq: number }>(items: T[], args: Record<string, unknown>): { nodes: T[]; pageInfo: Record<string, unknown> } {
  const direction = args.direction === 'asc' ? 'asc' : 'desc';
  const sorted = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const afterSeq = cursorSeq(args.after);
  let window = sorted;
  if (afterSeq !== null) {
    window = sorted.filter((item) => (direction === 'asc' ? item.seq > afterSeq : item.seq < afterSeq));
  }
  const first = typeof args.first === 'number' ? args.first : window.length;
  const nodes = window.slice(0, first);
  const hasNextPage = window.length > nodes.length;
  return {
    nodes,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: afterSeq !== null,
      startCursor: nodes.length > 0 ? cursorFor((nodes[0] as T).seq) : null,
      endCursor: nodes.length > 0 ? cursorFor((nodes[nodes.length - 1] as T).seq) : null,
    },
  };
}

type TypeName = 'Query' | 'Mutation' | 'Repository' | 'Issue' | 'PullRequest' | 'User' | 'IssueComment' | 'PageInfo' | 'IssueConnection' | 'PullRequestConnection' | 'PullRequestFileConnection' | 'LabelConnection' | 'CommentConnection' | 'Ref' | 'Commit' | 'Type' | 'Field' | 'EnumValue' | 'CreateIssuePayload' | 'CloseIssuePayload' | 'CreatePullRequestPayload' | 'MergePullRequestPayload' | 'AddCommentPayload' | 'CommentEdge' | 'PullRequestFile';

interface TypedValue {
  type: TypeName;
  value: unknown;
  repo?: Repo;
}

/** Resolve a selection set against a typed value. */
function resolveFields(typed: TypedValue, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragment !== undefined) {
      if (selection.fragment.kind === 'spread') {
        const fragment = ctx.fragments.get(selection.fragment.name);
        if (fragment === undefined) {
          ctx.errors.push({ message: `Unknown fragment "${selection.fragment.name}".` });
          continue;
        }
        Object.assign(out, resolveFields(typed, fragment.selections, ctx));
        continue;
      }
      const type = selection.fragment.type;
      if (type === null || type === typed.type) {
        Object.assign(out, resolveFields(typed, selection.selections, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const result = resolveField(typed, selection, ctx);
    out[key] = result;
  }
  return out;
}

function unknownField(typed: TypedValue, selection: Selection, ctx: Ctx): null {
  ctx.errors.push({
    message: `Cannot query field "${selection.name}" on type "${typed.type}".`,
  });
  return null;
}

function resolveField(typed: TypedValue, selection: Selection, ctx: Ctx): unknown {
  const name = selection.name;
  if (name === '__typename') return typed.type;
  const args = argsOf(selection, ctx);
  switch (typed.type) {
    case 'Query':
      return resolveQueryField(typed, selection, args, ctx);
    case 'Mutation':
      return resolveMutationField(typed, selection, args, ctx);
    case 'Repository':
      return resolveRepositoryField(typed, selection, args, ctx);
    case 'Issue':
      return resolveIssueField(typed, selection, args, ctx);
    case 'PullRequest':
      return resolvePullRequestField(typed, selection, args, ctx);
    case 'User':
      return resolveUserField(typed, selection, args, ctx);
    case 'IssueComment':
      return resolveCommentField(typed, selection, args, ctx);
    case 'PageInfo':
      return resolveScalarFields(typed, selection, ctx);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection':
    case 'CommentConnection':
      return resolveConnectionField(typed, selection, args, ctx);
    case 'Ref':
      return resolveScalarFields(typed, selection, ctx);
    case 'Commit':
      return resolveScalarFields(typed, selection, ctx);
    case 'Type':
      return resolveTypeField(typed, selection, args, ctx);
    case 'Field':
    case 'EnumValue':
      return resolveScalarFields(typed, selection, ctx);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
      return resolvePayloadField(typed, selection, args, ctx);
    case 'CommentEdge':
      return resolveScalarFields(typed, selection, ctx);
    case 'PullRequestFile':
      return resolveScalarFields(typed, selection, ctx);
    default:
      return unknownField(typed, selection, ctx);
  }
}

/** A field on a plain record object (PageInfo, Ref, Commit, ...). */
function resolveScalarFields(typed: TypedValue, selection: Selection, ctx: Ctx): unknown {
  const record = typed.value as Record<string, unknown>;
  if (selection.name in record) {
    const value = record[selection.name];
    if (selection.selections.length > 0 && value !== null && typeof value === 'object') {
      return value;
    }
    return value;
  }
  return unknownField(typed, selection, ctx);
}

function resolveQueryField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const name = selection.name;
  if (name === 'viewer') {
    return resolveFields({ type: 'User', value: VIEWER }, selection.selections, ctx);
  }
  if (name === 'repository') {
    const owner = args.owner as string | undefined;
    const repoName = args.name as string | undefined;
    if (owner !== VIEWER.login) return null;
    const repo = repos.get(`${owner}/${repoName}`);
    if (repo === undefined) return null;
    return resolveFields({ type: 'Repository', value: repo }, selection.selections, ctx);
  }
  if (name === 'node') {
    const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
    if (parsed === null) return null;
    const [kind, id] = parsed;
    if (kind === 'Repository') {
      const repo = [...repos.values()].find((item) => item.id === id);
      if (repo === undefined) return null;
      return resolveFields({ type: 'Repository', value: repo }, selection.selections, ctx);
    }
    if (kind === 'Issue') {
      for (const repo of repos.values()) {
        const issue = repo.issues.find((item) => item.id === id);
        if (issue !== undefined) return resolveFields({ type: 'Issue', value: issue, repo }, selection.selections, ctx);
      }
      return null;
    }
    if (kind === 'PullRequest') {
      for (const repo of repos.values()) {
        const pull = repo.pulls.find((item) => item.id === id);
        if (pull !== undefined) return resolveFields({ type: 'PullRequest', value: pull, repo }, selection.selections, ctx);
      }
      return null;
    }
    if (kind === 'User' && id === VIEWER.id) {
      return resolveFields({ type: 'User', value: VIEWER }, selection.selections, ctx);
    }
    return null;
  }
  if (name === '__type') {
    const typeName = args.name as string | undefined;
    const info = TYPE_INFO[typeName ?? ''];
    if (info === undefined) return null;
    return resolveFields({ type: 'Type', value: info }, selection.selections, ctx);
  }
  if (name === '__schema') {
    return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
  }
  return unknownField(typed, selection, ctx);
}

const TYPE_INFO: Record<string, { name: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    name: 'Issue',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
    enumValues: [],
  },
  PullRequest: {
    name: 'PullRequest',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'author'],
    enumValues: [],
  },
  Repository: {
    name: 'Repository',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  SearchType: {
    name: 'SearchType',
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  },
  IssueState: {
    name: 'IssueState',
    fields: [],
    enumValues: ['OPEN', 'CLOSED'],
  },
  PullRequestState: {
    name: 'PullRequestState',
    fields: [],
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  User: {
    name: 'User',
    fields: ['id', 'databaseId', 'login', 'name', 'email'],
    enumValues: [],
  },
};

function resolveTypeField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const info = typed.value as { name: string; fields: string[]; enumValues: string[] };
  if (selection.name === 'name') return info.name;
  if (selection.name === 'fields') {
    const fields = info.fields.map((name) => ({ name }));
    if (selection.selections.length > 0) {
      return fields.map((field) => resolveFields({ type: 'Field', value: field }, selection.selections, ctx));
    }
    return fields;
  }
  if (selection.name === 'enumValues') {
    const values = info.enumValues.map((name) => ({ name }));
    if (selection.selections.length > 0) {
      return values.map((value) => resolveFields({ type: 'EnumValue', value }, selection.selections, ctx));
    }
    return values;
  }
  if (selection.name === 'kind') return info.enumValues.length > 0 ? 'ENUM' : 'OBJECT';
  return unknownField(typed, selection, ctx);
}

function resolveRepositoryField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const repo = typed.value as Repo;
  switch (selection.name) {
    case 'id':
      return globalId('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'description':
      return repo.description;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'owner':
      return resolveFields({ type: 'User', value: VIEWER }, selection.selections, ctx);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      const ref = { name: repo.defaultBranch, target: { oid: tip } };
      return resolveFields({ type: 'Ref', value: ref }, selection.selections, ctx);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const issue = getIssue(repo, args.number as number);
      if (issue === undefined) return null;
      return resolveFields({ type: 'Issue', value: issue, repo }, selection.selections, ctx);
    }
    case 'issues': {
      const states = (args.states as unknown[] | undefined)?.map((state) => enumValue(state)?.toLowerCase()) ?? null;
      let items = repo.issues;
      if (states !== null) items = items.filter((issue) => states.includes(issue.state));
      const orderBy = args.orderBy as { field?: unknown; direction?: unknown } | undefined;
      const direction = enumValue(orderBy?.direction)?.toLowerCase() === 'asc' ? 'asc' : 'desc';
      const conn = connection(items, { ...args, direction });
      return resolveFields({ type: 'IssueConnection', value: conn, repo }, selection.selections, ctx);
    }
    case 'pullRequests': {
      const states = (args.states as unknown[] | undefined)?.map((state) => enumValue(state)?.toLowerCase()) ?? null;
      let items = repo.pulls;
      if (states !== null) items = items.filter((pull) => states.includes(pull.state));
      const conn = connection(items, args);
      return resolveFields({ type: 'PullRequestConnection', value: conn, repo }, selection.selections, ctx);
    }
    case 'pullRequest': {
      const pull = getPull(repo, args.number as number);
      if (pull === undefined) return null;
      return resolveFields({ type: 'PullRequest', value: pull, repo }, selection.selections, ctx);
    }
    default:
      return unknownField(typed, selection, ctx);
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssueField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const issue = typed.value as Issue;
  switch (selection.name) {
    case 'id':
      return globalId('Issue', issue.id);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issueState(issue);
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'closedAt':
      return issue.closedAt;
    case 'author':
      return resolveFields({ type: 'User', value: VIEWER }, selection.selections, ctx);
    case 'labels': {
      const conn = { nodes: issue.labels.map((label) => ({ name: label.name, color: label.color })), pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      return resolveFields({ type: 'LabelConnection', value: conn, repo: typed.repo }, selection.selections, ctx);
    }
    case 'comments': {
      const conn = { nodes: issue.comments, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      return resolveFields({ type: 'CommentConnection', value: conn, repo: typed.repo }, selection.selections, ctx);
    }
    default:
      return unknownField(typed, selection, ctx);
  }
}

function resolvePullRequestField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const pull = typed.value as Pull;
  const repo = typed.repo as Repo;
  switch (selection.name) {
    case 'id':
      return globalId('PullRequest', pull.id);
    case 'databaseId':
      return pull.id;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return pull.state !== 'open' ? 'UNKNOWN' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRefOid':
      return pull.headSha;
    case 'baseRefOid':
      return pull.baseSha;
    case 'mergedAt':
      return pull.mergedAt;
    case 'mergeCommit':
      return pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha };
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'author':
      return resolveFields({ type: 'User', value: VIEWER }, selection.selections, ctx);
    case 'files': {
      const files = pullFiles(repo, pull).map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      const conn = { nodes: files, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      return resolveFields({ type: 'PullRequestFileConnection', value: conn, repo }, selection.selections, ctx);
    }
    default:
      return unknownField(typed, selection, ctx);
  }
}

function resolveUserField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  switch (selection.name) {
    case 'id':
      return globalId('User', VIEWER.id);
    case 'databaseId':
      return VIEWER.id;
    case 'login':
      return VIEWER.login;
    case 'name':
      return VIEWER.name;
    case 'email':
      return VIEWER.email;
    default:
      return unknownField(typed, selection, ctx);
  }
}

function resolveCommentField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const comment = typed.value as { id: number; body: string; createdAt: string; updatedAt: string };
  switch (selection.name) {
    case 'id':
      return globalId('IssueComment', comment.id);
    case 'databaseId':
      return comment.id;
    case 'body':
      return comment.body;
    case 'createdAt':
      return comment.createdAt;
    case 'updatedAt':
      return comment.updatedAt;
    case 'author':
      return resolveFields({ type: 'User', value: VIEWER }, selection.selections, ctx);
    default:
      return unknownField(typed, selection, ctx);
  }
}

function resolveConnectionField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const conn = typed.value as { nodes: unknown[]; pageInfo: Record<string, unknown> };
  if (selection.name === 'nodes') {
    const nodeType: TypeName =
      typed.type === 'IssueConnection' ? 'Issue' : typed.type === 'PullRequestConnection' ? 'PullRequest' : typed.type === 'PullRequestFileConnection' ? 'PullRequestFile' : typed.type === 'LabelConnection' ? 'Ref' : 'IssueComment';
    return conn.nodes.map((node) => {
      if (selection.selections.length === 0) return node;
      if (nodeType === 'Ref' || nodeType === 'PullRequestFile') {
        return resolveFields({ type: nodeType, value: node as Record<string, unknown> }, selection.selections, ctx);
      }
      return resolveFields({ type: nodeType, value: node, repo: typed.repo }, selection.selections, ctx);
    });
  }
  if (selection.name === 'edges') {
    const nodeType: TypeName =
      typed.type === 'IssueConnection' ? 'Issue' : typed.type === 'PullRequestConnection' ? 'PullRequest' : typed.type === 'PullRequestFileConnection' ? 'PullRequestFile' : typed.type === 'LabelConnection' ? 'Ref' : 'IssueComment';
    return conn.nodes.map((node) => {
      const edge: Record<string, unknown> = { cursor: null };
      const nodeSelection = selection.selections.find((item) => item.name === 'node');
      if (nodeSelection !== undefined) {
        edge.node =
          nodeType === 'Ref' || nodeType === 'PullRequestFile'
            ? resolveFields({ type: nodeType, value: node as Record<string, unknown> }, nodeSelection.selections, ctx)
            : resolveFields({ type: nodeType, value: node, repo: typed.repo }, nodeSelection.selections, ctx);
      }
      return edge;
    });
  }
  if (selection.name === 'pageInfo') {
    return resolveFields({ type: 'PageInfo', value: conn.pageInfo }, selection.selections, ctx);
  }
  if (selection.name === 'totalCount') {
    return conn.nodes.length;
  }
  return unknownField(typed, selection, ctx);
}

function resolvePayloadField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const payload = typed.value as Record<string, unknown>;
  if (selection.name === 'clientMutationId') return payload.clientMutationId ?? null;
  if (selection.name === 'issue' && payload.issue !== undefined) {
    return resolveFields({ type: 'Issue', value: payload.issue as Issue, repo: typed.repo }, selection.selections, ctx);
  }
  if (selection.name === 'pullRequest' && payload.pullRequest !== undefined) {
    return resolveFields({ type: 'PullRequest', value: payload.pullRequest as Pull, repo: typed.repo }, selection.selections, ctx);
  }
  if (selection.name === 'commentEdge' && payload.commentEdge !== undefined) {
    const edge = payload.commentEdge as { node: { id: number; body: string; createdAt: string; updatedAt: string } };
    const out: Record<string, unknown> = {};
    for (const sub of selection.selections) {
      if (sub.name === 'node') {
        out.node = resolveFields({ type: 'IssueComment', value: edge.node }, sub.selections, ctx);
      } else if (sub.name === 'cursor') {
        out.cursor = null;
      }
    }
    return out;
  }
  if (selection.name in payload) return payload[selection.name];
  return unknownField(typed, selection, ctx);
}

function findRepoById(id: number): Repo | undefined {
  return [...repos.values()].find((repo) => repo.id === id);
}

function findIssueByGlobalId(id: string): { issue: Issue; repo: Repo } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed[0] !== 'Issue') return null;
  for (const repo of repos.values()) {
    const issue = repo.issues.find((item) => item.id === parsed[1]);
    if (issue !== undefined) return { issue, repo };
  }
  return null;
}

function findPullByGlobalId(id: string): { pull: Pull; repo: Repo } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed[0] !== 'PullRequest') return null;
  for (const repo of repos.values()) {
    const pull = repo.pulls.find((item) => item.id === parsed[1]);
    if (pull !== undefined) return { pull, repo };
  }
  return null;
}

function resolveMutationField(typed: TypedValue, selection: Selection, args: Record<string, unknown>, ctx: Ctx): unknown {
  const name = selection.name;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
    const repo = parsed !== null && parsed[0] === 'Repository' ? findRepoById(parsed[1]) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
      return null;
    }
    const created = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if (isError(created)) {
      ctx.errors.push({ message: created.message });
      return null;
    }
    return resolveFields(
      { type: 'CreateIssuePayload', value: { issue: created, clientMutationId: input.clientMutationId ?? null }, repo },
      selection.selections,
      ctx,
    );
  }
  if (name === 'closeIssue') {
    const found = typeof input.issueId === 'string' ? findIssueByGlobalId(input.issueId) : null;
    if (found === null) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
      return null;
    }
    const patched = patchIssue(found.repo, found.issue, { state: 'closed' });
    if (isError(patched)) {
      ctx.errors.push({ message: patched.message });
      return null;
    }
    return resolveFields(
      { type: 'CloseIssuePayload', value: { issue: found.issue, clientMutationId: input.clientMutationId ?? null }, repo: found.repo },
      selection.selections,
      ctx,
    );
  }
  if (name === 'createPullRequest') {
    const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
    const repo = parsed !== null && parsed[0] === 'Repository' ? findRepoById(parsed[1]) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
      return null;
    }
    const created = createPull(
      repo,
      String(input.title ?? ''),
      String(input.body ?? ''),
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
    );
    if (isError(created)) {
      ctx.errors.push({ message: created.message });
      return null;
    }
    return resolveFields(
      { type: 'CreatePullRequestPayload', value: { pullRequest: created, clientMutationId: input.clientMutationId ?? null }, repo },
      selection.selections,
      ctx,
    );
  }
  if (name === 'mergePullRequest') {
    const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(input.pullRequestId) : null;
    if (found === null) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided pullRequestId.' });
      return null;
    }
    const merged = mergePull(found.repo, found.pull);
    if (isError(merged)) {
      ctx.errors.push({ message: merged.message });
      return null;
    }
    return resolveFields(
      { type: 'MergePullRequestPayload', value: { pullRequest: found.pull, clientMutationId: input.clientMutationId ?? null }, repo: found.repo },
      selection.selections,
      ctx,
    );
  }
  if (name === 'addComment') {
    const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(input.subjectId) : null;
    if (found === null) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided subjectId.' });
      return null;
    }
    const created = createIssueComment(found.repo, found.issue, String(input.body ?? ''));
    if (isError(created)) {
      ctx.errors.push({ message: created.message });
      return null;
    }
    return resolveFields(
      { type: 'AddCommentPayload', value: { commentEdge: { node: created }, clientMutationId: input.clientMutationId ?? null }, repo: found.repo },
      selection.selections,
      ctx,
    );
  }
  return unknownField(typed, selection, ctx);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((item) => executeSingle(item));
  }
  return executeSingle(body);
}

function executeSingle(body: unknown): GraphQLResult {
  const data = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof data !== 'object' || data === null || typeof data.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  const variables = (data.variables ?? {}) as Record<string, unknown>;
  let doc: GraphQLDocument;
  try {
    doc = parseGraphQL(data.query);
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Failed to parse the GraphQL query.' }] };
  }
  let operation: Operation | undefined;
  if (typeof data.operationName === 'string') {
    operation = doc.operations.find((item) => item.name === data.operationName);
    if (operation === undefined) {
      return { errors: [{ message: `Unknown operation named "${data.operationName}".` }] };
    }
  } else {
    operation = doc.operations[0];
  }
  if (operation === undefined) {
    return { errors: [{ message: 'No operation found in the GraphQL document.' }] };
  }
  const ctx: Ctx = { variables, fragments: doc.fragments, errors: [] };
  const rootType: TypeName = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const result = resolveFields({ type: rootType, value: {} }, operation.selections, ctx);
  if (ctx.errors.length > 0) {
    return { data: result, errors: ctx.errors };
  }
  return { data: result };
}

export { listPulls };
