// rest.ts — the GitHub REST v3 surface (/api/v3/*).
//
// One handler, `handleRest`, takes a parsed request and returns a response
// shape; app.ts owns HTTP, auth and JSON parsing. Every reply is JSON and
// carries X-GitHub-Request-Id (app.ts adds the header). Any owner other
// than the viewer is a 404, never a 403; a missing repo is a 404.

import {
  VIEWER,
  allocRequestId,
  globalId,
  tickIso,
} from './store.ts';
import {
  commentJson,
  createIssue,
  createIssueComment,
  createLabel,
  createPull,
  createRef,
  createRepo,
  deleteContent,
  err,
  getIssue,
  getPull,
  isError,
  issueJson,
  listCommits,
  listIssues,
  listPulls,
  mergePull,
  patchIssue,
  pullFiles,
  pullJson,
  pullMergeable,
  putContent,
  readContent,
  repoJson,
  resolveRef,
  userJson,
  type ServiceError,
} from './service.ts';
import { deleteRepoRecord, getRepo, getViewerRepo, repos, type Repo } from './store.ts';

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  empty?: boolean;
}

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or null when there was no body. */
  body: unknown;
  origin: string;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestResponse {
  return { status, json, headers };
}

function notFound(message = 'Not Found'): RestResponse {
  return { status: 404, json: { message, documentation_url: 'https://docs.github.com/rest' } };
}

function badRequest(message: string): RestResponse {
  return { status: 400, json: { message } };
}

function unprocessable(message: string): RestResponse {
  return { status: 422, json: { message } };
}

function asError(value: unknown): RestResponse | null {
  if (isError(value)) {
    const error = value as ServiceError;
    return { status: error.status, json: { message: error.message } };
  }
  return null;
}

/** Parse a pagination window from the query: per_page default 30, cap 100. */
function pageWindow(query: URLSearchParams): { perPage: number; page: number } {
  const rawPerPage = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(rawPerPage) ? Math.min(Math.max(Math.floor(rawPerPage), 1), 100) : 30;
  const rawPage = Number(query.get('page') ?? '1');
  const page = Number.isFinite(rawPage) ? Math.max(Math.floor(rawPage), 1) : 1;
  return { perPage, page };
}

