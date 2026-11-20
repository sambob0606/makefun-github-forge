// store.ts — the in-memory model for the forge.
//
// One Store holds every repository. Each Repo carries its own git object
// database (a Map from oid to object) plus its refs, issues, pull requests,
// labels and comments, so REST, git smart HTTP, GraphQL and MCP all read
// and write the same state. Nothing here touches the clock: every stored
// timestamp comes from a monotonic sequence counter, so replaying the same
// request log leaves the state byte-identical.

import {
  hashObject,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjType,
} from './gitcore.ts';

export interface Author {
  name: string;
  email: string;
}

/** The identity REST-created commits are attributed to. */
export const DEFAULT_AUTHOR: Author = {
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

/** Deterministic epoch base (2025-01-01T00:00:00Z) plus the sequence. */
const TIME_BASE_MS = 1735689600000;

export function seqTime(seq: number): string {
  return new Date(TIME_BASE_MS + seq * 1000).toISOString();
}

export function seqEpoch(seq: number): number {
  return Math.floor(TIME_BASE_MS / 1000) + seq;
}

// ---------------------------------------------------------------------------
// Issues, pull requests, labels, comments
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  files: FileChange[];
  /** True when the three-way merge of head into base has no conflicts. */
  mergeable: boolean;
  /** Paths where head and base both changed away from the merge-base. */
  conflicts: string[];
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  nextLabel: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

// ---------------------------------------------------------------------------
// Git object helpers
// ---------------------------------------------------------------------------

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Build a commit object, store it, return its oid. */
export function makeCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
  author: Author,
  seq: number,
): string {
  const stamp = `${seqEpoch(seq)} +0000`;
  let text = `tree ${treeOid}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${author.name} <${author.email}> ${stamp}\n`;
  text += `committer ${author.name} <${author.email}> ${stamp}\n`;
  text += `\n${message}\n`;
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** Parse a stored commit object into its fields. */
export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  message: string;
} {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? ZERO_OID;
  const parents: string[] = [];
  for (const m of head.matchAll(/^parent ([0-9a-f]{40})$/gm)) parents.push(m[1]);
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Build a tree object from a flat path -> {oid, mode} map. Stores subtrees. */
export function buildTree(
  repo: Repo,
  files: Map<string, { oid: string; mode: string }>,
): string {
  // Group paths by their first segment.
  const byDir = new Map<string, Map<string, { oid: string; mode: string }>>();
  const direct: TreeEntry[] = [];
  for (const [path, entry] of files) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      direct.push({ mode: entry.mode, name: path, oid: entry.oid });
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let sub = byDir.get(dir);
      if (!sub) {
        sub = new Map();
        byDir.set(dir, sub);
      }
      sub.set(rest, entry);
    }
  }
  const entries: TreeEntry[] = [...direct];
  for (const [dir, sub] of byDir) {
    entries.push({ mode: '40000', name: dir, oid: buildTree(repo, sub) });
  }
  // Git sorts entries by name, treating directories as if named "name/".
  entries.sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

/** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(
  repo: Repo,
  treeOid: string,
  prefix = '',
): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === ZERO_OID) return out;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(repo, e.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

function splitLines(buf: Buffer): string[] {
  const text = buf.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Rough line diff: lines present in one side but not the other (multiset). */
export function lineDiff(oldBuf: Buffer, newBuf: Buffer): {
  additions: number;
  deletions: number;
} {
  const oldCounts = new Map<string, number>();
  for (const l of splitLines(oldBuf)) oldCounts.set(l, (oldCounts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of splitLines(newBuf)) {
    const n = oldCounts.get(l) ?? 0;
    if (n > 0) oldCounts.set(l, n - 1);
    else additions++;
  }
  let deletions = 0;
  for (const n of oldCounts.values()) deletions += n;
  return { additions, deletions };
}

/** Diff two trees; returns one FileChange per changed path. */
export function diffTrees(
  repo: Repo,
  baseTree: string,
  headTree: string,
): FileChange[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b && !h) {
      const oldBuf = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const { deletions } = lineDiff(oldBuf, Buffer.alloc(0));
      out.push({ filename: p, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const newBuf = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = splitLines(newBuf).length;
      out.push({ filename: p, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldBuf = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newBuf = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = lineDiff(oldBuf, newBuf);
      out.push({
        filename: p,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
  }
  return out;
}

/** All ancestors of a commit (including itself), as a set. */
export function ancestors(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  return seen;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === ZERO_OID) return true;
  if (anc === desc) return true;
  return ancestors(repo, desc).has(anc);
}

/** First common ancestor of two commits (BFS from `a` over `b`'s ancestors). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const bAnc = ancestors(repo, b);
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (bAnc.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  return null;
}

/**
 * Three-way merge analysis of `head` into `base`, both commits.
 * Returns the merged file map plus the conflicting paths.
 */
export function threeWayMerge(
  repo: Repo,
  baseCommit: string,
  headCommit: string,
): { files: Map<string, { oid: string; mode: string }>; conflicts: string[] } {
  const baseObj = repo.objects.get(baseCommit);
  const headObj = repo.objects.get(headCommit);
  const baseTree = baseObj?.type === 'commit' ? parseCommit(baseObj.data).tree : ZERO_OID;
  const headTree = headObj?.type === 'commit' ? parseCommit(headObj.data).tree : ZERO_OID;
  const mb = mergeBase(repo, baseCommit, headCommit);
  const mbTree = mb
    ? parseCommit(repo.objects.get(mb)!.data).tree
    : ZERO_OID;
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const mbFiles = flattenTree(repo, mbTree);
  const merged = new Map(baseFiles);
  const conflicts: string[] = [];
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const p of paths) {
    const m = mbFiles.get(p);
    const h = headFiles.get(p);
    const b = baseFiles.get(p);
    const headChanged = (m?.oid ?? null) !== (h?.oid ?? null);
    const baseChanged = (m?.oid ?? null) !== (b?.oid ?? null);
    if (!headChanged) continue;
    if (!baseChanged) {
      if (h) merged.set(p, h);
      else merged.delete(p);
    } else if ((b?.oid ?? null) !== (h?.oid ?? null)) {
      conflicts.push(p);
    }
  }
  return { files: merged, conflicts };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private seq = 1;

  nextSeq(): number {
    return this.seq++;
  }

  createRepo(
    owner: string,
    name: string,
    description = '',
    defaultBranch = 'main',
    isPrivate = false,
  ): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.repoIdSeq++,
      owner,
      name,
      description,
      defaultBranch,
      isPrivate,
      createdSeq: this.nextSeq(),
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      nextLabel: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Resolve a ref name (refs/heads/x or short branch name) to an oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const full = `refs/heads/${ref}`;
    return repo.refs.get(full);
  }

  /** The oid of the default branch head, or ZERO when the repo is empty. */
  headOid(repo: Repo): string {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  }
}
