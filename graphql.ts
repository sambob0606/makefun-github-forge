// GraphQL v4: a small hand-rolled parser and executor for the fixed documents the
// suite sends. Unknown fields answer HTTP 200 with an `errors` array naming the
// field; an unknown repository yields `data.repository = null` with no errors.

import { VIEWER } from './scenario.ts';
import {
  STORE,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isRecord, jsonError, jsonRes, type Req, type Res } from './http.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly value: ValueNode[] }
  | { readonly kind: 'object'; readonly value: Record<string, ValueNode> }
  | { readonly kind: 'variable'; readonly name: string };

interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias?: string;
  readonly args: Record<string, ValueNode>;
  readonly selection?: SelectionNode[];
}

interface SpreadNode {
  readonly kind: 'spread';
  readonly name: string;
}

interface InlineNode {
  readonly kind: 'inline';
  readonly typeCondition?: string;
  readonly selection: SelectionNode[];
}

type SelectionNode = FieldNode | SpreadNode | InlineNode;

interface VariableDefinition {
  readonly type: string;
  readonly defaultValue?: ValueNode;
}

interface OperationNode {
  readonly operation: 'query' | 'mutation';
  readonly name?: string;
  readonly variables: Record<string, VariableDefinition>;
  readonly selection: SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Record<string, FragmentNode>;
}

class Parser {
  readonly text: string;
  position = 0;

  constructor(text: string) {
    this.text = text;
  }

  error(message: string): Error {
    return new Error(`GraphQL parse error at offset ${this.position}: ${message}`);
  }

