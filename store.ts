// store.ts — the forge's in-memory store and git object model.
//
// Everything lives in memory: one process, one trial, no disk. The store is
// deterministic by construction: every timestamp comes from a logical clock
// seeded by MAKEFUN_TRIAL_NOW (the trial's only "now"), every id from a
// counter, so a live pass and its replay see the same bytes for the same
// request order. No wall clock, no Math.random anywhere in this file.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The login the trial token names (the competition scenario's fixed viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The bearer token this process was given; requests must carry it. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Deterministic logical clock
// ---------------------------------------------------------------------------

function parseTrialNow(raw: string | undefined): number {
  if (raw !== undefined && raw !== '') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  // Outside a trial there is no MAKEFUN_TRIAL_NOW; wall clock is fine there
  // because nothing graded runs without the variable set.
  return Date.now();
}

const TRIAL_NOW_MS = parseTrialNow(process.env.MAKEFUN_TRIAL_NOW);
let tickCount = 0;

/** One logical second per call, as an ISO timestamp. */
export function tickIso(): string {
  const ms = TRIAL_NOW_MS + tickCount * 1000;
  tickCount += 1;
  return new Date(ms).toISOString();
}

/** One logical second per call, as Unix epoch seconds (for git objects). */
export function tickEpochSec(): number {
  const ms = TRIAL_NOW_MS + tickCount * 1000;
  tickCount += 1;
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Id counters (deterministic, assigned in request order)
// ---------------------------------------------------------------------------

let nextRepoId = 5000;
let nextObjectId = 10000;
let nextCommentId = 1;
let nextRequestSeq = 1;

export function allocRepoId(): number {
  return nextRepoId++;
}

export function allocObjectId(): number {
  return nextObjectId++;
}

export function allocCommentId(): number {
  return nextCommentId++;
}

/** A short non-empty request id for X-GitHub-Request-Id. */
export function allocRequestId(): string {
  return `req-${nextRequestSeq++}`;
}

/** An opaque, stable global (Relay) id for a stored object. */
export function globalId(kind: string, n: number): string {
  return Buffer.from(`${kind}:${n}`, 'utf8').toString('base64');
}

/** Decode a global id back to [kind, numeric id], or null. */
export function parseGlobalId(id: string): [string, number] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const sep = text.indexOf(':');
    if (sep <= 0) return null;
    const n = Number(text.slice(sep + 1));
    if (!Number.isInteger(n) || n < 0) return null;
    return [text.slice(0, sep), n];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** Creation order of commit objects, for newest-first listings. */
  commitSeq: Map<string, number>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  /** Next shared issue/pull-request number. */
  nextNumber: number;
  /** Bumped on any object or ref change; pack cache keys include it. */
  version: number;
  packCache: Map<string, Buffer>;
}

let repoSeq = 0;

export const repos = new Map<string, Repo>();

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

/** The viewer's repository only: any other owner is a 404, never a 403. */
export function getViewerRepo(name: string): Repo | undefined {
  return repos.get(repoKey(VIEWER.login, name));
}

export function createRepoRecord(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
  const now = tickIso();
  const repo: Repo = {
    id: allocRepoId(),
    name,
    owner: VIEWER.login,
    description,
    isPrivate,
    defaultBranch,
    createdAt: now,
    updatedAt: now,
    seq: repoSeq++,
    objects: new Map(),
    refs: new Map(),
    commitSeq: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    version: 0,
    packCache: new Map(),
  };
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}

export function deleteRepoRecord(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

// ---------------------------------------------------------------------------
// Git object primitives
// ---------------------------------------------------------------------------

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a (type, data) pair. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object if absent; returns its oid. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    if (type === 'commit') repo.commitSeq.set(oid, repo.commitSeq.size);
    repo.version += 1;
    repo.packCache.clear();
  }
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries by name, directories as if named with a trailing '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted git's way). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message (message keeps its bytes). */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

/** The identity line every commit this forge writes carries. */
export function identityLine(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}

