// graphql.ts — a purpose-built GraphQL executor for the fixed documents the
// conformance suite sends (viewer/repository lookups, __type probes, issue
// and pull-request connections, the five mutations, node(id:) and batching).
//
// It is a small recursive-descent parser plus a resolver table, not a
// general GraphQL engine: it covers exactly the shapes those documents use
// (variables, aliases, arguments, inline fragments, input objects), and
// reports anything outside the schema as a 200 with an `errors` array,
// the way GitHub's API does. Global Relay ids are base64url of
// `R:<kind>:<owner>/<repo>[/<number>]`, opaque and stable across reads.

import { ZERO_OID } from './gitcore.ts';
import {
  DEFAULT_AUTHOR,
  VIEWER_LOGIN,
  buildTree,
  diffTrees,
  getObject,
  makeCommit,
  mergeBase,
  parseCommit,
  seqTime,
  threeWayMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import type { Ctx, Reply } from './rest.ts';

// ---------------------------------------------------------------------------
// Relay ids
// ---------------------------------------------------------------------------

export function relayId(kind: string, ...parts: Array<string | number>): string {
  const text = `R:${kind}:${parts.join('/')}`;
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function decodeRelayId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    if (!text.startsWith('R:')) return null;
    const rest = text.slice(2);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    return { kind: rest.slice(0, colon), parts: rest.slice(colon + 1).split('/') };
  } catch {
    return null;
  }
}

function repoRelayId(r: Repo): string {
  return relayId('repo', r.owner, r.name);
}

function issueRelayId(r: Repo, i: Issue): string {
  return relayId('issue', r.owner, r.name, i.number);
}

function pullRelayId(r: Repo, p: Pull): string {
  return relayId('pull', r.owner, r.name, p.number);
}

function commentRelayId(r: Repo, issueNumber: number, commentId: number): string {
  return relayId('comment', r.owner, r.name, issueNumber, commentId);
}