/** Slice a list into a page and build the Link header for the rest. */
function paginate<T>(items: T[], query: URLSearchParams, path: string, origin: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageWindow(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(p));
    next.set('per_page', String(perPage));
    return `${origin}${path}?${next.toString()}`;
  };
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function pagedOk<T>(items: T[], toJson: (item: T) => unknown, query: URLSearchParams, path: string, origin: string): RestResponse {
  const { page, link } = paginate(items, query, path, origin);
  const headers: Record<string, string> = {};
  if (link !== null) headers.Link = link;
  return ok(200, page.map(toJson), headers);
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** Resolve /repos/:owner/:name, 404 for any other owner or missing repo. */
function resolveRepo(segments: string[]): Repo | RestResponse {
  const owner = segments[1] as string;
  const name = segments[2] as string;
  if (owner !== VIEWER.login) return notFound('Not Found');
  const repo = getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function commitJson(repo: Repo, entry: ReturnType<typeof listCommits>[number]): Record<string, unknown> {
  return {
    sha: entry.sha,
    node_id: globalId('Commit', 0) === '' ? '' : Buffer.from(`Commit:${entry.sha}`, 'utf8').toString('base64'),
    commit: {
      author: { name: entry.authorName, email: entry.authorEmail, date: entry.date },
      committer: { name: entry.authorName, email: entry.authorEmail, date: entry.date },
      message: entry.message,
      tree: { sha: entry.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${entry.sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${entry.sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${entry.sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${entry.sha}/comments`,
    author: userJson(),
    committer: userJson(),
    parents: entry.parents.map((sha) => ({
      sha,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    })),
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: {
      sha,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    },
    protected: false,
  };
}

function contentFileJson(repo: Repo, path: string, entry: { name: string; sha: string; size: number; content: Buffer }): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: entry.size,
    name: entry.name,
    path,
    content: entry.content.toString('base64'),
    sha: entry.sha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  };
}

function contentDirJson(repo: Repo, entries: Array<{ kind: string; name: string; path: string; sha: string; size: number }>): unknown[] {
  return entries.map((entry) => ({
    type: entry.kind === 'dir' ? 'dir' : 'file',
    size: entry.kind === 'dir' ? 0 : entry.size,
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${entry.path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.sha}`,
    download_url: entry.kind === 'dir' ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${entry.path}`,
  }));
}

export function handleRest(request: RestRequest): RestResponse {
  const { method, segments, query, body, origin } = request;
  const path = `/api/v3/${segments.join('/')}`;

  // Root and discovery.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(200, {
      current_user_url: `${origin}/api/v3/user`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
    });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, { installed_version: '1.0.0' });
  }
  if (segments[0] === 'rate_limit' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    return ok(200, {
      resources: {
        core: { limit: 5000, remaining: 4999, reset, used: 1 },
        search: { limit: 30, remaining: 30, reset, used: 0 },
        graphql: { limit: 5000, remaining: 5000, reset, used: 0 },
      },
      rate: { limit: 5000, remaining: 4999, reset, used: 1 },
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') return ok(200, userJson());
    return notFound();
  }
  if (segments[0] === 'users' && segments.length === 2) {
    if (method !== 'GET') return notFound();
    if (segments[1] === VIEWER.login) return ok(200, userJson());
    return notFound();
  }

  // POST /user/repos and GET /user/repos.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const data = bodyObject(body);
      const created = createRepo(bodyString(data, 'name'), data.private === true, bodyString(data, 'description'), bodyString(data, 'default_branch') || undefined);
      const error = asError(created);
      if (error !== null) return error;
      return ok(201, repoJson(created as Repo));
    }
    if (method === 'GET') {
      const list = [...repos.values()].sort((a, b) => a.seq - b.seq);
      return pagedOk(list, (repo) => repoJson(repo), query, path, origin);
    }
    return notFound();
  }

  // Everything below is /repos/:owner/:name/...
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const repoOrError = resolveRepo(segments);
  if (!isRepo(repoOrError)) return repoOrError;
  const repo = repoOrError as Repo;
  const rest = segments.slice(3);

  // /repos/:owner/:name itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      const data = bodyObject(body);
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.default_branch === 'string' && repo.refs.has(`refs/heads/${data.default_branch}`)) {
        repo.defaultBranch = data.default_branch;
      }
      if (typeof data.name === 'string' && data.name !== repo.name && getViewerRepo(data.name) === undefined) {
        repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = data.name;
        repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      repo.updatedAt = tickIso();
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepoRecord(repo);
      return { status: 204, empty: true };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => branchJson(repo, name, repo.refs.get(`refs/heads/${name}`) as string));
      return pagedOk(branches, (branch) => branch, query, path, origin);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) return notFound('Branch not found');
      return ok(200, branchJson(repo, rest[1] as string, sha));
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const entries = listCommits(repo, query.get('sha') ?? undefined);
      return pagedOk(entries, (entry) => commitJson(repo, entry), query, path, origin);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = resolveRef(repo, rest[1] as string);
      if (sha === null) return notFound('Commit not found');
      const entries = listCommits(repo, sha);
      const entry = entries.find((item) => item.sha === sha);
      if (entry === undefined) return notFound('Commit not found');
      return ok(200, commitJson(repo, entry));
    }
    return notFound();
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const data = bodyObject(body);
      const created = createRef(repo, bodyString(data, 'ref'), bodyString(data, 'sha'));
      const error = asError(created);
      if (error !== null) return error;
      const ref = (created as { ref: string; sha: string }).ref;
      const objectType = repo.objects.get((created as { sha: string }).sha)?.type ?? 'commit';
      return ok(201, {
        ref,
        node_id: globalId('Ref', allocRequestId().length) === '' ? '' : Buffer.from(`Ref:${ref}`, 'utf8').toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace('refs/', '')}`,
        object: { sha: (created as { sha: string }).sha, type: objectType, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${objectType}s/${(created as { sha: string }).sha}` },
      });
    }
    if (method === 'GET' && rest.length >= 3) {
      const refName = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(refName);
      if (sha !== undefined) {
        const objectType = repo.objects.get(sha)?.type ?? 'commit';
        return ok(200, {
          ref: refName,
          node_id: Buffer.from(`Ref:${refName}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refName.replace('refs/', '')}`,
          object: { sha, type: objectType, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${objectType}s/${sha}` },
        });
      }
      // A prefix (e.g. refs/heads) lists every matching ref.
      const matches = [...repo.refs.entries()].filter(([name]) => name.startsWith(refName)).sort();
      if (matches.length === 0) return notFound('Reference not found');
      return ok(
        200,
        matches.map(([name, refSha]) => ({
          ref: name,
          node_id: Buffer.from(`Ref:${name}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${name.replace('refs/', '')}`,
          object: { sha: refSha, type: repo.objects.get(refSha)?.type ?? 'commit', url: '' },
        })),
      );
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') {
      const result = readContent(repo, filePath, query.get('ref') ?? undefined);
      const error = asError(result);
      if (error !== null) return error;
      const entry = result as { kind: string; name: string; path: string; sha: string; size: number; content: Buffer; entries: Array<{ kind: string; name: string; path: string; sha: string; size: number }> };
      if (entry.kind === 'file') return ok(200, contentFileJson(repo, filePath, entry));
      return ok(200, contentDirJson(repo, entry.entries));
    }
    if (method === 'PUT') {
      const data = bodyObject(body);
      const content = bodyString(data, 'content');
      if (content === '') return unprocessable('content is required');
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
      } catch {
        return badRequest('content is not valid base64');
      }
      const message = bodyString(data, 'message') || `Update ${filePath}`;
      const branch = typeof data.branch === 'string' ? data.branch : undefined;
      const sha = typeof data.sha === 'string' ? data.sha : undefined;
      const result = putContent(repo, filePath, bytes, message, branch, sha);
      const error = asError(result);
      if (error !== null) return error;
      const put = result as { contentSha: string; commitSha: string; created: boolean };
      return ok(put.created ? 201 : 200, {
        content: {
          type: 'file',
          encoding: 'base64',
          size: bytes.length,
          name: filePath.split('/').pop(),
          path: filePath,
          content: bytes.toString('base64'),
          sha: put.contentSha,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        },
        commit: { sha: put.commitSha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${put.commitSha}` },
      });
    }
    if (method === 'DELETE') {
      const data = bodyObject(body);
      const sha = typeof data.sha === 'string' ? data.sha : undefined;
      if (sha === undefined) return unprocessable('sha is required');
      const message = bodyString(data, 'message') || `Delete ${filePath}`;
      const branch = typeof data.branch === 'string' ? data.branch : undefined;
      const result = deleteContent(repo, filePath, message, branch, sha);
      const error = asError(result);
      if (error !== null) return error;
      const deleted = result as { commitSha: string };
      return ok(200, {
        commit: { sha: deleted.commitSha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${deleted.commitSha}` },
      });
    }
    return notFound();
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return ok(200, [...repo.labels.values()].map((label) => ({
        id: label.id,
        node_id: globalId('Label', label.id),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${label.name}`,
        name: label.name,
        color: label.color,
        default: false,
        description: label.description,
      })));
    }
    if (rest.length === 1 && method === 'POST') {
      const data = bodyObject(body);
      const label = createLabel(repo, bodyString(data, 'name'), bodyString(data, 'color'), bodyString(data, 'description'));
      const error = asError(label);
      if (error !== null) return error;
      const created = label as { id: number; name: string; color: string; description: string };
      return ok(201, {
        id: created.id,
        node_id: globalId('Label', created.id),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${created.name}`,
        name: created.name,
        color: created.color,
        default: false,
        description: created.description,
      });
    }
    return notFound();
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const data = bodyObject(body);
      const rawLabels = Array.isArray(data.labels) ? data.labels : [];
      const labelNames = rawLabels.map((item) => (typeof item === 'string' ? item : (item as { name?: unknown }).name)).filter((name): name is string => typeof name === 'string');
      const created = createIssue(repo, bodyString(data, 'title'), bodyString(data, 'body'), labelNames);
      const error = asError(created);
      if (error !== null) return error;
      return ok(201, issueJson(repo, created as ReturnType<typeof createIssue> extends infer T ? Extract<T, { number: number }> : never));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const list = listIssues(repo, state, sort, direction);
      return pagedOk(list, (issue) => issueJson(repo, issue), query, path, origin);
    }
    if (rest.length === 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return notFound();
      const issue = getIssue(repo, number);
      if (issue === undefined) return notFound('Issue not found');
      if (method === 'GET') return ok(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const data = bodyObject(body);
        const patched = patchIssue(repo, issue, {
          state: typeof data.state === 'string' ? data.state : undefined,
          title: typeof data.title === 'string' ? data.title : undefined,
          body: typeof data.body === 'string' ? data.body : undefined,
        });
        const error = asError(patched);
        if (error !== null) return error;
        return ok(200, issueJson(repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return notFound();
      const issue = getIssue(repo, number);
      if (issue === undefined) return notFound('Issue not found');
      if (method === 'POST') {
        const data = bodyObject(body);
        const created = createIssueComment(repo, issue, bodyString(data, 'body'));
        const error = asError(created);
        if (error !== null) return error;
        const comment = created as { id: number; body: string; createdAt: string; updatedAt: string };
        return ok(201, commentJson(repo, issue, comment));
      }
      if (method === 'GET') {
        return pagedOk(issue.comments, (comment) => commentJson(repo, issue, comment), query, path, origin);
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const data = bodyObject(body);
      const stripOwner = (ref: string): string => ref.split(':').pop() ?? ref;
      const created = createPull(repo, bodyString(data, 'title'), bodyString(data, 'body'), stripOwner(bodyString(data, 'head')), stripOwner(bodyString(data, 'base')));
      const error = asError(created);
      if (error !== null) return error;
      return ok(201, pullJson(repo, created as ReturnType<typeof createPull> extends infer T ? Extract<T, { number: number }> : never));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = listPulls(repo, state);
      return pagedOk(list, (pull) => pullJson(repo, pull), query, path, origin);
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return notFound();
      const pull = getPull(repo, number);
      if (pull === undefined) return notFound('Pull request not found');
      if (rest.length === 2 && method === 'GET') return ok(200, pullJson(repo, pull));
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = pullFiles(repo, pull);
        return ok(200, files.map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method === 'PUT') {
          const merged = mergePull(repo, pull);
          const error = asError(merged);
          if (error !== null) return error;
          const result = merged as { sha: string; message: string };
          return ok(200, { sha: result.sha, merged: true, message: result.message });
        }
        if (method === 'GET') {
          return pull.merged ? { status: 204, empty: true } : notFound('Not merged');
        }
        return notFound();
      }
      return notFound();
    }
    return notFound();
  }

  return notFound();
}

function isRepo(value: unknown): value is Repo {
  return typeof value === 'object' && value !== null && 'refs' in value && 'objects' in value;
}

export { allocRequestId };
