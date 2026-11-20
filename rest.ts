// REST v3: the /api/v3 surface. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors are JSON {message}. A repository belongs
// to the login the bearer token names; the same name under another owner is 404.

import { VIEWER } from './scenario.ts';
import {
  STORE,
  parseCommit,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import {
  boolField,
  isRecord,
  jsonError,
  jsonRes,
  paginate,
  requestId,
  stringField,
  type Req,
  type Res,
} from './http.ts';

const BASE_URL = 'https://example.invalid';

function ownerObject(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 1001, type: 'User', html_url: `${BASE_URL}/${login}`, url: `${BASE_URL}/api/v3/users/${login}` };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: ownerObject(repo.owner),
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `${BASE_URL}/${repo.owner}/${repo.name}`,
    url: `${BASE_URL}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${BASE_URL}/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    fork: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelObject(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '', default: false };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelObject),
    user: ownerObject(issue.userLogin),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `${BASE_URL}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${BASE_URL}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
    comments_url: `${BASE_URL}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: !STORE.pullConflict(repo, pull),
    user: ownerObject(pull.userLogin),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `${BASE_URL}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${BASE_URL}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** A repo must exist AND belong to the token's login; otherwise 404. */
function findRepo(req: Req, owner: string, name: string): Repo | null {
  if (owner !== req.viewer) return null;
  return STORE.getRepo(owner, name) ?? null;
}

function parseBody(req: Req): Record<string, unknown> | null {
  const body = req.json();
  return isRecord(body) ? body : null;
}

function invalidName(name: string): boolean {
  return !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name);
}

