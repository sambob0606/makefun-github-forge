// service.ts — domain operations shared by the REST, GraphQL and MCP
// surfaces. Every operation works on the store and returns either a value
// or a { status, message } error; the surfaces translate those into their
// own wire shapes, so the three views can never disagree about state.

import {
  VIEWER,
  allocCommentId,
  allocObjectId,
  buildCommitBytes,
  commitAncestors,
  commitTree,
  createRepoRecord as createRepoRecordImpl,
  diffTrees,
  flattenTree,
  getViewerRepo,
  globalId,
  hashObject,
  isAncestor,
  lineDiffCounts,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  repoKey,
  threeWayMerge,
  tickEpochSec,
  tickIso,
  treeFromFileMap,
  type FileDiff,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export interface ServiceError {
  status: number;
  message: string;
}

export function err(status: number, message: string): ServiceError {
  return { status, message };
}

export function isError(value: unknown): value is ServiceError {
  return typeof value === 'object' && value !== null && 'status' in value && 'message' in value;
}

// ---------------------------------------------------------------------------
// Views (the GitHub JSON shapes)
// ---------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
    gravatar_id: '',
    url: '/api/v3/users/adaiversen',
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  const openPulls = repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues + openPulls,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    url: `/api/v3/labels/${label.id}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map(labelJson),
    state: issue.state,
    locked: false,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    mergeable_state: pullMergedState(repo, pull),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    author_association: 'OWNER',
  };
}

/** Whether a pull request merges cleanly right now (three-way, file level). */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return false;
  const base = mergeBase(repo, headTip, baseTip);
  const merged = threeWayMerge(repo, base === null ? null : commitTree(repo, base), commitTree(repo, headTip), commitTree(repo, baseTip));
  return !merged.conflict;
}

function pullMergedState(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'merged';
  if (pull.state === 'closed') return 'closed';
  return pullMergeable(repo, pull) ? 'clean' : 'dirty';
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export function createRepo(name: string, isPrivate: boolean, description: string, defaultBranch?: string): Repo | ServiceError {
  if (typeof name !== 'string' || name.trim() === '') return err(422, 'name is required');
  if (name.length > 100) return err(422, 'name is too long');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name contains invalid characters');
  if (getViewerRepo(name) !== undefined) return err(422, 'Repository already exists');
  return createRepoRecordImpl(name, isPrivate, description, defaultBranch ?? 'main');
}

export function resolveRef(repo: Repo, ref: string): string | null {
  // A branch name, a full ref, or a bare object id.
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) return ref.toLowerCase();
  return null;
}

/** The tip commit of a repo's default branch, or null when unborn. */
export function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------------------
// Contents (files committed through the API)
// ---------------------------------------------------------------------------

export interface ContentPutResult {
  contentSha: string;
  commitSha: string;
  created: boolean;
}

function commitFiles(repo: Repo, branch: string, files: Map<string, string>, message: string): string {
  const tree = treeFromFileMap(repo, files);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip === undefined ? [] : [tip];
  const commit = putObject(repo, 'commit', buildCommitBytes(tree, parents, message, tickEpochSec()));
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo.version += 1;
  repo.packCache.clear();
  repo.updatedAt = tickIso();
  return commit;
}

/**
 * Create or update a file on a branch. `sha` is the blob sha the caller
 * believes is current; a mismatch is a 409. Returns the blob and commit shas.
 */
export function putContent(
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
  branch?: string,
  sha?: string,
): ContentPutResult | ServiceError {
  const target = branch ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${target}`);
  if (tip === undefined && repo.refs.size > 0) return err(404, `branch ${target} not found`);
  const blobOid = putObject(repo, 'blob', content);
  const files = tip === undefined ? new Map<string, string>() : flattenTree(repo, commitTree(repo, tip) as string);
  const current = files.get(path) ?? null;
  if (current !== null) {
    if (sha !== undefined && sha.toLowerCase() !== current.toLowerCase()) return err(409, 'sha does not match the current file');
    files.set(path, blobOid);
    const commitSha = commitFiles(repo, target, files, message);
    return { contentSha: blobOid, commitSha, created: false };
  }
  files.set(path, blobOid);
  const commitSha = commitFiles(repo, target, files, message);
  return { contentSha: blobOid, commitSha, created: true };
}