// ---------------------------------------------------------------------------
// Tokenizer + parser (subset)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j += 1;
      tokens.push({ kind: 'number', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]!:=@$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document`);
    }
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return t.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', selections: this.parseSelections() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        // Optional operation name.
        if (this.peek().kind === 'name') this.next();
        // Optional variable definitions.
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.skipParens();
        }
        operations.push({ kind, selections: this.parseSelections() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // the type name
        fragments.set(name, this.parseSelections());
        continue;
      }
      throw new Error('unexpected token at the top of a GraphQL document');
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    while (true) {
      const t = this.next();
      if (t.kind === 'eof') throw new Error('unbalanced parentheses in GraphQL document');
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      if (t.kind === 'punct' && t.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      if (this.peek().kind === 'name') {
        // A named fragment spread: `...Name`. Inline it at execution time.
        const name = this.next().value;
        return { kind: 'fragment', typeCondition: `__spread:${name}`, selections: [] };
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelections() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', name: fieldName, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'literal', value: t.value };
    if (t.kind === 'number') return { kind: 'literal', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: t.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'literal':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Introspection tables
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt',
  'author', 'labels', 'comments', 'closedAt',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
  'mergeable', 'merged', 'files', 'url', 'createdAt', 'updatedAt', 'author',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'url', 'description', 'isPrivate', 'createdAt',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'];

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class GqlError extends Error {}

type Tagged = { __type: string; [key: string]: unknown };

function tag(type: string, data: Record<string, unknown>): Tagged {
  return { __type: type, ...data };
}

function repoValue(r: Repo): Tagged {
  return tag('Repository', {
    repo: r,
    id: repoRelayId(r),
    databaseId: r.id,
    name: r.name,
    nameWithOwner: `${r.owner}/${r.name}`,
    ownerLogin: r.owner,
    description: r.description,
    isPrivate: r.isPrivate,
    createdAt: seqTime(r.createdSeq),
  });
}

function issueValue(r: Repo, i: Issue): Tagged {
  return tag('Issue', {
    repo: r,
    issue: i,
    id: issueRelayId(r, i),
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: seqTime(i.createdSeq),
    updatedAt: seqTime(i.updatedSeq),
    url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
  });
}

function pullValue(r: Repo, p: Pull): Tagged {
  return tag('PullRequest', {
    repo: r,
    pull: p,
    id: pullRelayId(r, p),
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state === 'merged' ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: p.headRef,
    baseRefName: p.baseRef,
    mergeable: p.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    merged: p.merged,
    createdAt: seqTime(p.createdSeq),
    updatedAt: seqTime(p.updatedSeq),
    url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
  });
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

class Executor {
  private readonly store: Store;
  private readonly viewer: string;
  private readonly variables: Record<string, unknown>;
  private readonly fragments: Map<string, SelectionNode[]>;

  constructor(
    store: Store,
    viewer: string,
    variables: Record<string, unknown>,
    fragments: Map<string, SelectionNode[]>,
  ) {
    this.store = store;
    this.viewer = viewer;
    this.variables = variables;
    this.fragments = fragments;
  }

  execute(op: Operation): Record<string, unknown> {
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    return this.resolveSelections(tag(rootType, {}), op.selections);
  }

  private resolveSelections(parent: Tagged, selections: SelectionNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        if (sel.typeCondition?.startsWith('__spread:')) {
          const name = sel.typeCondition.slice('__spread:'.length);
          const frag = this.fragments.get(name);
          if (!frag) throw new GqlError(`Unknown fragment "${name}".`);
          Object.assign(out, this.resolveSelections(parent, frag));
          continue;
        }
        if (sel.typeCondition === null || sel.typeCondition === parent.__type) {
          Object.assign(out, this.resolveSelections(parent, sel.selections));
        }
        continue;
      }
      const key = sel.alias ?? sel.name;
      out[key] = this.resolveField(parent, sel);
    }
    return out;
  }

  private argsOf(sel: FieldNode): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) out[k] = resolveValue(v, this.variables);
    return out;
  }

  private resolveField(parent: Tagged, sel: FieldNode): unknown {
    const args = this.argsOf(sel);
    const value = this.fieldValue(parent, sel.name, args);
    if (value === undefined) {
      throw new GqlError(`Cannot query field "${sel.name}" on type "${parent.__type}".`);
    }
    if (sel.selections === null) return value;
    if (value === null) return null;
    if (Array.isArray(value)) {
      return value.map((entry) =>
        entry !== null && typeof entry === 'object' && '__type' in (entry as Record<string, unknown>)
          ? this.resolveSelections(entry as Tagged, sel.selections!)
          : entry,
      );
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      return this.resolveSelections(value as Tagged, sel.selections);
    }
    return value;
  }

  /** Returns undefined when the field does not exist on the parent type. */
  private fieldValue(parent: Tagged, name: string, args: Record<string, unknown>): unknown {
    switch (parent.__type) {
      case 'Query':
        return this.queryField(name, args);
      case 'Mutation':
        return this.mutationField(name, args);
      case 'Repository':
        return this.repositoryField(parent, name, args);
      case 'Issue':
        return this.issueField(parent, name, args);
      case 'PullRequest':
        return this.pullField(parent, name, args);
      case 'User':
        return this.userField(parent, name);
      case 'Ref':
        return name === 'name' ? parent.name : undefined;
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'FileConnection':
      case 'LabelConnection':
      case 'CommentConnection':
        return this.connectionField(parent, name);
      case 'PageInfo':
        return parent[name];
      case 'Comment':
        return name === 'id' ? parent.id : name === 'body' ? parent.body : undefined;
      case 'CommentEdge':
        return name === 'node' ? parent.node : name === 'cursor' ? parent.cursor : undefined;
      case 'Label':
        return parent[name];
      case '__Type':
        return this.typeField(parent, name);
      case '__Field':
      case '__EnumValue':
        return parent[name];
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
      case 'AddCommentPayload':
      case 'PullRequestFile':
      case 'Edge':
        return parent[name];
      default:
        return undefined;
    }
  }

  // --- root ---------------------------------------------------------------

  private queryField(name: string, args: Record<string, unknown>): unknown {
    if (name === 'viewer') {
      return tag('User', { login: this.viewer, id: relayId('user', this.viewer), name: this.viewer });
    }
    if (name === 'repository') {
      const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoValue(repo) : null;
    }
    if (name === 'node') {
      const decoded = decodeRelayId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const repo = this.store.getRepo(decoded.parts[0], decoded.parts[1]);
        return repo ? repoValue(repo) : null;
      }
      if (decoded.kind === 'issue') {
        const repo = this.store.getRepo(decoded.parts[0], decoded.parts[1]);
        const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[2]));
        return repo && issue ? issueValue(repo, issue) : null;
      }
      if (decoded.kind === 'pull') {
        const repo = this.store.getRepo(decoded.parts[0], decoded.parts[1]);
        const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[2]));
        return repo && pull ? pullValue(repo, pull) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (typeName === 'Issue') return tag('__Type', { name: 'Issue', fields: ISSUE_FIELDS, enumValues: null });
      if (typeName === 'PullRequest') return tag('__Type', { name: 'PullRequest', fields: PULL_REQUEST_FIELDS, enumValues: null });
      if (typeName === 'Repository') return tag('__Type', { name: 'Repository', fields: REPOSITORY_FIELDS, enumValues: null });
      if (typeName === 'SearchType') return tag('__Type', { name: 'SearchType', fields: null, enumValues: SEARCH_TYPE_VALUES });
      return null;
    }
    return undefined;
  }

  // --- mutations ------------------------------------------------------------

  private mutationField(name: string, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') return this.createIssue(input);
    if (name === 'closeIssue') return this.closeIssue(input);
    if (name === 'createPullRequest') return this.createPullRequest(input);
    if (name === 'mergePullRequest') return this.mergePullRequest(input);
    if (name === 'addComment') return this.addComment(input);
    return undefined;
  }

  private repoFromRelayId(id: unknown): Repo | null {
    const decoded = decodeRelayId(String(id ?? ''));
    if (!decoded || decoded.kind !== 'repo') return null;
    return this.store.getRepo(decoded.parts[0], decoded.parts[1]) ?? null;
  }

  private createIssue(input: Record<string, unknown>): Tagged {
    const repo = this.repoFromRelayId(input.repositoryId);
    if (!repo) throw new GqlError('Could not resolve to a Repository with the id provided.');
    const title = String(input.title ?? '');
    if (!title) throw new GqlError('A title is required to create an issue.');
    const seq = this.store.nextSeq();
    const issue: Issue = {
      id: repo.nextIssue,
      number: repo.nextIssue++,
      title,
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      user: this.viewer,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.push(issue);
    return tag('CreateIssuePayload', { issue: issueValue(repo, issue) });
  }

  private closeIssue(input: Record<string, unknown>): Tagged {
    const decoded = decodeRelayId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'issue') {
      throw new GqlError('Could not resolve to an Issue with the id provided.');
    }
    const repo = this.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[2]));
    if (!repo || !issue) throw new GqlError('Could not resolve to an Issue with the id provided.');
    issue.state = 'closed';
    issue.updatedSeq = this.store.nextSeq();
    return tag('CloseIssuePayload', { issue: issueValue(repo, issue) });
  }

  private createPullRequest(input: Record<string, unknown>): Tagged {
    const repo = this.repoFromRelayId(input.repositoryId);
    if (!repo) throw new GqlError('Could not resolve to a Repository with the id provided.');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? repo.defaultBranch);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) throw new GqlError(`Head branch ${head} does not exist.`);
    if (!baseSha) throw new GqlError(`Base branch ${base} does not exist.`);
    const mb = mergeBase(repo, baseSha, headSha);
    const mbTree = mb ? parseCommit(getObject(repo, mb)!.data).tree : ZERO_OID;
    const headTree = parseCommit(getObject(repo, headSha)!.data).tree;
    const files = diffTrees(repo, mbTree, headTree);
    const { conflicts } = threeWayMerge(repo, baseSha, headSha);
    const seq = this.store.nextSeq();
    const pull: Pull = {
      id: repo.nextPull,
      number: repo.nextPull++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
    repo.pulls.push(pull);
    return tag('CreatePullRequestPayload', { pullRequest: pullValue(repo, pull) });
  }

  private mergePullRequest(input: Record<string, unknown>): Tagged {
    const decoded = decodeRelayId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'pull') {
      throw new GqlError('Could not resolve to a PullRequest with the id provided.');
    }
    const repo = this.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[2]));
    if (!repo || !pull) throw new GqlError('Could not resolve to a PullRequest with the id provided.');
    if (pull.state !== 'open') throw new GqlError('Pull request is not open.');
    const baseCommit = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headCommit = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseCommit || !headCommit) throw new GqlError('Branch not found.');
    const { files: mergedFiles, conflicts } = threeWayMerge(repo, baseCommit, headCommit);
    if (conflicts.length > 0) throw new GqlError('Merge conflict.');
    const mergedTree = buildTree(repo, mergedFiles);
    const seq = this.store.nextSeq();
    const mergeCommit = makeCommit(repo, mergedTree, [baseCommit], `${pull.title} (#${pull.number})`, DEFAULT_AUTHOR, seq);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
    pull.state = 'merged';
    pull.merged = true;
    pull.mergeSha = mergeCommit;
    pull.updatedSeq = seq;
    return tag('MergePullRequestPayload', { pullRequest: pullValue(repo, pull) });
  }

  private addComment(input: Record<string, unknown>): Tagged {
    const decoded = decodeRelayId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'issue') {
      throw new GqlError('Could not resolve to an Issue with the id provided.');
    }
    const repo = this.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[2]));
    if (!repo || !issue) throw new GqlError('Could not resolve to an Issue with the id provided.');
    const comment = {
      id: repo.nextComment++,
      body: String(input.body ?? ''),
      user: this.viewer,
      createdSeq: this.store.nextSeq(),
    };
    issue.comments.push(comment);
    const node = tag('Comment', {
      id: commentRelayId(repo, issue.number, comment.id),
      body: comment.body,
    });
    return tag('AddCommentPayload', {
      commentEdge: tag('CommentEdge', { node, cursor: cursorFor(comment.id) }),
    });
  }

  // --- object types -----------------------------------------------------------

  private repositoryField(parent: Tagged, name: string, args: Record<string, unknown>): unknown {
    const repo = parent.repo as Repo;
    switch (name) {
      case 'id':
      case 'databaseId':
      case 'name':
      case 'nameWithOwner':
      case 'description':
      case 'isPrivate':
      case 'createdAt':
        return parent[name];
      case 'owner':
        return tag('User', { login: repo.owner, id: relayId('user', repo.owner), name: repo.owner });
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'defaultBranchRef': {
        const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return head ? tag('Ref', { name: repo.defaultBranch, oid: head }) : null;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? issueValue(repo, issue) : null;
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        if (orderBy?.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy.direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        } else {
          list.sort((a, b) => a.createdSeq - b.createdSeq);
        }
        return this.issueConnection(repo, list, args);
      }
      case 'pullRequest': {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        return pull ? pullValue(repo, pull) : null;
      }
      case 'pullRequests': {
        let list = [...repo.pulls];
        const states = args.states as string[] | undefined;
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((p) => wanted.has(p.state === 'merged' ? 'MERGED' : p.state.toUpperCase()));
        } else {
          list = list.filter((p) => p.state === 'open');
        }
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const nodes = list.slice(0, first).map((p) => pullValue(repo, p));
        return tag('PullRequestConnection', {
          nodes,
          pageInfo: tag('PageInfo', {
            hasNextPage: list.length > first,
            endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number as number) : null,
          }),
        });
      }
      default:
        return undefined;
    }
  }

  private issueConnection(repo: Repo, list: Issue[], args: Record<string, unknown>): Tagged {
    const first = typeof args.first === 'number' ? args.first : list.length;
    const afterNum = cursorNumber(args.after);
    const start = afterNum === null ? 0 : list.findIndex((i) => i.number === afterNum) + 1;
    const page = list.slice(Math.max(0, start), Math.max(0, start) + first);
    const nodes = page.map((i) => issueValue(repo, i));
    const last = page[page.length - 1];
    return tag('IssueConnection', {
      nodes,
      pageInfo: tag('PageInfo', {
        hasNextPage: Math.max(0, start) + first < list.length,
        endCursor: last ? cursorFor(last.number) : null,
      }),
    });
  }

  private issueField(parent: Tagged, name: string, args: Record<string, unknown>): unknown {
    const issue = parent.issue as Issue;
    const repo = parent.repo as Repo;
    switch (name) {
      case 'id':
      case 'number':
      case 'title':
      case 'body':
      case 'state':
      case 'createdAt':
      case 'updatedAt':
      case 'url':
        return parent[name];
      case 'closedAt':
        return issue.state === 'closed' ? seqTime(issue.updatedSeq) : null;
      case 'author':
        return tag('User', { login: issue.user, id: relayId('user', issue.user), name: issue.user });
      case 'labels': {
        const nodes = issue.labels.map((labelName) => {
          const found = repo.labels.find((l) => l.name === labelName);
          return tag('Label', {
            id: relayId('label', repo.owner, repo.name, labelName),
            name: labelName,
            color: found?.color ?? '000000',
            description: found?.description ?? '',
          });
        });
        return tag('LabelConnection', {
          nodes,
          pageInfo: tag('PageInfo', { hasNextPage: false, endCursor: null }),
        });
      }
      case 'comments': {
        const first = typeof args.first === 'number' ? args.first : issue.comments.length;
        const nodes = issue.comments.slice(0, first).map((c) =>
          tag('Comment', { id: commentRelayId(repo, issue.number, c.id), body: c.body }),
        );
        return tag('CommentConnection', {
          nodes,
          totalCount: issue.comments.length,
          pageInfo: tag('PageInfo', { hasNextPage: issue.comments.length > first, endCursor: null }),
        });
      }
      default:
        return undefined;
    }
  }

  private pullField(parent: Tagged, name: string, args: Record<string, unknown>): unknown {
    const pull = parent.pull as Pull;
    switch (name) {
      case 'id':
      case 'number':
      case 'title':
      case 'body':
      case 'state':
      case 'headRefName':
      case 'baseRefName':
      case 'mergeable':
      case 'merged':
      case 'createdAt':
      case 'updatedAt':
      case 'url':
        return parent[name];
      case 'author':
        return tag('User', { login: VIEWER_LOGIN, id: relayId('user', VIEWER_LOGIN), name: VIEWER_LOGIN });
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : pull.files.length;
        const nodes = pull.files.slice(0, first).map((f) =>
          tag('PullRequestFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() }),
        );
        return tag('FileConnection', {
          nodes,
          totalCount: pull.files.length,
          pageInfo: tag('PageInfo', { hasNextPage: pull.files.length > first, endCursor: null }),
        });
      }
      default:
        return undefined;
    }
  }

  private userField(parent: Tagged, name: string): unknown {
    if (name === 'login' || name === 'name') return parent.login ?? parent.name;
    if (name === 'id') return parent.id;
    return undefined;
  }

  private connectionField(parent: Tagged, name: string): unknown {
    if (name === 'nodes') return parent.nodes;
    if (name === 'edges') {
      const nodes = (parent.nodes ?? []) as Tagged[];
      return nodes.map((n, i) => tag('Edge', { node: n, cursor: cursorFor(i + 1) }));
    }
    if (name === 'pageInfo') return parent.pageInfo;
    if (name === 'totalCount') return parent.totalCount;
    return undefined;
  }

  private typeField(parent: Tagged, name: string): unknown {
    if (name === 'name') return parent.name;
    if (name === 'fields') {
      const fields = parent.fields as string[] | null;
      if (!fields) return null;
      return fields.map((f) => tag('__Field', { name: f }));
    }
    if (name === 'enumValues') {
      const values = parent.enumValues as string[] | null;
      if (!values) return null;
      return values.map((v) => tag('__EnumValue', { name: v }));
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export function handleGraphQL(store: Store, ctx: Ctx): Reply {
  const body = ctx.json;
  if (Array.isArray(body)) {
    const results = body.map((entry) => runOperation(store, ctx, entry));
    return { status: 200, body: results };
  }
  return { status: 200, body: runOperation(store, ctx, body) };
}

function runOperation(store: Store, ctx: Ctx, entry: unknown): Record<string, unknown> {
  const record = (entry ?? {}) as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'A query document is required.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let parsed: { operations: Operation[]; fragments: Map<string, SelectionNode[]> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { errors: [{ message: (e as Error).message }] };
  }
  if (parsed.operations.length === 0) {
    return { errors: [{ message: 'No operation found in the query document.' }] };
  }
  const op = parsed.operations[0];
  try {
    const executor = new Executor(store, ctx.viewer, variables, parsed.fragments);
    const data = executor.execute(op);
    return { data };
  } catch (e) {
    if (e instanceof GqlError) {
      return { data: null, errors: [{ message: e.message }] };
    }
    return { data: null, errors: [{ message: (e as Error).message }] };
  }
}