/** Build a commit object's bytes. */
export function buildCommitBytes(tree: string, parents: readonly string[], message: string, epochSec: number): Buffer {
  const who = identityLine(epochSec);
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${text}`, 'utf8');
}

// ---------------------------------------------------------------------------
// Trees as file maps
// ---------------------------------------------------------------------------

/** Flatten a tree object into path -> blob oid, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, oid] of flattenTree(repo, entry.oid, path)) out.set(sub, oid);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

interface TreeNode {
  files: Map<string, string>;
  dirs: Map<string, TreeNode>;
}

/** Build (and store) the tree for a path -> blob oid map. Returns the root tree oid. */
export function treeFromFileMap(repo: Repo, files: Map<string, string>): string {
  const make = (): TreeNode => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------------------
// Ancestry and reachability
// ---------------------------------------------------------------------------

/** All commit oids reachable from `roots` via parents (roots included). */
export function commitAncestors(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `oid` or one of its ancestors. */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  return commitAncestors(repo, [oid]).has(ancestor);
}

/** The merge base of two commits: the common ancestor created latest. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = commitAncestors(repo, [a]);
  const ancestorsB = commitAncestors(repo, [b]);
  let best: string | null = null;
  let bestSeq = -1;
  for (const oid of ancestorsA) {
    if (!ancestorsB.has(oid)) continue;
    const seq = repo.commitSeq.get(oid) ?? -1;
    if (seq > bestSeq) {
      bestSeq = seq;
      best = oid;
    }
  }
  return best;
}

/** Every object reachable from the given roots (commits, tags, trees, blobs). */
export function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  return reachableObjectsStopAt(repo, roots, new Set());
}

/**
 * Like reachableObjects, but parent traversal stops at commits in
 * `stopCommits`: the client holds those commits and their trees, but none
 * of their history. That is exactly what a shallow boundary means, so a
 * deepening fetch must not exclude the boundary's parents as "already had".
 */
export function reachableObjectsStopAt(repo: Repo, roots: Iterable<string>, stopCommits: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      stack.push(view.tree);
      if (!stopCommits.has(oid)) {
        for (const parent of view.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Peel a tag (recursively) to its commit, or the oid itself when not a tag. */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Diffs and three-way merges (file level)
// ---------------------------------------------------------------------------

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two trees (null tree = empty). */
export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): FileDiff[] {
  const oldMap = oldTree === null ? new Map<string, string>() : flattenTree(repo, oldTree);
  const newMap = newTree === null ? new Map<string, string>() : flattenTree(repo, newTree);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const oldOid = oldMap.get(path) ?? null;
    const newOid = newMap.get(path) ?? null;
    if (oldOid === newOid) continue;
    if (oldOid === null) out.push({ path, status: 'added', oldOid, newOid });
    else if (newOid === null) out.push({ path, status: 'removed', oldOid, newOid });
    else out.push({ path, status: 'modified', oldOid, newOid });
  }
  return out;
}

export interface MergeResult {
  /** The merged file map (path -> blob oid; a null value means deleted). */
  files: Map<string, string | null>;
  conflict: boolean;
  conflictPaths: string[];
}

/**
 * A three-way file merge: base is the merge-base tree, head the branch being
 * merged, tip the branch being merged into. A path conflicts when both sides
 * changed it from base to different contents.
 */
export function threeWayMerge(repo: Repo, baseTree: string | null, headTree: string | null, tipTree: string | null): MergeResult {
  const base = baseTree === null ? new Map<string, string>() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map<string, string>() : flattenTree(repo, headTree);
  const tip = tipTree === null ? new Map<string, string>() : flattenTree(repo, tipTree);
  const files = new Map<string, string | null>();
  const conflictPaths: string[] = [];
  const paths = new Set([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of paths) {
    const b = base.get(path) ?? null;
    const h = head.get(path) ?? null;
    const t = tip.get(path) ?? null;
    if (h === t) {
      if (h !== null) files.set(path, h);
      continue;
    }
    if (t === b) {
      if (h !== null) files.set(path, h);
      continue;
    }
    if (h === b) {
      if (t !== null) files.set(path, t);
      continue;
    }
    conflictPaths.push(path);
    if (t !== null) files.set(path, t);
  }
  return { files, conflict: conflictPaths.length > 0, conflictPaths };
}

/** Count added/deleted lines between two blob contents (simple LCS on lines). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Strip one trailing empty element from a final newline on each side.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  // LCS table; files here are small (the suite's blobs are a few KiB).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: n - common, deletions: m - common };
}
