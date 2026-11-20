// The forge's store: one in-memory model shared by git smart HTTP, REST v3, GraphQL
// and MCP. No persistence is needed: every trial starts a fresh process and the suite
// builds all state through the API.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER } from './scenario.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// git object builders / parsers (the plain git formats, implemented here)
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitInput {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
  readonly message: string;
}

function identLine(ident: string, timestamp: number): string {
  return `${ident} ${timestamp} +0000`;
}

export function buildCommit(input: BuildCommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identLine(input.author, input.timestamp)}`);
  lines.push(`committer ${identLine(input.committer, input.timestamp)}`);
  lines.push('');
  lines.push(input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(input: { object: string; type: ObjectType; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${identLine(input.tagger, input.timestamp)}`,
    '',
    input.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `tips`, walking commits (parents + tree), trees
 * (entries) and tags (targets). `cutoff` commits are included with their trees but
 * their parents are not walked (a shallow boundary). Throws on a missing object.
 */
export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup, options: { cutoff?: ReadonlySet<string> } = {}): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const stack: string[] = [...tips];
  const cutoff = options.cutoff ?? new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (found.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    found.set(oid, object);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      if (!cutoff.has(oid)) for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return found;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The first commit reachable from both tips (merge-base), or null. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsOfA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = lookup(oid);
    if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) stackB.push(parent);
  }
  return null;
}

