// rest.ts — the GitHub REST v3 surface of the forge.
//
// Every handler takes a parsed request context and returns a Reply the
// server serialises as JSON. All replies carry X-GitHub-Request-Id (added
// by the server) and errors are always {"message": string}. Unknown routes
// answer JSON 404; malformed JSON bodies are rejected with 400 before any
// handler runs.

import { ZERO_OID } from './gitcore.ts';
import {
  DEFAULT_AUTHOR,
  VIEWER_ID,
  VIEWER_LOGIN,
  buildTree,
  diffTrees,
  flattenTree,
  getObject,
  makeCommit,
  mergeBase,
  parseCommit,
  putObject,
  seqTime,
  threeWayMerge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface Ctx {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Headers;
  /** Parsed JSON body, or undefined when the request had no JSON body. */
  json: unknown;
  /** Raw request body bytes (used by the git smart-HTTP handlers). */
  body: Buffer;
  /** The login the request authenticated as. */
  viewer: string;
  /** The bearer token the server expects, when one is configured. */
  token?: string;
  /** True when the request body was not valid JSON. */
  badJson?: boolean;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  /** Serialised as JSON; use `raw` for a pre-serialised body instead. */
  body?: unknown;
  raw?: string;
  /** Binary body, sent verbatim. */
  buf?: Buffer;
  contentType?: string;
}

const SCOPES = 'repo, read:org';

function ok(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

function err(status: number, message: string): Reply {
  return { status, body: { message } };
}

function notFound(what = 'Not Found'): Reply {
  return err(404, what);
}

function bodyOf(ctx: Ctx): Record<string, unknown> {
  return (ctx.json ?? {}) as Record<string, unknown>;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function intParam(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

function userObj(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 2000,
    type: 'User',
    html_url: `https://example.invalid/${login}`,
  };
}

export function repoObj(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: userObj(r.owner),
    private: r.isPrivate,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: seqTime(r.createdSeq),
    updated_at: seqTime(r.createdSeq),
    pushed_at: seqTime(r.createdSeq),
    html_url: `https://example.invalid/${r.owner}/${r.name}`,
    clone_url: `https://example.invalid/${r.owner}/${r.name}.git`,
    git_url: `git://example.invalid/${r.owner}/${r.name}.git`,
    ssh_url: `git@example.invalid:${r.owner}/${r.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelObj(l: Label): Record<string, unknown> {
  return { id: l.id, name: l.name, color: l.color, description: l.description, default: false };
}

export function issueObj(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    locked: false,
    labels: i.labels.map((name) => {
      const found = r.labels.find((l) => l.name === name);
      return found ? labelObj(found) : { id: 0, name, color: '000000', description: '' };
    }),
    user: userObj(i.user),
    assignees: [],
    created_at: seqTime(i.createdSeq),
    updated_at: seqTime(i.updatedSeq),
    closed_at: i.state === 'closed' ? seqTime(i.updatedSeq) : null,
    comments: i.comments.length,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
    url: `https://api.example.invalid/repos/${r.owner}/${r.name}/issues/${i.number}`,
  };
}

export function pullObj(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state === 'merged' ? 'closed' : p.state,
    locked: false,
    head: { ref: p.headRef, sha: p.headSha, label: `${r.owner}:${p.headRef}` },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${r.owner}:${p.baseRef}` },
    merged: p.merged,
    mergeable: p.mergeable,
    merge_commit_sha: p.mergeSha,
    merged_at: p.merged ? seqTime(p.updatedSeq) : null,
    user: userObj(VIEWER_LOGIN),
    created_at: seqTime(p.createdSeq),
    updated_at: seqTime(p.updatedSeq),
    closed_at: p.state !== 'open' ? seqTime(p.updatedSeq) : null,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
    url: `https://api.example.invalid/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}

function commentObj(c: { id: number; body: string; user: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: c.id,
    body: c.body,
    user: userObj(c.user),
    created_at: seqTime(c.createdSeq),
    updated_at: seqTime(c.createdSeq),
    html_url: `https://example.invalid/comments/${c.id}`,
  };
}

function commitObj(r: Repo, sha: string): Record<string, unknown> | null {
  const obj = getObject(r, sha);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const message = parsed.message.trim();
  const author = { name: DEFAULT_AUTHOR.name, email: DEFAULT_AUTHOR.email };
  return {
    sha,
    commit: {
      message,
      author: { ...author, date: seqTime(1) },
      committer: { ...author, date: seqTime(1) },
      tree: { sha: parsed.tree },
    },
    author: userObj(VIEWER_LOGIN),
    committer: userObj(VIEWER_LOGIN),
    parents: parsed.parents.map((p) => ({ sha: p })),
    html_url: `https://example.invalid/${r.owner}/${r.name}/commit/${sha}`,
    url: `https://api.example.invalid/repos/${r.owner}/${r.name}/commits/${sha}`,
  };
}

/** Walk history from a commit, newest first, capped at 100 entries. */
function listCommits(r: Repo, start: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0 && out.length < 100) {
    const sha = queue.shift()!;
    if (!sha || sha === ZERO_OID || seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(r, sha);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    const rendered = commitObj(r, sha);
    if (rendered) out.push(rendered);
    for (const p of parsed.parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const perPage = Math.min(intParam(ctx, 'per_page', 30), 100);
  const page = intParam(ctx, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = ctx.headers.get('host') ?? '127.0.0.1';
  const base = `http://${host}${ctx.pathname}`;
  const links: string[] = [];
  const mk = (p: number, rel: string) =>
    `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  if (page < totalPages) links.push(mk(page + 1, 'next'), mk(totalPages, 'last'));
  if (page > 1) links.push(mk(1, 'first'), mk(page - 1, 'prev'));
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function withLink(reply: Reply, link: string | null): Reply {
  if (!link) return reply;
  return { ...reply, headers: { ...(reply.headers ?? {}), Link: link } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Handle a REST request. Returns null when the path is not a REST route. */
export function handleRest(store: Store, ctx: Ctx): Reply | null {
  const p = ctx.pathname;
  if (!p.startsWith('/api/v3')) return null;
  const m = ctx.method;

  // --- API root ------------------------------------------------------------
  if (p === '/api/v3/' || p === '/api/v3') {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    return ok(200, {
      current_user_url: 'https://api.example.invalid/user',
      repository_url: 'https://api.example.invalid/repos/{owner}/{repo}',
      meta_url: 'https://api.example.invalid/meta',
    }, { 'X-OAuth-Scopes': SCOPES });
  }
  if (p === '/api/v3/meta') {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    return ok(200, { installed_version: '1.0.0-forge' });
  }
  if (p === '/api/v3/user') {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    return ok(200, {
      login: ctx.viewer,
      id: ctx.viewer === VIEWER_LOGIN ? VIEWER_ID : 2000,
      name: ctx.viewer === VIEWER_LOGIN ? 'ada iversen' : ctx.viewer,
      email: ctx.viewer === VIEWER_LOGIN ? 'adaiversen@example.invalid' : '',
      type: 'User',
    });
  }

  // --- POST /user/repos, GET /user/repos ------------------------------------
  if (p === '/api/v3/user/repos') {
    if (m === 'POST') {
      const b = bodyOf(ctx);
      const name = str(b.name);
      if (!name) return err(422, 'name is required');
      const created = store.createRepo(
        ctx.viewer,
        name,
        str(b.description),
        str(b.default_branch, 'main'),
        b.private === true,
      );
      if (!created) return err(422, `Repository ${ctx.viewer}/${name} already exists`);
      return ok(201, repoObj(created));
    }
    if (m === 'GET') {
      const repos = store.listRepos(ctx.viewer);
      const { page, link } = paginate(ctx, repos.map(repoObj));
      return withLink(ok(200, page), link);
    }
    return err(405, 'Method Not Allowed');
  }

  // --- /repos/{owner}/{name}/... --------------------------------------------
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(p);
  if (!repoMatch) return notFound();
  const [, owner, name, rest] = repoMatch;
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');

  if (rest === '' || rest === '/') {
    if (m === 'GET') return ok(200, repoObj(repo));
    if (m === 'PATCH') {
      const b = bodyOf(ctx);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
      return ok(200, repoObj(repo));
    }
    if (m === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204 };
    }
    return err(405, 'Method Not Allowed');
  }

  // --- branches --------------------------------------------------------------
  if (rest === '/branches') {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    const list = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha },
        protected: false,
      }));
    return ok(200, list);
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(rest);
  if (branchMatch) {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    const sha = repo.refs.get(`refs/heads/${decodeURIComponent(branchMatch[1])}`);
    if (!sha) return notFound('Branch not found');
    return ok(200, {
      name: decodeURIComponent(branchMatch[1]),
      commit: { sha },
      protected: false,
    });
  }

  // --- git refs ---------------------------------------------------------------
  if (rest === '/git/refs') {
    if (m === 'POST') {
      const b = bodyOf(ctx);
      const ref = str(b.ref);
      const sha = str(b.sha);
      if (!ref || !sha) return err(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (m === 'GET') {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
      return ok(200, list);
    }
    return err(405, 'Method Not Allowed');
  }
  const refHeadMatch = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
  if (refHeadMatch) {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    const branch = decodeURIComponent(refHeadMatch[1]);
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound('Reference not found');
    return ok(200, { ref: `refs/heads/${branch}`, object: { sha } });
  }

  // --- commits -----------------------------------------------------------------
  if (rest === '/commits') {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    const shaParam = ctx.query.get('sha');
    const start = shaParam
      ? repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? shaParam
      : store.headOid(repo);
    return ok(200, listCommits(repo, start));
  }
  const commitMatch = /^\/commits\/([0-9a-f]{40})$/.exec(rest);
  if (commitMatch) {
    if (m !== 'GET') return err(405, 'Method Not Allowed');
    const rendered = commitObj(repo, commitMatch[1]);
    if (!rendered) return notFound('Commit not found');
    return ok(200, rendered);
  }

  // --- contents -----------------------------------------------------------------
  if (rest.startsWith('/contents/')) {
    return handleContents(store, ctx, repo, rest.slice('/contents/'.length));
  }

  // --- labels -------------------------------------------------------------------
  if (rest === '/labels') {
    if (m === 'GET') return ok(200, repo.labels.map(labelObj));
    if (m === 'POST') {
      const b = bodyOf(ctx);
      const lname = str(b.name);
      if (!lname) return err(422, 'name is required');
      if (repo.labels.some((l) => l.name === lname)) {
        return err(422, `Label ${lname} already exists`);
      }
      const label: Label = {
        id: repo.nextLabel++,
        name: lname,
        color: str(b.color, '000000'),
        description: str(b.description),
      };
      repo.labels.push(label);
      return ok(201, labelObj(label));
    }
    return err(405, 'Method Not Allowed');
  }

  // --- issues -------------------------------------------------------------------
  if (rest === '/issues') {
    if (m === 'GET') {
      let list = [...repo.issues];
      const state = ctx.query.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const direction = ctx.query.get('direction') ?? 'desc';
      const sort = ctx.query.get('sort') ?? 'created';
      if (sort === 'created') {
        list.sort((a, b) =>
          direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
        );
      }
      const { page, link } = paginate(ctx, list.map((i) => issueObj(repo, i)));
      return withLink(ok(200, page), link);
    }
    if (m === 'POST') {
      const b = bodyOf(ctx);
      const title = str(b.title);
      if (!title) return err(422, 'title is required');
      const labelNames: string[] = Array.isArray(b.labels)
        ? b.labels.map((x: unknown) => (typeof x === 'string' ? x : str((x as Record<string, unknown>)?.name)))
        : [];
      for (const ln of labelNames) {
        if (!repo.labels.some((l) => l.name === ln)) {
          return err(422, `Label ${ln} does not exist`);
        }
      }
      const seq = store.nextSeq();
      const issue: Issue = {
        id: repo.nextIssue,
        number: repo.nextIssue++,
        title,
        body: str(b.body),
        state: 'open',
        labels: labelNames,
        user: ctx.viewer,
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
      };
      repo.issues.push(issue);
      return ok(201, issueObj(repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }
  const issueNumMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueNumMatch) {
    const num = Number(issueNumMatch[1]);
    const issue = repo.issues.find((i) => i.number === num);
    if (!issue) return notFound('Issue not found');
    if (issueNumMatch[2] === '/comments') {
      if (m === 'GET') return ok(200, issue.comments.map(commentObj));
      if (m === 'POST') {
        const b = bodyOf(ctx);
        const text = str(b.body);
        if (!text) return err(422, 'body is required');
        const comment = {
          id: repo.nextComment++,
          body: text,
          user: ctx.viewer,
          createdSeq: store.nextSeq(),
        };
        issue.comments.push(comment);
        return ok(201, commentObj(comment));
      }
      return err(405, 'Method Not Allowed');
    }
    if (m === 'GET') return ok(200, issueObj(repo, issue));
    if (m === 'PATCH') {
      const b = bodyOf(ctx);
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
      if (Array.isArray(b.labels)) {
        const names = b.labels.map((x: unknown) => (typeof x === 'string' ? x : str((x as Record<string, unknown>)?.name)));
        for (const ln of names) {
          if (!repo.labels.some((l) => l.name === ln)) return err(422, `Label ${ln} does not exist`);
        }
        issue.labels = names;
      }
      issue.updatedSeq = store.nextSeq();
      return ok(200, issueObj(repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }

  // --- pull requests ------------------------------------------------------------
  if (rest === '/pulls') {
    if (m === 'GET') {
      let list = [...repo.pulls];
      const state = ctx.query.get('state') ?? 'open';
      if (state !== 'all') {
        list = list.filter((pr) => (state === 'open' ? pr.state === 'open' : pr.state !== 'open'));
      }
      const { page, link } = paginate(ctx, list.map((pr) => pullObj(repo, pr)));
      return withLink(ok(200, page), link);
    }
    if (m === 'POST') {
      const b = bodyOf(ctx);
      const title = str(b.title);
      const head = str(b.head);
      const base = str(b.base, repo.defaultBranch);
      if (!title || !head) return err(422, 'title and head are required');
      const headSha = repo.refs.get(`refs/heads/${head}`) ?? repo.refs.get(head);
      const baseSha = repo.refs.get(`refs/heads/${base}`) ?? repo.refs.get(base);
      if (!headSha) return err(422, `Head branch ${head} does not exist`);
      if (!baseSha) return err(422, `Base branch ${base} does not exist`);
      const mb = mergeBase(repo, baseSha, headSha);
      const mbTree = mb ? parseCommit(getObject(repo, mb)!.data).tree : ZERO_OID;
      const headTree = parseCommit(getObject(repo, headSha)!.data).tree;
      const files = diffTrees(repo, mbTree, headTree);
      const { conflicts } = threeWayMerge(repo, baseSha, headSha);
      const seq = store.nextSeq();
      const pull: Pull = {
        id: repo.nextPull,
        number: repo.nextPull++,
        title,
        body: str(b.body),
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
      return ok(201, pullObj(repo, pull));
    }
    return err(405, 'Method Not Allowed');
  }
  const pullNumMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
  if (pullNumMatch) {
    const num = Number(pullNumMatch[1]);
    const pull = repo.pulls.find((pr) => pr.number === num);
    if (!pull) return notFound('Pull request not found');
    const suffix = pullNumMatch[2] ?? '';
    if (suffix === '/files') {
      if (m !== 'GET') return err(405, 'Method Not Allowed');
      return ok(200, pull.files);
    }
    if (suffix === '/merge') {
      if (m === 'GET') {
        return pull.merged ? { status: 204 } : notFound('Not merged');
      }
      if (m !== 'PUT') return err(405, 'Method Not Allowed');
      if (pull.state !== 'open') return err(405, 'Pull request is not open');
      const baseCommit = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headCommit = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (!baseCommit || !headCommit) return notFound('Branch not found');
      if (pull.headSha !== headCommit) {
        // Head moved since the PR was opened: re-evaluate against the tip.
        pull.headSha = headCommit;
      }
      const { files: mergedFiles, conflicts } = threeWayMerge(repo, baseCommit, headCommit);
      if (conflicts.length > 0) {
        pull.mergeable = false;
        pull.conflicts = conflicts;
        return err(405, 'Merge conflict');
      }
      const mergedTree = buildTree(repo, mergedFiles);
      const seq = store.nextSeq();
      const message = `${pull.title} (#${pull.number})`;
      const mergeCommit = makeCommit(repo, mergedTree, [baseCommit], message, DEFAULT_AUTHOR, seq);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
      pull.state = 'merged';
      pull.merged = true;
      pull.mergeSha = mergeCommit;
      pull.updatedSeq = seq;
      return ok(200, { sha: mergeCommit, merged: true, message });
    }
    if (m === 'GET') return ok(200, pullObj(repo, pull));
    if (m === 'PATCH') {
      const b = bodyOf(ctx);
      if (typeof b.title === 'string') pull.title = b.title;
      if (typeof b.body === 'string') pull.body = b.body;
      if (b.state === 'closed' && pull.state === 'open') pull.state = 'closed';
      pull.updatedSeq = store.nextSeq();
      return ok(200, pullObj(repo, pull));
    }
    return err(405, 'Method Not Allowed');
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Contents handler
// ---------------------------------------------------------------------------

function handleContents(store: Store, ctx: Ctx, repo: Repo, rawPath: string): Reply {
  const path = decodeURIComponent(rawPath);
  const branch = ctx.query.get('ref') ?? str(bodyOf(ctx).branch, repo.defaultBranch);
  const refName = `refs/heads/${branch}`;
  const head = repo.refs.get(refName);
  const headTree = head ? parseCommit(getObject(repo, head)!.data).tree : ZERO_OID;
  const files = flattenTree(repo, headTree);

  if (ctx.method === 'GET') {
    const entry = files.get(path);
    if (entry) {
      const blob = getObject(repo, entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        content: data.toString('base64'),
        url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    }
    // Directory listing: every entry directly under `path/`.
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { type: string; sha: string; size: number }>();
    for (const [p, e] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const blob = getObject(repo, e.oid);
        seen.set(rest, { type: 'file', sha: e.oid, size: blob?.data.length ?? 0 });
      } else {
        seen.set(rest.slice(0, slash), { type: 'dir', sha: e.oid, size: 0 });
      }
    }
    if (seen.size === 0) return notFound('Not Found');
    const list = [...seen.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, v]) => ({
        type: v.type,
        name,
        path: prefix + name,
        sha: v.sha,
        size: v.size,
        url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
      }));
    return ok(200, list);
  }

  if (ctx.method === 'PUT') {
    const b = bodyOf(ctx);
    const contentB64 = str(b.content);
    if (!contentB64) return err(422, 'content is required');
    const message = str(b.message, `Update ${path}`);
    const newData = Buffer.from(contentB64, 'base64');
    const existing = files.get(path);
    const givenSha = str(b.sha);
    if (existing) {
      if (!givenSha || givenSha !== existing.oid) {
        return err(409, 'sha does not match the current blob');
      }
    }
    const blobOid = putObject(repo, 'blob', newData);
    const next = new Map(files);
    next.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = buildTree(repo, next);
    const parents = head ? [head] : [];
    const seq = store.nextSeq();
    const commitOid = makeCommit(repo, treeOid, parents, message, DEFAULT_AUTHOR, seq);
    repo.refs.set(refName, commitOid);
    const status = existing ? 200 : 201;
    return ok(status, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: newData.length, encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
  }

  if (ctx.method === 'DELETE') {
    const b = bodyOf(ctx);
    const existing = files.get(path);
    if (!existing) return notFound('Not Found');
    const givenSha = str(b.sha);
    if (givenSha && givenSha !== existing.oid) {
      return err(409, 'sha does not match the current blob');
    }
    const next = new Map(files);
    next.delete(path);
    const treeOid = buildTree(repo, next);
    const parents = head ? [head] : [];
    const seq = store.nextSeq();
    const commitOid = makeCommit(repo, treeOid, parents, str(b.message, `Delete ${path}`), DEFAULT_AUTHOR, seq);
    repo.refs.set(refName, commitOid);
    return ok(200, { commit: { sha: commitOid } });
  }

  return err(405, 'Method Not Allowed');
}