export function handleRest(req: Req): Res {
  const seg = req.segments;
  const method = req.method;
  const path = req.pathname;

  // GET /api/v3/
  if (path === '/api/v3/' || path === '/api/v3') {
    if (method !== 'GET') return jsonError(404, 'Not Found');
    return jsonRes(200, { current_user_url: `${BASE_URL}/api/v3/user`, repository_url: `${BASE_URL}/api/v3/repos/{owner}/{repo}` }, { 'X-OAuth-Scopes': 'repo, user' });
  }

  // GET /api/v3/meta
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return jsonError(404, 'Not Found');
    return jsonRes(200, { installed_version: '1.0.0', verifiable_password_authentication: false, github_services_sha: 'makefun-forge' });
  }

  // GET /api/v3/user
  if (path === '/api/v3/user') {
    if (method !== 'GET') return jsonError(404, 'Not Found');
    return jsonRes(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', ...ownerObject(VIEWER.login) });
  }

  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      const body = parseBody(req);
      if (body === null) return jsonError(400, 'Request body must be a JSON object');
      const name = stringField(body, 'name');
      if (name === undefined || name === '' || invalidName(name)) return jsonError(422, 'Invalid repository name');
      if (STORE.getRepo(req.viewer, name) !== undefined) return jsonError(422, `Repository ${req.viewer}/${name} already exists`);
      const repo = STORE.createRepo(req.viewer, name, {
        description: stringField(body, 'description'),
        private: boolField(body, 'private'),
      });
      return jsonRes(201, repoObject(repo));
    }
    if (method === 'GET') {
      const repos = STORE.listRepos(req.viewer);
      const { page, linkHeader } = paginate(repos, req.url);
      const headers: Record<string, string> = {};
      if (linkHeader !== null) headers.Link = linkHeader;
      return jsonRes(200, page.map(repoObject), headers);
    }
    return jsonError(404, 'Not Found');
  }

  if (!path.startsWith('/api/v3/repos/')) return jsonError(404, 'Not Found');
  const rest = seg.slice(3);
  const owner = rest[0] as string;
  const name = rest[1] as string;
  const tail = rest.slice(2);
  const repo = findRepo(req, owner, name);
  if (repo === null) return jsonError(404, 'Not Found');

  // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') return jsonRes(200, repoObject(repo));
    if (method === 'PATCH') {
      const body = parseBody(req);
      if (body === null) return jsonError(400, 'Request body must be a JSON object');
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      const isPrivate = boolField(body, 'private');
      if (isPrivate !== undefined) repo.private = isPrivate;
      return jsonRes(200, repoObject(repo));
    }
    if (method === 'DELETE') {
      STORE.deleteRepo(owner, name);
      return { status: 204, body: '', contentType: 'application/json', headers: { 'X-GitHub-Request-Id': requestId() } };
    }
    return jsonError(404, 'Not Found');
  }

  // GET /api/v3/repos/{o}/{r}/branches
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    return jsonRes(
      200,
      branches.map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: `${BASE_URL}/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
        protected: false,
      })),
    );
  }

  // GET /api/v3/repos/{o}/{r}/branches/{branch}
  if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') {
    const branch = tail[1] as string;
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return jsonError(404, 'Branch not found');
    return jsonRes(200, {
      name: branch,
      commit: { sha, url: `${BASE_URL}/api/v3/repos/${owner}/${name}/commits/${sha}` },
      protected: false,
    });
  }

  // POST /api/v3/repos/{o}/{r}/git/refs ; GET /git/refs ; GET /git/refs/heads/{branch}
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = parseBody(req);
      if (body === null) return jsonError(400, 'Request body must be a JSON object');
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return jsonError(422, 'Invalid ref');
      if (!/^[0-9a-f]{40}$/.test(sha)) return jsonError(422, 'Invalid sha');
      if (repo.objects.get(sha) === undefined) return jsonError(422, 'Object does not exist');
      if (repo.refs.has(ref)) return jsonError(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonRes(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET' && tail.length === 2) {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      return jsonRes(200, refs);
    }
    if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
      const branch = tail[3] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return jsonError(404, 'Reference does not exist');
      return jsonRes(200, { ref: `refs/heads/${branch}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return jsonError(404, 'Not Found');
  }

  // GET /api/v3/repos/{o}/{r}/commits[?sha=]
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = req.url.searchParams.get('sha') ?? repo.defaultBranch;
    const commitOid = STORE.refCommit(repo, ref);
    if (commitOid === null) return jsonRes(200, []);
    const commits: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue: string[] = [commitOid];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      const view = parseCommit(object.data);
      const authorLine = view.author;
      const authorMatch = /^(.+) <([^>]*)> (\d+) [+-]\d{4}$/.exec(authorLine) ?? ['', VIEWER.name, VIEWER.email, '0'];
      commits.push({
        sha: oid,
        commit: {
          message: view.message,
          author: { name: authorMatch[1], email: authorMatch[2], date: new Date(Number(authorMatch[3]) * 1000).toISOString() },
          committer: { name: authorMatch[1], email: authorMatch[2], date: new Date(Number(authorMatch[3]) * 1000).toISOString() },
          tree: { sha: view.tree },
        },
        author: ownerObject(VIEWER.login),
        parents: view.parents.map((parent) => ({ sha: parent })),
      });
      for (const parent of view.parents) queue.push(parent);
    }
    const { page, linkHeader } = paginate(commits, req.url);
    const headers: Record<string, string> = {};
    if (linkHeader !== null) headers.Link = linkHeader;
    return jsonRes(200, page, headers);
  }

  // GET/PUT/DELETE /api/v3/repos/{o}/{r}/contents/{path}
  if (tail[0] === 'contents') {
    const filePath = tail.slice(1).join('/');
    const refParam = req.url.searchParams.get('ref');
    const resolveCommit = (): string | null => {
      if (refParam !== null) return STORE.refCommit(repo, refParam);
      return STORE.headCommit(repo);
    };
    if (method === 'GET') {
      const commitOid = resolveCommit();
      if (commitOid === null) return jsonError(404, 'Not Found');
      const file = filePath === '' ? null : STORE.fileAt(repo, commitOid, filePath);
      if (file !== null) {
        return jsonRes(200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: filePath.split('/').pop() as string,
          path: filePath,
          sha: file.oid,
          content: file.data.toString('base64'),
          url: `${BASE_URL}/api/v3/repos/${owner}/${name}/contents/${filePath}`,
          html_url: `${BASE_URL}/${owner}/${name}/blob/${refParam ?? repo.defaultBranch}/${filePath}`,
          git_url: `${BASE_URL}/api/v3/repos/${owner}/${name}/git/blobs/${file.oid}`,
          download_url: `${BASE_URL}/${owner}/${name}/raw/${refParam ?? repo.defaultBranch}/${filePath}`,
        });
      }
      const entries = STORE.dirAt(repo, commitOid, filePath);
      if (entries === null) return jsonError(404, 'Not Found');
      return jsonRes(
        200,
        entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
          url: `${BASE_URL}/api/v3/repos/${owner}/${name}/contents/${entry.path}`,
        })),
      );
    }
    if (method === 'PUT') {
      const body = parseBody(req);
      if (body === null) return jsonError(400, 'Request body must be a JSON object');
      const message = stringField(body, 'message');
      const content = stringField(body, 'content');
      if (message === undefined || content === undefined) return jsonError(422, 'message and content are required');
      const branch = stringField(body, 'branch') ?? repo.defaultBranch;
      const givenSha = stringField(body, 'sha');
      let contentBytes: Buffer;
      try {
        contentBytes = Buffer.from(content, 'base64');
      } catch {
        return jsonError(422, 'content must be base64');
      }
      const branchTip = STORE.refTip(repo, branch);
      const baseCommit = branchTip === null ? null : STORE.refCommit(repo, branch);
      const existing = baseCommit === null ? null : STORE.fileAt(repo, baseCommit, filePath);
      const isUpdate = existing !== null;
      if (isUpdate) {
        if (givenSha === undefined) return jsonError(409, 'sha is required to update a file');
        if (givenSha !== existing.oid) return jsonError(409, 'sha does not match the current file');
      } else if (givenSha !== undefined) {
        return jsonError(409, 'sha does not match the current file');
      }
      // A branch that does not exist is created from the default branch tip.
      const commitOid = STORE.commitFile(repo, branch, filePath, contentBytes, message);
      const file = STORE.fileAt(repo, commitOid, filePath);
      return jsonRes(isUpdate ? 200 : 201, {
        content: {
          name: filePath.split('/').pop() as string,
          path: filePath,
          sha: file?.oid ?? '',
          size: contentBytes.length,
          encoding: 'base64',
          content: contentBytes.toString('base64'),
        },
        commit: { sha: commitOid, message },
      });
    }
    if (method === 'DELETE') {
      const body = parseBody(req);
      if (body === null) return jsonError(400, 'Request body must be a JSON object');
      const message = stringField(body, 'message');
      const givenSha = stringField(body, 'sha');
      if (message === undefined || givenSha === undefined) return jsonError(422, 'message and sha are required');
      const branch = stringField(body, 'branch') ?? repo.defaultBranch;
      const commitOid = STORE.refCommit(repo, branch);
      if (commitOid === null) return jsonError(404, 'Not Found');
      const existing = STORE.fileAt(repo, commitOid, filePath);
      if (existing === null) return jsonError(404, 'Not Found');
      if (existing.oid !== givenSha) return jsonError(409, 'sha does not match the current file');
      const newCommit = STORE.commitFile(repo, branch, filePath, Buffer.alloc(0), message, { remove: true });
      return jsonRes(200, { commit: { sha: newCommit, message } });
    }
    return jsonError(404, 'Not Found');
  }

  // POST /api/v3/repos/{o}/{r}/labels
  if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
    const body = parseBody(req);
    if (body === null) return jsonError(400, 'Request body must be a JSON object');
    const name = stringField(body, 'name');
    if (name === undefined || name === '') return jsonError(422, 'name is required');
    const color = stringField(body, 'color') ?? 'ededed';
    const existing = repo.labels.get(name);
    if (existing !== undefined) return jsonRes(200, labelObject(existing));
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return jsonRes(201, labelObject(label));
  }
  if (tail[0] === 'labels' && tail.length === 1 && method === 'GET') {
    return jsonRes(200, [...repo.labels.values()].map(labelObject));
  }

  // POST/GET /api/v3/repos/{o}/{r}/issues ; GET/PATCH /issues/{n}
  if (tail[0] === 'issues') {
    if (tail.length === 1 && method === 'POST') {
      const body = parseBody(req);
      if (body === null) return jsonError(400, 'Request body must be a JSON object');
      const title = stringField(body, 'title');
      if (title === undefined || title === '') return jsonError(422, 'title is required');
      const bodyText = stringField(body, 'body') ?? '';
      const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((item): item is string => typeof item === 'string') : [];
      const labels: Label[] = [];
      for (const labelName of labelNames) {
        const label = repo.labels.get(labelName);
        if (label === undefined) return jsonError(422, `Label ${labelName} does not exist`);
        labels.push(label);
      }
      const issue = STORE.createIssue(repo, title, bodyText, labels);
      return jsonRes(201, issueObject(repo, issue));
    }
    if (tail.length === 1 && method === 'GET') {
      const state = req.url.searchParams.get('state') ?? 'open';
      const direction = req.url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, linkHeader } = paginate(issues, req.url);
      const headers: Record<string, string> = {};
      if (linkHeader !== null) headers.Link = linkHeader;
      return jsonRes(200, page.map((issue) => issueObject(repo, issue)), headers);
    }
    const number = Number(tail[1]);
    if (tail.length === 2 && Number.isInteger(number)) {
      const issue = repo.issues.get(number);
      if (issue === undefined) return jsonError(404, 'Not Found');
      if (method === 'GET') return jsonRes(200, issueObject(repo, issue));
      if (method === 'PATCH') {
        const body = parseBody(req);
        if (body === null) return jsonError(400, 'Request body must be a JSON object');
        const state = stringField(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(body, 'title');
        if (title !== undefined) (issue as { title: string }).title = title;
        const bodyText = stringField(body, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        issue.updatedAt = STORE.nowIso();
        return jsonRes(200, issueObject(repo, issue));
      }
      return jsonError(404, 'Not Found');
    }
    if (tail.length === 3 && Number.isInteger(Number(tail[1])) && tail[2] === 'comments') {
      const issue = repo.issues.get(Number(tail[1]));
      if (issue === undefined) return jsonError(404, 'Not Found');
      if (method === 'POST') {
        const body = parseBody(req);
        if (body === null) return jsonError(400, 'Request body must be a JSON object');
        const text = stringField(body, 'body');
        if (text === undefined) return jsonError(422, 'body is required');
        const id = repo.nextCommentId;
        repo.nextCommentId += 1;
        const comment = { id, body: text, userLogin: VIEWER.login, createdAt: STORE.nowIso() };
        const list = repo.comments.get(issue.number) ?? [];
        list.push(comment);
        repo.comments.set(issue.number, list);
        return jsonRes(201, {
          id: comment.id,
          body: comment.body,
          user: ownerObject(comment.userLogin),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
          html_url: `${BASE_URL}/${owner}/${name}/issues/${issue.number}#issuecomment-${comment.id}`,
          url: `${BASE_URL}/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
        });
      }
      if (method === 'GET') {
        const list = repo.comments.get(issue.number) ?? [];
        return jsonRes(
          200,
          list.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: ownerObject(comment.userLogin),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            html_url: `${BASE_URL}/${owner}/${name}/issues/${issue.number}#issuecomment-${comment.id}`,
            url: `${BASE_URL}/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
          })),
        );
      }
      return jsonError(404, 'Not Found');
    }
    return jsonError(404, 'Not Found');
  }

  // POST/GET /api/v3/repos/{o}/{r}/pulls ; GET /pulls/{n} ; /files ; /merge
  if (tail[0] === 'pulls') {
    if (tail.length === 1 && method === 'POST') {
      const body = parseBody(req);
      if (body === null) return jsonError(400, 'Request body must be a JSON object');
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (title === undefined || head === undefined || base === undefined) return jsonError(422, 'title, head and base are required');
      const headSha = STORE.refCommit(repo, head);
      const baseSha = STORE.refCommit(repo, base);
      if (headSha === null || baseSha === null) return jsonError(422, 'head or base branch does not exist');
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return jsonError(422, 'A pull request already exists for these branches');
      const pull = STORE.createPull(repo, title, stringField(body, 'body') ?? '', head, base, headSha, baseSha);
      return jsonRes(201, pullObject(repo, pull));
    }
    if (tail.length === 1 && method === 'GET') {
      const state = req.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, linkHeader } = paginate(pulls, req.url);
      const headers: Record<string, string> = {};
      if (linkHeader !== null) headers.Link = linkHeader;
      return jsonRes(200, page.map((pull) => pullObject(repo, pull)), headers);
    }
    const number = Number(tail[1]);
    if (Number.isInteger(number)) {
      const pull = repo.pulls.get(number);
      if (pull === undefined) return jsonError(404, 'Not Found');
      if (tail.length === 2 && method === 'GET') return jsonRes(200, pullObject(repo, pull));
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        return jsonRes(
          200,
          STORE.pullFiles(repo, pull).map((file) => ({ ...file, sha: '', patch: '' })),
        );
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) return jsonError(405, 'Pull request is already merged or closed');
        if (STORE.pullConflict(repo, pull)) return jsonError(405, 'This branch has conflicts that must be resolved');
        const mergeOid = STORE.mergePull(repo, pull);
        if (mergeOid === null) return jsonError(405, 'This branch has conflicts that must be resolved');
        return jsonRes(200, { merged: true, sha: mergeOid, message: `${pull.title}\n\n${pull.body}\n` });
      }
      return jsonError(404, 'Not Found');
    }
    return jsonError(404, 'Not Found');
  }

  return jsonError(404, 'Not Found');
}