  skipIgnored(): void {
    for (;;) {
      const char = this.text[this.position];
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
        this.position += 1;
        continue;
      }
      if (char === '#') {
        while (this.position < this.text.length && this.text[this.position] !== '\n') this.position += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.text[this.position] ?? '';
  }

  expect(char: string): void {
    this.skipIgnored();
    if (this.text[this.position] !== char) throw this.error(`expected ${JSON.stringify(char)}, found ${JSON.stringify(this.text[this.position] ?? '')}`);
    this.position += 1;
  }

  match(char: string): boolean {
    this.skipIgnored();
    if (this.text[this.position] === char) {
      this.position += 1;
      return true;
    }
    return false;
  }

  readName(): string {
    this.skipIgnored();
    const start = this.position;
    while (this.position < this.text.length && /[_A-Za-z0-9]/.test(this.text[this.position] as string)) this.position += 1;
    if (this.position === start) throw this.error('expected a name');
    return this.text.slice(start, this.position);
  }

  readString(): string {
    this.skipIgnored();
    if (this.text[this.position] !== '"') throw this.error('expected a string');
    this.position += 1;
    let out = '';
    while (this.position < this.text.length) {
      const char = this.text[this.position] as string;
      if (char === '"') {
        this.position += 1;
        return out;
      }
      if (char === '\\') {
        const next = this.text[this.position + 1] as string;
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (next === 'u') {
          out += String.fromCharCode(parseInt(this.text.slice(this.position + 2, this.position + 6), 16));
          this.position += 6;
        } else if (escapes[next] !== undefined) {
          out += escapes[next];
          this.position += 2;
        } else {
          throw this.error(`bad escape \\${next}`);
        }
        continue;
      }
      out += char;
      this.position += 1;
    }
    throw this.error('unterminated string');
  }

  readNumber(): ValueNode {
    this.skipIgnored();
    const start = this.position;
    if (this.text[this.position] === '-') this.position += 1;
    while (this.position < this.text.length && /[0-9]/.test(this.text[this.position] as string)) this.position += 1;
    let isFloat = false;
    if (this.text[this.position] === '.') {
      isFloat = true;
      this.position += 1;
      while (this.position < this.text.length && /[0-9]/.test(this.text[this.position] as string)) this.position += 1;
    }
    if (this.text[this.position] === 'e' || this.text[this.position] === 'E') {
      isFloat = true;
      this.position += 1;
      if (this.text[this.position] === '+' || this.text[this.position] === '-') this.position += 1;
      while (this.position < this.text.length && /[0-9]/.test(this.text[this.position] as string)) this.position += 1;
    }
    const raw = this.text.slice(start, this.position);
    const value = Number(raw);
    if (Number.isNaN(value)) throw this.error(`bad number ${raw}`);
    return isFloat ? { kind: 'float', value } : { kind: 'int', value };
  }

  readValue(): ValueNode {
    this.skipIgnored();
    const char = this.text[this.position] ?? '';
    if (char === '"') return { kind: 'string', value: this.readString() };
    if (char === '$') {
      this.position += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (char === '[') {
      this.position += 1;
      const items: ValueNode[] = [];
      while (!this.match(']')) items.push(this.readValue());
      return { kind: 'list', value: items };
    }
    if (char === '{') {
      this.position += 1;
      const fields: Record<string, ValueNode> = {};
      while (!this.match('}')) {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.readValue();
      }
      return { kind: 'object', value: fields };
    }
    if (char === '-' || /[0-9]/.test(char)) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  /** Read a type reference as text, e.g. `String!`, `[IssueState!]`. */
  readType(): string {
    this.skipIgnored();
    if (this.match('[')) {
      const inner = this.readType();
      this.expect(']');
      return `[${inner}]${this.match('!') ? '!' : ''}`;
    }
    const name = this.readName();
    return `${name}${this.match('!') ? '!' : ''}`;
  }

  readArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.match('(')) return args;
    while (!this.match(')')) {
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
    }
    return args;
  }

  readVariableDefinitions(): Record<string, VariableDefinition> {
    const variables: Record<string, VariableDefinition> = {};
    if (!this.match('(')) return variables;
    while (!this.match(')')) {
      this.expect('$');
      const name = this.readName();
      this.expect(':');
      const type = this.readType();
      let defaultValue: ValueNode | undefined;
      if (this.match('=')) defaultValue = this.readValue();
      variables[name] = { type, defaultValue };
    }
    return variables;
  }

  readSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.match('}')) {
      if (this.peek() === '.' && this.text.slice(this.position, this.position + 3) === '...') {
        this.position += 3;
        this.skipIgnored();
        if (this.text.slice(this.position, this.position + 2) === 'on') {
          this.position += 2;
          const typeCondition = this.readName();
          selections.push({ kind: 'inline', typeCondition, selection: this.readSelectionSet() });
        } else {
          const name = this.readName();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.readName();
      let alias: string | undefined;
      let name = first;
      if (this.match(':')) {
        alias = first;
        name = this.readName();
      }
      const args = this.readArguments();
      // Directives are not used by the suite; skip them if present.
      while (this.peek() === '@') {
        this.position += 1;
        this.readName();
        this.readArguments();
      }
      const selection = this.peek() === '{' ? this.readSelectionSet() : undefined;
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    return selections;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments: Record<string, FragmentNode> = {};
    while (this.peek() !== '') {
      const keyword = this.readName();
      if (keyword === 'fragment') {
        const name = this.readName();
        const on = this.readName();
        if (on !== 'on') throw this.error(`expected 'on' in fragment, got ${on}`);
        const typeCondition = this.readName();
        fragments[name] = { name, typeCondition, selection: this.readSelectionSet() };
        continue;
      }
      let operation: 'query' | 'mutation';
      let name: string | undefined;
      if (keyword === 'query' || keyword === 'mutation') {
        operation = keyword;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.readName();
      } else if (keyword === '{') {
        // Shorthand query: the '{' was consumed as a name read; not expected here.
        throw this.error('shorthand queries are not supported');
      } else {
        throw this.error(`unexpected keyword ${keyword}`);
      }
      const variables = this.readVariableDefinitions();
      const selection = this.readSelectionSet();
      operations.push({ operation, name, variables, selection });
    }
    return { operations, fragments };
  }
}

function parseDocument(text: string): DocumentNode {
  const parser = new Parser(text);
  return parser.parseDocument();
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'list':
      return node.value.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.value)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

interface GqlContext {
  readonly viewer: string;
  readonly errors: Array<{ message: string }>;
  readonly fragments: Record<string, FragmentNode>;
  readonly variables: Record<string, unknown>;
}

interface TypedValue {
  readonly __typename: string;
  readonly [key: string]: unknown;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function pageInfoFor(items: readonly { number: number }[], first: number | undefined, hasMore: boolean): TypedValue {
  const last = items.length === 0 ? null : (items[items.length - 1] as { number: number }).number;
  return {
    __typename: 'PageInfo',
    hasNextPage: hasMore,
    endCursor: last === null ? null : cursorFor(last),
    hasPreviousPage: false,
    startCursor: items.length === 0 ? null : cursorFor((items[0] as { number: number }).number),
  };
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const sorted = [...issues];
  const order = isRecord(orderBy) ? orderBy : {};
  const direction = order.direction === 'ASC' ? 1 : -1;
  sorted.sort((a, b) => (a.createdSeq - b.createdSeq) * direction || (a.number - b.number) * direction);
  return sorted;
}

function issueValue(repo: Repo, issue: Issue): TypedValue {
  return {
    __typename: 'Issue',
    repo,
    issue,
    id: globalId('Issue', [repo.databaseId, issue.number]),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullValue(repo: Repo, pull: Pull): TypedValue {
  return {
    __typename: 'PullRequest',
    repo,
    pull,
    id: globalId('PullRequest', [repo.databaseId, pull.number]),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    merged: pull.merged,
    mergeable: STORE.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
  };
}

function repoValue(repo: Repo): TypedValue {
  return {
    __typename: 'Repository',
    repo,
    id: globalId('Repository', [repo.databaseId]),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1001, name: repo.owner === VIEWER.login ? VIEWER.name : repo.owner, email: `${repo.owner}@example.invalid` } as TypedValue,
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch } as TypedValue,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
  };
}

function userValue(login: string): TypedValue {
  return {
    __typename: 'User',
    login,
    id: login === VIEWER.login ? VIEWER.id : 1001,
    name: login === VIEWER.login ? VIEWER.name : login,
    email: `${login}@example.invalid`,
  };
}

type Resolver = (value: TypedValue, args: Record<string, unknown>, ctx: GqlContext) => unknown;

const FIELD_TABLES: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userValue(VIEWER.login),
    repository: (_value, args) => {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (owner === undefined || name === undefined) return null;
      const repo = STORE.getRepo(owner, name);
      if (repo === undefined || repo.owner !== VIEWER.login) return null;
      return repoValue(repo);
    },
    node: (_value, args) => {
      const id = args.id as string | undefined;
      if (id === undefined) return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const databaseId = Number(decoded.parts[0]);
        for (const repo of STORE.repos.values()) if (repo.databaseId === databaseId) return repoValue(repo);
        return null;
      }
      if (decoded.kind === 'Issue') {
        const databaseId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        for (const repo of STORE.repos.values()) {
          if (repo.databaseId !== databaseId) continue;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueValue(repo, issue);
        }
        return null;
      }
      if (decoded.kind === 'PullRequest') {
        const databaseId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        for (const repo of STORE.repos.values()) {
          if (repo.databaseId !== databaseId) continue;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : pullValue(repo, pull);
        }
        return null;
      }
      return null;
    },
    __type: (_value, args) => {
      const name = args.name as string | undefined;
      if (name === undefined) return null;
      const known = TYPE_INFO[name];
      if (known === undefined) return null;
      return {
        __typename: '__Type',
        name,
        kind: known.kind,
        fields: known.fields.map((field) => ({ __typename: '__Field', name: field, description: null, args: [] }) as TypedValue),
        enumValues: known.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null }) as TypedValue),
      } as TypedValue;
    },
  },
  Mutation: {
    createIssue: (_value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repositoryId = input.repositoryId as string | undefined;
      const title = input.title as string | undefined;
      if (repositoryId === undefined || title === undefined) throw new Error('createIssue requires repositoryId and title');
      const decoded = decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('repositoryId does not name a repository');
      const databaseId = Number(decoded.parts[0]);
      let repo: Repo | undefined;
      for (const candidate of STORE.repos.values()) if (candidate.databaseId === databaseId) repo = candidate;
      if (repo === undefined) throw new Error('repository not found');
      const issue = STORE.createIssue(repo, title, (input.body as string | undefined) ?? '', []);
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) } as TypedValue;
    },
    closeIssue: (_value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const issueId = input.issueId as string | undefined;
      if (issueId === undefined) throw new Error('closeIssue requires issueId');
      const decoded = decodeGlobalId(issueId);
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('issueId does not name an issue');
      const databaseId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of STORE.repos.values()) {
        if (repo.databaseId !== databaseId) continue;
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new Error('issue not found');
        issue.state = 'closed';
        issue.updatedAt = STORE.nowIso();
        return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue) } as TypedValue;
      }
      throw new Error('issue not found');
    },
    createPullRequest: (_value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repositoryId = input.repositoryId as string | undefined;
      const baseRefName = input.baseRefName as string | undefined;
      const headRefName = input.headRefName as string | undefined;
      const title = input.title as string | undefined;
      if (repositoryId === undefined || baseRefName === undefined || headRefName === undefined || title === undefined) {
        throw new Error('createPullRequest requires repositoryId, baseRefName, headRefName and title');
      }
      const decoded = decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('repositoryId does not name a repository');
      const databaseId = Number(decoded.parts[0]);
      let repo: Repo | undefined;
      for (const candidate of STORE.repos.values()) if (candidate.databaseId === databaseId) repo = candidate;
      if (repo === undefined) throw new Error('repository not found');
      const headSha = STORE.refCommit(repo, headRefName);
      const baseSha = STORE.refCommit(repo, baseRefName);
      if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName);
      const pull = existing ?? STORE.createPull(repo, title, (input.body as string | undefined) ?? '', headRefName, baseRefName, headSha, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) } as TypedValue;
    },
    mergePullRequest: (_value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const pullRequestId = input.pullRequestId as string | undefined;
      if (pullRequestId === undefined) throw new Error('mergePullRequest requires pullRequestId');
      const decoded = decodeGlobalId(pullRequestId);
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('pullRequestId does not name a pull request');
      const databaseId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of STORE.repos.values()) {
        if (repo.databaseId !== databaseId) continue;
        const pull = repo.pulls.get(number);
        if (pull === undefined) throw new Error('pull request not found');
        if (pull.merged) return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) } as TypedValue;
        if (STORE.pullConflict(repo, pull)) throw new Error('This branch has conflicts that must be resolved');
        const merged = STORE.mergePull(repo, pull);
        if (merged === null) throw new Error('This branch has conflicts that must be resolved');
        return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) } as TypedValue;
      }
      throw new Error('pull request not found');
    },
    addComment: (_value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = input.subjectId as string | undefined;
      const body = input.body as string | undefined;
      if (subjectId === undefined || body === undefined) throw new Error('addComment requires subjectId and body');
      const decoded = decodeGlobalId(subjectId);
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('subjectId does not name an issue');
      const databaseId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of STORE.repos.values()) {
        if (repo.databaseId !== databaseId) continue;
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new Error('issue not found');
        const id = repo.nextCommentId;
        repo.nextCommentId += 1;
        const comment = { id, body, userLogin: VIEWER.login, createdAt: STORE.nowIso() };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: globalId('Comment', [repo.databaseId, number, id]),
              body,
            } as TypedValue,
          } as TypedValue,
        } as TypedValue;
      }
      throw new Error('issue not found');
    },
  },
  User: {
    login: (value) => value.login,
    id: (value) => value.id,
    name: (value) => value.name,
    email: (value) => value.email,
  },
  Repository: {
    id: (value) => value.id,
    databaseId: (value) => value.databaseId,
    name: (value) => value.name,
    nameWithOwner: (value) => value.nameWithOwner,
    owner: (value) => value.owner,
    defaultBranchRef: (value) => value.defaultBranchRef,
    viewerPermission: (value) => value.viewerPermission,
    hasIssuesEnabled: (value) => value.hasIssuesEnabled,
    description: (value) => value.description,
    private: (value) => value.private,
    issue: (value, args) => {
      const repo = value.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueValue(repo, issue);
    },
    issues: (value, args) => {
      const repo = value.repo as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      issues = sortIssues(issues, args.orderBy);
      const afterNumber = numberFromCursor(args.after as string | undefined);
      if (afterNumber !== null) {
        const direction = isRecord(args.orderBy) && args.orderBy.direction === 'ASC' ? 1 : -1;
        issues = issues.filter((issue) => (direction === -1 ? issue.number < afterNumber : issue.number > afterNumber));
      }
      const first = args.first === undefined ? undefined : Number(args.first);
      const page = first === undefined ? issues : issues.slice(0, first);
      const hasMore = first !== undefined && issues.length > first;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueValue(repo, issue)),
        pageInfo: pageInfoFor(page, first, hasMore),
        totalCount: issues.length,
      } as TypedValue;
    },
    pullRequests: (value, args) => {
      const repo = value.repo as Repo;
      let pulls = [...repo.pulls.values()];
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        pulls = pulls.filter((pull) => wanted.has(pull.state));
      }
      pulls.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const afterNumber = numberFromCursor(args.after as string | undefined);
      if (afterNumber !== null) pulls = pulls.filter((pull) => pull.number < afterNumber);
      const first = args.first === undefined ? undefined : Number(args.first);
      const page = first === undefined ? pulls : pulls.slice(0, first);
      const hasMore = first !== undefined && pulls.length > first;
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullValue(repo, pull)),
        pageInfo: pageInfoFor(page, first, hasMore),
        totalCount: pulls.length,
      } as TypedValue;
    },
    pullRequest: (value, args) => {
      const repo = value.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullValue(repo, pull);
    },
  },
  Ref: {
    name: (value) => value.name,
  },
  Issue: {
    id: (value) => value.id,
    number: (value) => value.number,
    title: (value) => value.title,
    state: (value) => value.state,
    body: (value) => value.body,
    author: () => userValue(VIEWER.login),
    createdAt: (value) => (value.issue as Issue).createdAt,
    updatedAt: (value) => (value.issue as Issue).updatedAt,
    url: (value) => {
      const repo = value.repo as Repo;
      return `https://example.invalid/${repo.owner}/${repo.name}/issues/${(value.issue as Issue).number}`;
    },
  },
  PullRequest: {
    id: (value) => value.id,
    number: (value) => value.number,
    title: (value) => value.title,
    body: (value) => value.body,
    state: (value) => value.state,
    headRefName: (value) => value.headRefName,
    baseRefName: (value) => value.baseRefName,
    merged: (value) => value.merged,
    mergeable: (value) => value.mergeable,
    author: () => userValue(VIEWER.login),
    createdAt: (value) => (value.pull as Pull).createdAt,
    updatedAt: (value) => (value.pull as Pull).updatedAt,
    files: (value, args) => {
      const repo = value.repo as Repo;
      const pull = value.pull as Pull;
      const files = STORE.pullFiles(repo, pull);
      const first = args.first === undefined ? undefined : Number(args.first);
      const page = first === undefined ? files : files.slice(0, first);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: page.map((file) => ({ __typename: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }) as TypedValue),
        pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && files.length > first, endCursor: null } as TypedValue,
        totalCount: files.length,
      } as TypedValue;
    },
  },
  IssueConnection: {
    nodes: (value) => value.nodes,
    edges: (value) => (value.nodes as TypedValue[]).map((node) => ({ __typename: 'IssueEdge', node, cursor: cursorFor(node.number as number) }) as TypedValue),
    pageInfo: (value) => value.pageInfo,
    totalCount: (value) => value.totalCount,
  },
  PullRequestConnection: {
    nodes: (value) => value.nodes,
    edges: (value) => (value.nodes as TypedValue[]).map((node) => ({ __typename: 'PullRequestEdge', node, cursor: cursorFor(node.number as number) }) as TypedValue),
    pageInfo: (value) => value.pageInfo,
    totalCount: (value) => value.totalCount,
  },
  PullRequestFileConnection: {
    nodes: (value) => value.nodes,
    pageInfo: (value) => value.pageInfo,
    totalCount: (value) => value.totalCount,
  },
  IssueEdge: {
    node: (value) => value.node,
    cursor: (value) => value.cursor,
  },
  PullRequestEdge: {
    node: (value) => value.node,
    cursor: (value) => value.cursor,
  },
  PullRequestFile: {
    path: (value) => value.path,
    additions: (value) => value.additions,
    deletions: (value) => value.deletions,
    changeType: (value) => value.changeType,
  },
  IssueCommentEdge: {
    node: (value) => value.node,
  },
  IssueComment: {
    id: (value) => value.id,
    body: (value) => value.body,
  },
  PageInfo: {
    hasNextPage: (value) => value.hasNextPage,
    hasPreviousPage: (value) => value.hasPreviousPage,
    endCursor: (value) => value.endCursor,
    startCursor: (value) => value.startCursor,
  },
  __Type: {
    name: (value) => value.name,
    kind: (value) => value.kind,
    fields: (value) => value.fields,
    enumValues: (value) => value.enumValues,
  },
  __Field: {
    name: (value) => value.name,
    description: (value) => value.description,
    args: (value) => value.args,
  },
  __EnumValue: {
    name: (value) => value.name,
    description: (value) => value.description,
  },
  CreateIssuePayload: {
    issue: (value) => value.issue,
  },
  CloseIssuePayload: {
    issue: (value) => value.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (value) => value.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (value) => value.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (value) => value.commentEdge,
  },
};