export function deleteContent(repo: Repo, path: string, message: string, branch?: string, sha?: string): { commitSha: string } | ServiceError {
  const target = branch ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${target}`);
  if (tip === undefined) return err(404, 'file not found');
  const files = flattenTree(repo, commitTree(repo, tip) as string);
  const current = files.get(path) ?? null;
  if (current === null) return err(404, 'file not found');
  if (sha !== undefined && sha.toLowerCase() !== current.toLowerCase()) return err(409, 'sha does not match the current file');
  files.delete(path);
  const commitSha = commitFiles(repo, target, files, message);
  return { commitSha };
}

export type ContentEntry =
  | { kind: 'file'; name: string; path: string; sha: string; size: number; content: Buffer }
  | { kind: 'dir'; name: string; path: string; sha: string; entries: ContentEntry[] };

/** Read a path out of a branch tip's tree (or the repo root when path is ''). */
export function readContent(repo: Repo, path: string, ref?: string): ContentEntry | ServiceError {
  const tipRef = ref ?? repo.defaultBranch;
  const tip = resolveRef(repo, tipRef);
  if (tip === undefined || tip === null) return err(404, 'reference not found');
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return err(404, 'file not found');
  if (path === '' || path === '/') {
    return { kind: 'dir', name: '', path: '', sha: treeOid, entries: listTreeEntries(repo, treeOid, '') };
  }
  const segments = path.split('/').filter((s) => s !== '');
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    const obj = repo.objects.get(currentTree);
    if (obj === undefined || obj.type !== 'tree') return err(404, 'file not found');
    const entry = parseTree(obj.data).find((e) => e.name === segment);
    if (entry === undefined) return err(404, 'file not found');
    const isLast = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (isLast) {
        return { kind: 'dir', name: segment, path: segments.join('/'), sha: entry.oid, entries: listTreeEntries(repo, entry.oid, segments.join('/')) };
      }
      currentTree = entry.oid;
      continue;
    }
    if (!isLast) return err(404, 'file not found');
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return err(404, 'file not found');
    return { kind: 'file', name: segment, path: segments.join('/'), sha: entry.oid, size: blob.data.length, content: blob.data };
  }
  return err(404, 'file not found');
}

function listTreeEntries(repo: Repo, treeOid: string, prefix: string): ContentEntry[] {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  const out: ContentEntry[] = [];
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ kind: 'dir', name: entry.name, path, sha: entry.oid, entries: listTreeEntries(repo, entry.oid, path) });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ kind: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0, content: blob?.data ?? Buffer.alloc(0) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Branches, refs and commits
// ---------------------------------------------------------------------------

export function createRef(repo: Repo, ref: string, sha: string): { ref: string; sha: string } | ServiceError {
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, 'ref must start with refs/heads/ or refs/tags/');
  if (!/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha.toLowerCase())) return err(422, 'sha does not exist');
  const oid = sha.toLowerCase();
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  repo.refs.set(ref, oid);
  repo.version += 1;
  repo.packCache.clear();
  return { ref, sha: oid };
}

export interface CommitListEntry {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  parents: string[];
  tree: string;
}

/** Commits reachable from `ref` (default branch), newest first. */
export function listCommits(repo: Repo, ref?: string): CommitListEntry[] {
  const tip = ref === undefined ? defaultTip(repo) : resolveRef(repo, ref);
  if (tip === null || tip === undefined) return [];
  const reachable = commitAncestors(repo, [tip]);
  const entries: CommitListEntry[] = [];
  for (const oid of reachable) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    const author = parseIdentity(view.author);
    entries.push({
      sha: oid,
      message: view.message.replace(/\n+$/, ''),
      authorName: author.name,
      authorEmail: author.email,
      date: author.date,
      parents: view.parents,
      tree: view.tree,
    });
  }
  entries.sort((a, b) => (repo.commitSeq.get(b.sha) ?? 0) - (repo.commitSeq.get(a.sha) ?? 0));
  return entries;
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  const epoch = Number(match[3]);
  return { name: match[1] as string, email: match[2] as string, date: new Date(epoch * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// Labels, issues and comments
// ---------------------------------------------------------------------------

export function createLabel(repo: Repo, name: string, color: string, description: string): Label | ServiceError {
  if (typeof name !== 'string' || name === '') return err(422, 'name is required');
  if (repo.labels.has(name)) return err(422, 'label already exists');
  const label: Label = { id: allocObjectId(), name, color: color || 'ededed', description: description || '' };
  repo.labels.set(name, label);
  return label;
}

export function createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | ServiceError {
  if (typeof title !== 'string' || title === '') return err(422, 'title is required');
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) return err(422, `label "${name}" does not exist`);
    labels.push(label);
  }
  const now = tickIso();
  const issue: Issue = {
    id: allocObjectId(),
    number: repo.nextNumber++,
    title,
    body: body ?? '',
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    seq: repo.issues.length + repo.pulls.length,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

export function listIssues(repo: Repo, state: string, sort: string, direction: string): Issue[] {
  let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  if (sort === 'created') {
    list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    list = [...list].sort((a, b) => b.seq - a.seq);
  }
  return list;
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

export function patchIssue(repo: Repo, issue: Issue, patch: { state?: string; title?: string; body?: string }): Issue | ServiceError {
  if (patch.state !== undefined) {
    if (patch.state !== 'open' && patch.state !== 'closed') return err(422, 'state must be open or closed');
    issue.state = patch.state;
    issue.closedAt = patch.state === 'closed' ? tickIso() : null;
  }
  if (patch.title !== undefined) issue.title = patch.title;
  if (patch.body !== undefined) issue.body = patch.body;
  issue.updatedAt = tickIso();
  return issue;
}

export function createIssueComment(repo: Repo, issue: Issue, body: string): { id: number; body: string; createdAt: string; updatedAt: string } | ServiceError {
  if (typeof body !== 'string' || body === '') return err(422, 'body is required');
  const now = tickIso();
  const comment = { id: allocCommentId(), body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export function createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | ServiceError {
  if (typeof title !== 'string' || title === '') return err(422, 'title is required');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  if (headTip === undefined) return err(422, `head branch "${head}" does not exist`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (baseTip === undefined) return err(422, `base branch "${base}" does not exist`);
  const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
  if (existing !== undefined) return err(422, 'A pull request already exists for this head and base');
  const now = tickIso();
  const pull: Pull = {
    id: allocObjectId(),
    number: repo.nextNumber++,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    createdAt: now,
    updatedAt: now,
    seq: repo.issues.length + repo.pulls.length,
  };
  repo.pulls.push(pull);
  return pull;
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

export function listPulls(repo: Repo, state: string): Pull[] {
  const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  return [...list].sort((a, b) => b.seq - a.seq);
}

export interface PullFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export function pullFiles(repo: Repo, pull: Pull): PullFileEntry[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  // The diff is between the pull's recorded base sha and head sha, so a merge
  // afterwards does not rewrite what the pull changed.
  const baseTree = baseTip === undefined ? null : commitTree(repo, pull.baseSha);
  const headTree = headTip === undefined ? null : commitTree(repo, pull.headSha);
  const diffs: FileDiff[] = diffTrees(repo, baseTree, headTree);
  return diffs.map((diff) => {
    let additions = 0;
    let deletions = 0;
    if (diff.status === 'added' && diff.newOid !== null) {
      const blob = repo.objects.get(diff.newOid);
      const text = blob?.data.toString('utf8') ?? '';
      additions = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } else if (diff.status === 'removed' && diff.oldOid !== null) {
      const blob = repo.objects.get(diff.oldOid);
      const text = blob?.data.toString('utf8') ?? '';
      deletions = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } else if (diff.status === 'modified' && diff.oldOid !== null && diff.newOid !== null) {
      const oldBlob = repo.objects.get(diff.oldOid);
      const newBlob = repo.objects.get(diff.newOid);
      const counts = lineDiffCounts(oldBlob?.data.toString('utf8') ?? '', newBlob?.data.toString('utf8') ?? '');
      additions = counts.additions;
      deletions = counts.deletions;
    }
    return {
      filename: diff.path,
      status: diff.status === 'modified' ? 'modified' : diff.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
}

/**
 * Squash-merge an open pull request onto its base branch. Creates one commit
 * whose tree is the three-way merge of base tip, head tip and merge base.
 */
export function mergePull(repo: Repo, pull: Pull): { sha: string; message: string } | ServiceError {
  if (pull.state !== 'open') return err(405, 'Pull request is already closed');
  if (pull.merged) return err(405, 'Pull request is already merged');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return err(422, 'head or base branch is missing');
  const base = mergeBase(repo, headTip, baseTip);
  const merged = threeWayMerge(
    repo,
    base === null ? null : commitTree(repo, base),
    commitTree(repo, headTip),
    commitTree(repo, baseTip),
  );
  if (merged.conflict) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
  const files = new Map<string, string>();
  for (const [path, oid] of merged.files) {
    if (oid !== null) files.set(path, oid);
  }
  const tree = treeFromFileMap(repo, files);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const commit = putObject(repo, 'commit', buildCommitBytes(tree, [baseTip], message, tickEpochSec()));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  repo.version += 1;
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = tickIso();
  pull.mergeCommitSha = commit;
  pull.updatedAt = tickIso();
  repo.updatedAt = tickIso();
  return { sha: commit, message };
}

export { repoKey };