/** A flat map of path -> { oid, mode } for a tree, recursing into subtrees. */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build a tree object from a flat path map, creating intermediate trees as needed. */
export function buildTreeFromPaths(paths: ReadonlyMap<string, { oid: string; mode: string }>, put: (type: ObjectType, data: Buffer) => string): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of paths) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A packfile of plain (non-delta) objects, with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadEntry {
  readonly type: ObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

/** Read a packfile, resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { resolved?: { type: ObjectType; data: Buffer; oid: string } }).resolved;
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { resolved?: unknown }).resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// the forge's resources
// ---------------------------------------------------------------------------

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly userLogin: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly userLogin: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly databaseId: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  seq = 0;

  nowIso(): string {
    return new Date().toISOString();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): Repo {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      databaseId: id,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      createdAt: this.nowIso(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The tip commit of a ref name (branch, tag or full ref), or null. */
  refTip(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
    if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`) as string;
    return null;
  }

  /** The commit a ref resolves to (peeling annotated tags). */
  refCommit(repo: Repo, ref: string): string | null {
    const tip = this.refTip(repo, ref);
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (object === undefined) return null;
    if (object.type === 'tag') return parseTag(object.data).object;
    if (object.type === 'commit') return tip;
    return null;
  }

  headCommit(repo: Repo): string | null {
    return this.refCommit(repo, repo.defaultBranch);
  }

  /** Create a commit on `branch` that changes one path, returning its oid. */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string, options: { remove?: boolean } = {}): string {
    const tip = this.refTip(repo, branch);
    const baseCommit = tip === null ? this.headCommit(repo) : this.refCommit(repo, branch);
    const parents: string[] = [];
    let flat = new Map<string, { oid: string; mode: string }>();
    if (baseCommit !== null) {
      parents.push(baseCommit);
      const commitObject = repo.objects.get(baseCommit);
      if (commitObject?.type === 'commit') flat = flattenTree(parseCommit(commitObject.data).tree, this.lookup(repo));
    }
    if (options.remove === true) {
      flat.delete(path);
    } else {
      const blobOid = this.putObject(repo, 'blob', content);
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
    const treeOid = buildTreeFromPaths(flat, (type, data) => this.putObject(repo, type, data));
    const ident = `${VIEWER.name} <${VIEWER.email}>`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents,
        author: ident,
        committer: ident,
        timestamp: Math.floor(Date.now() / 1000),
        message,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** The blob oid + bytes at `path` on the commit `commitOid`, or null. */
  fileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commitObject = repo.objects.get(commitOid);
    if (commitObject?.type !== 'commit') return null;
    const flat = flattenTree(parseCommit(commitObject.data).tree, this.lookup(repo));
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const blob = repo.objects.get(entry.oid);
    if (blob?.type !== 'blob') return null;
    return { oid: entry.oid, data: blob.data };
  }

  /** The directory entries at `dirPath` on a commit (files and subdirs, one level). */
  dirAt(repo: Repo, commitOid: string, dirPath: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> | null {
    const commitObject = repo.objects.get(commitOid);
    if (commitObject?.type !== 'commit') return null;
    let treeOid = parseCommit(commitObject.data).tree;
    if (dirPath !== '') {
      // Walk to the subtree for dirPath.
      let current: string | null = treeOid;
      for (const segment of dirPath.split('/')) {
        if (current === null) return null;
        const object = repo.objects.get(current);
        if (object?.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (entry === undefined || entry.mode !== '40000') return null;
        current = entry.oid;
      }
      treeOid = current as string;
    }
    const object = repo.objects.get(treeOid);
    if (object?.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      oid: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.nowIso();
    const issue: Issue = {
      id: repo.databaseId * 100000 + number,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER.login,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.nowIso();
    const pull: Pull = {
      id: repo.databaseId * 100000 + number,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      userLogin: VIEWER.login,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The files a pull request changes (base tip tree vs head tip tree). */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const baseCommit = this.refCommit(repo, pull.baseRef);
    const headCommit = this.refCommit(repo, pull.headRef);
    const baseFlat = baseCommit === null ? new Map() : flattenTree(parseCommit(repo.objects.get(baseCommit)?.data ?? Buffer.alloc(0)).tree, this.lookup(repo));
    const headFlat = headCommit === null ? new Map() : flattenTree(parseCommit(repo.objects.get(headCommit)?.data ?? Buffer.alloc(0)).tree, this.lookup(repo));
    const files: PullFile[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      const baseText = base === undefined ? '' : (repo.objects.get(base.oid)?.data.toString('utf8') ?? '');
      const headText = head === undefined ? '' : (repo.objects.get(head.oid)?.data.toString('utf8') ?? '');
      const additions = head === undefined ? 0 : headText === '' ? 0 : headText.split('\n').length;
      const deletions = base === undefined ? 0 : baseText === '' ? 0 : baseText.split('\n').length;
      files.push({
        filename: path,
        status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  /** Whether merging `pull` would conflict (same path changed on both sides differently). */
  pullConflict(repo: Repo, pull: Pull): boolean {
    const baseTip = this.refCommit(repo, pull.baseRef);
    const headTip = this.refCommit(repo, pull.headRef);
    if (baseTip === null || headTip === null) return false;
    const base = mergeBase(baseTip, headTip, this.lookup(repo));
    if (base === null) return false;
    const baseCommit = repo.objects.get(base);
    if (baseCommit?.type !== 'commit') return false;
    const ancestorFlat = flattenTree(parseCommit(baseCommit.data).tree, this.lookup(repo));
    const baseCommitObject = repo.objects.get(baseTip);
    const headCommitObject = repo.objects.get(headTip);
    if (baseCommitObject?.type !== 'commit' || headCommitObject?.type !== 'commit') return false;
    const baseFlat = flattenTree(parseCommit(baseCommitObject.data).tree, this.lookup(repo));
    const headFlat = flattenTree(parseCommit(headCommitObject.data).tree, this.lookup(repo));
    const paths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path)?.oid;
      const onBase = baseFlat.get(path)?.oid;
      const onHead = headFlat.get(path)?.oid;
      const baseChanged = onBase !== ancestor;
      const headChanged = onHead !== ancestor;
      if (baseChanged && headChanged && onBase !== onHead) return true;
    }
    return false;
  }

  /** Squash-merge `pull` onto its base branch; returns the merge commit oid, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflict(repo, pull)) return null;
    const baseTip = this.refCommit(repo, pull.baseRef);
    const headTip = this.refCommit(repo, pull.headRef);
    if (baseTip === null || headTip === null) return null;
    const base = mergeBase(baseTip, headTip, this.lookup(repo));
    const baseCommitObject = repo.objects.get(baseTip);
    const headCommitObject = repo.objects.get(headTip);
    if (baseCommitObject?.type !== 'commit' || headCommitObject?.type !== 'commit') return null;
    const ancestorFlat = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree, this.lookup(repo));
    const baseFlat = flattenTree(parseCommit(baseCommitObject.data).tree, this.lookup(repo));
    const headFlat = flattenTree(parseCommit(headCommitObject.data).tree, this.lookup(repo));
    const merged = new Map(baseFlat);
    for (const [path, headEntry] of headFlat) {
      const ancestor = ancestorFlat.get(path)?.oid;
      const onBase = baseFlat.get(path)?.oid;
      if (headEntry.oid !== ancestor && onBase === ancestor) merged.set(path, headEntry);
    }
    for (const [path, ancestorEntry] of ancestorFlat) {
      if (!headFlat.has(path) && baseFlat.get(path)?.oid === ancestorEntry.oid) merged.delete(path);
    }
    const treeOid = buildTreeFromPaths(merged, (type, data) => this.putObject(repo, type, data));
    const ident = `${VIEWER.name} <${VIEWER.email}>`;
    const message = `${pull.title}\n\n${pull.body}\n`;
    const mergeOid = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents: [baseTip], author: ident, committer: ident, timestamp: Math.floor(Date.now() / 1000), message }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = mergeOid;
    pull.baseSha = mergeOid;
    pull.updatedAt = this.nowIso();
    return mergeOid;
  }
}

/** One process-wide store. */
export const STORE = new Store();

/** Global (Relay) ids: opaque base64, stable across reads. */
export function globalId(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