// The introspection tables the suite queries. Extra fields are harmless.
const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'repository'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'url'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'url'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC'],
  },
  IssueState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED'],
  },
  PullRequestState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  MergeableState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
};

function executeSelectionSet(
  selections: SelectionNode[],
  parent: TypedValue,
  ctx: GqlContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments[selection.name];
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(fragment.selection, parent, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(selection.selection, parent, ctx));
      continue;
    }
    const responseName = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseName] = parent.__typename;
      continue;
    }
    const table = FIELD_TABLES[parent.__typename] ?? {};
    const resolver = table[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.__typename}".` });
      out[responseName] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, valueNode] of Object.entries(selection.args)) args[key] = resolveValue(valueNode, ctx.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : 'field resolver failed' });
      out[responseName] = null;
      continue;
    }
    if (selection.selection !== undefined) {
      if (value === null || value === undefined) {
        out[responseName] = null;
      } else if (Array.isArray(value)) {
        out[responseName] = value.map((item) =>
          item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
            ? executeSelectionSet(selection.selection as SelectionNode[], item as TypedValue, ctx)
            : item,
        );
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[responseName] = executeSelectionSet(selection.selection, value as TypedValue, ctx);
      } else {
        out[responseName] = value;
      }
    } else {
      out[responseName] = value;
    }
  }
  return out;
}

function executeOperation(operation: OperationNode, document: DocumentNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: GqlContext = { viewer: VIEWER.login, errors: [], fragments: document.fragments, variables };
  // Apply variable defaults for missing variables.
  for (const [name, definition] of Object.entries(operation.variables)) {
    if (ctx.variables[name] === undefined && definition.defaultValue !== undefined) {
      ctx.variables[name] = resolveValue(definition.defaultValue, ctx.variables);
    }
  }
  const root: TypedValue = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(operation.selection, root, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function executeGraphQL(body: unknown): unknown {
  const runOne = (request: unknown): Record<string, unknown> => {
    if (!isRecord(request)) return { data: null, errors: [{ message: 'Request body must be a JSON object' }] };
    const query = request.query;
    if (typeof query !== 'string' || query.trim() === '') return { data: null, errors: [{ message: 'query must be a non-empty string' }] };
    let document: DocumentNode;
    try {
      document = parseDocument(query);
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
    }
    const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
    const variables = isRecord(request.variables) ? { ...(request.variables as Record<string, unknown>) } : {};
    let operation: OperationNode | undefined;
    if (document.operations.length === 1) {
      operation = document.operations[0];
    } else if (operationName !== undefined) {
      operation = document.operations.find((candidate) => candidate.name === operationName);
    }
    if (operation === undefined) return { data: null, errors: [{ message: operationName === undefined ? 'Must provide operation name if query contains multiple operations.' : `Unknown operation named "${operationName}".` }] };
    return executeOperation(operation, document, variables);
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}

export function handleGraphQL(req: Req): Res {
  let body: unknown;
  try {
    body = req.json();
  } catch {
    return jsonError(400, 'Request body must be valid JSON');
  }
  return jsonRes(200, executeGraphQL(body));
}

