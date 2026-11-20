// gitproto.ts — the git smart-HTTP wire protocol: pkt-lines, packfiles,
// protocol v2 (ls-refs, fetch) and protocol v0 (advertisement, fetch,
// receive-pack). Plain objects only in the packs this forge writes; packs
// it reads may carry ofs/ref deltas, which are resolved against the repo
// and the pack itself.
//
// The shapes here are dictated by the client in the competition kit
// (program/env/src/git-client.ts): section order and line formats in v2
// fetch responses, the sideband framing of v0 fetch and push reports, and
// the exact capability lists the client looks for.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  commitAncestors,
  commitTree,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  reachableObjects,
  reachableObjectsStopAt,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

export const AGENT = 'github-forge/1.0';

// ---------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one pkt-line from raw payload bytes. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const flushPkt = (): Buffer => Buffer.from('0000', 'ascii');
export const delimPkt = (): Buffer => Buffer.from('0001', 'ascii');

/** A reader that walks pkt-lines through a buffer, leaving the rest. */
export class PktReader {
  pos = 0;
  readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  next(): Pkt | null {
    if (this.pos >= this.buf.length) return null;
    if (this.pos + 4 > this.buf.length) throw new Error('truncated pkt-line header');
    const lenHex = this.buf.subarray(this.pos, this.pos + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      this.pos += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (len === 1) {
      this.pos += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (this.pos + len > this.buf.length) throw new Error('truncated pkt-line');
    const payload = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    return { kind: 'data', payload };
  }

  /** The bytes not yet consumed (the raw pack after a receive-pack flush). */
  rest(): Buffer {
    return this.buf.subarray(this.pos);
  }
}

/** Data packets' payloads as strings, until the first flush/delim/end. */
export function readTextSection(reader: PktReader): string[] {
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind !== 'data') return lines;
    lines.push(packet.payload.toString('utf8'));
  }
}

/** Encode bytes as sideband packets (band 1), chunked under the pkt-line cap. */
export function sideband(data: Buffer, band = 1): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  const chunkSize = 60000;
  for (let off = 0; off < data.length; off += chunkSize) {
    const chunk = data.subarray(off, Math.min(off + chunkSize, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeObjectHeader(type: number, size: number): Buffer {
  let remaining = size;
  let first = (remaining & 0x0f) | (type << 4);
  remaining >>>= 4;
  const bytes: number[] = [];
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining >>>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Serialize objects as a packfile (version 2, no deltas), oids sorted. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) {
    const obj = objects.get(oid) as GitObject;
    parts.push(encodeObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (p >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[p] as number;
      p += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p] as number;
    p += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) {
        offset = delta[p] as number;
        p += 1;
      }
      if (op & 0x02) {
        offset |= (delta[p] as number) << 8;
        p += 1;
      }
      if (op & 0x04) {
        offset |= (delta[p] as number) << 16;
        p += 1;
      }
      if (op & 0x08) {
        offset |= (delta[p] as number) << 24;
        p += 1;
      }
      if (op & 0x10) {
        size = delta[p] as number;
        p += 1;
      }
      if (op & 0x20) {
        size |= (delta[p] as number) << 8;
        p += 1;
      }
      if (op & 0x40) {
        size |= (delta[p] as number) << 16;
        p += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      chunks.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      if (p + op > delta.length) throw new Error('delta insert out of range');
      chunks.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(chunks);
  if (result.length !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Inflate one deflate stream starting at `off`. Node's inflateSync ignores
 * trailing bytes but throws on truncation, so the stream's exact end is the
 * smallest prefix that inflates — found by binary search.
 */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buf.length - off;
  if (hi <= 0) throw new Error('pack truncated at object data');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, off + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(off, off + lo));
  if (data.length !== expectedSize) throw new Error('pack object size mismatch');
  return { data, consumed: lo };
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile, resolving deltas against objects earlier in the same
 * pack and against `haveObjects` (the repo's store, for thin packs).
 */
export function readPack(pack: Buffer, haveObjects?: Map<string, GitObject>): ReadPackResult {
  if (pack.length === 0) return { objects: new Map(), deltaCount: 0 };
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (digest !== pack.subarray(pack.length - 20).toString('hex')) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    if (off >= pack.length - 20) throw new Error('pack truncated');
    let byte = pack[off] as number;
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (off >= pack.length - 20) throw new Error('pack truncated');
      byte = pack[off] as number;
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseType: ObjType | null = null;
    let baseData: Buffer | null = null;
    if (typeCode === 6) {
      deltaCount += 1;
      byte = pack[off] as number;
      off += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[off] as number;
        off += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseOid = byOffset.get(start - baseOffset);
      if (baseOid === undefined) throw new Error('ofs-delta base not in pack');
      const baseObj = objects.get(baseOid);
      if (baseObj === undefined) throw new Error('ofs-delta base missing');
      baseType = baseObj.type;
      baseData = baseObj.data;
    } else if (typeCode === 7) {
      deltaCount += 1;
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const baseObj = objects.get(baseOid) ?? haveObjects?.get(baseOid);
      if (baseObj === undefined) throw new Error(`ref-delta base ${baseOid} not found`);
      baseType = baseObj.type;
      baseData = baseObj.data;
    } else {
      baseType = CODE_TYPES[typeCode];
      if (baseType === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    }
    const { data: raw, consumed } = inflateAt(pack, off, size);
    off += consumed;
    const data = baseData === null ? raw : applyDelta(baseData, raw);
    const type = baseType as ObjType;
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
    byOffset.set(start, oid);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------
// Ref listing
// ---------------------------------------------------------------------------

export interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every ref of a repo, HEAD first, then branches and tags sorted. */
export function listRefs(repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({
    oid: headTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: headTip === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: ListedRef = { oid, name };
    const obj = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag') {
      entry.peeled = peelToCommit(repo, oid);
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisements (GET info/refs)
// ---------------------------------------------------------------------------

function v0CapabilityLine(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const base =
    service === 'git-upload-pack'
      ? 'side-band-64k multi_ack thin-pack ofs-delta shallow'
      : 'report-status side-band-64k delete-refs ofs-delta';
  return `${base} agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

/** The info/refs body for a service: v2 when the client asked for it. */
export function infoRefsBody(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): Buffer {
  const parts: Buffer[] = [];
  const serviceName = service === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  parts.push(pktLine(`# service=${serviceName}\n`), flushPkt());
  if (wantV2 && service === 'git-upload-pack') {
    parts.push(
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${AGENT}\n`),
      flushPkt(),
    );
    return Buffer.concat(parts);
  }
  // Protocol v0: the first ref line carries the capabilities after a NUL.
  const caps = v0CapabilityLine(repo, service);
  const refs = listRefs(repo);
  if (refs.length === 0 || (refs.length === 1 && refs[0]?.unborn === true)) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) {
        parts.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
      } else {
        parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      }
    });
    for (const ref of refs) {
      if (ref.peeled !== undefined && ref.name.startsWith('refs/tags/')) {
        parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

export interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  wantedRefs: Array<{ oid: string; ref: string }>;
}

/**
 * Which objects a fetch sends: everything reachable from the wants (cut off
 * at `depth` generations) minus everything reachable from the haves.
 * Boundary commits become the new shallow list; old shallow commits that
 * are now fully included become unshallow.
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldShallow: string[],
): FetchPlan {
  for (const want of wants) {
    if (!repo.objects.has(want)) throw new Error(`want ${want} is not known here`);
  }
  // Generations of commits reachable from the wants (tags peeled first).
  const generations = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (!generations.has(commit)) {
      generations.set(commit, 0);
      queue.push([commit, 0]);
    }
  }
  const included = new Set<string>();
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    // A commit queued twice keeps only its smallest generation; skip the stale entry.
    if ((generations.get(oid) ?? Infinity) < gen) continue;
    if (depth !== null && gen >= depth) continue;
    if (included.has(oid)) continue;
    included.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!generations.has(parent) || (generations.get(parent) as number) > gen + 1) {
        generations.set(parent, gen + 1);
      }
      queue.push([parent, gen + 1]);
    }
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of generations) {
      if (gen === depth - 1 && included.has(oid)) shallow.push(oid);
    }
    shallow.sort();
  }
  const unshallow = oldShallow.filter((oid) => included.has(oid) && !shallow.includes(oid)).sort();
  // Objects to send: reachable from wants (tags included) minus reachable
  // from haves, restricted to the included commit generations.
  const sendRoots = [...wants];
  for (const oid of included) sendRoots.push(oid);
  const sendReachable = reachableObjects(repo, sendRoots);
  // Restrict to the included commits' trees: drop commits beyond the depth.
  const allowed = new Set<string>();
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    allowed.add(oid);
    const tree = parseCommit(obj.data).tree;
    for (const reachable of reachableObjects(repo, [tree])) allowed.add(reachable);
  }
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type === 'tag') allowed.add(want);
  }
  const haveReachable = reachableObjectsStopAt(repo, haves, new Set(oldShallow));
  const objects = new Map<string, GitObject>();
  for (const oid of sendReachable) {
    if (!allowed.has(oid)) continue;
    if (haveReachable.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.set(oid, obj);
  }
  // ACK every have that is an ancestor of a want; otherwise NAK.
  const acks: string[] = [];
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    const haveCommit = peelToCommit(repo, have);
    const isAck = wants.some((want) => isAncestor(repo, haveCommit, peelToCommit(repo, want)));
    if (isAck) acks.push(have);
  }
  const nak = haves.length === 0 || acks.length === 0;
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of listRefs(repo)) {
    if (wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  return { objects, shallow, unshallow, acks, nak, wantedRefs };
}

interface CachedFetch {
  plan: FetchPlan;
  pack: Buffer;
}

/** Fetch plans keyed by repo, then by version + request shape. */
const planCache = new WeakMap<Repo, Map<string, CachedFetch>>();

/**
 * The plan and pack for a fetch request, computed once per repo version and
 * request shape. The clone workload issues 50 identical shallow clones, so
 * this turns 50 full reachability walks into one.
 */
export function cachedFetch(repo: Repo, request: FetchRequest): CachedFetch {
  const key = JSON.stringify([repo.version, request.wants, request.haves, request.depth, request.shallow]);
  let perRepo = planCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    planCache.set(repo, perRepo);
  }
  let entry = perRepo.get(key);
  if (entry === undefined) {
    const plan = planFetch(repo, request.wants, request.haves, request.depth, request.shallow);
    entry = { plan, pack: writePack(plan.objects) };
    if (perRepo.size > 64) perRepo.clear();
    perRepo.set(key, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Protocol v2: ls-refs
// ---------------------------------------------------------------------------

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function parseLsRefsRequest(body: Buffer): LsRefsRequest {
  const reader = new PktReader(body);
  // Two sections: the command block, then (after a delim) the arguments.
  const args = [...readTextSection(reader), ...readTextSection(reader)];
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenCommand = false;
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (!seenCommand) {
      if (text !== 'command=ls-refs') throw new Error(`expected command=ls-refs, got ${JSON.stringify(text)}`);
      seenCommand = true;
      continue;
    }
    if (text === 'peel') request.peel = true;
    else if (text === 'symrefs') request.symrefs = true;
    else if (text === 'unborn') request.unborn = true;
    else if (text.startsWith('ref-prefix ')) request.prefixes.push(text.slice('ref-prefix '.length));
  }
  return request;
}

/** The ls-refs v2 response: one line per matching ref, then a flush. */
export function lsRefsResponse(repo: Repo, request: LsRefsRequest): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  const refs = listRefs(repo);
  const hasRefs = refs.some((ref) => !ref.unborn);
  if (!hasRefs) {
    if (request.unborn && keep('HEAD')) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    for (const ref of refs) {
      if (ref.unborn === true) continue;
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (request.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      if (request.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Protocol v2: fetch
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export function parseV2FetchRequest(body: Buffer): FetchRequest {
  const reader = new PktReader(body);
  // Two sections: the command block, then (after a delim) the fetch arguments.
  const args = [...readTextSection(reader), ...readTextSection(reader)];
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenCommand = false;
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (!seenCommand) {
      if (text !== 'command=fetch') throw new Error(`expected command=fetch, got ${JSON.stringify(text)}`);
      seenCommand = true;
      continue;
    }
    if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (!Number.isInteger(n) || n < 1) throw new Error(`bad deepen ${JSON.stringify(text)}`);
      request.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, agent=, object-format=, done: no-ops.
  }
  return request;
}

/** The v2 fetch response: acknowledgments, shallow-info, wanted-refs, packfile. */
export function v2FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const { plan, pack } = cachedFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(delimPkt());
  parts.push(pktLine('shallow-info\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(delimPkt());
  parts.push(pktLine('wanted-refs\n'));
  for (const ref of plan.wantedRefs) parts.push(pktLine(`${ref.oid} ${ref.ref}\n`));
  parts.push(delimPkt());
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack, 1));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Protocol v0: fetch
// ---------------------------------------------------------------------------

export function parseV0FetchRequest(body: Buffer): FetchRequest {
  const reader = new PktReader(body);
  // Section 1: wants (features may ride on the first want line), shallow,
  // deepen — terminated by a flush. Section 2: haves and done.
  const first = readTextSection(reader);
  const second = readTextSection(reader);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of first) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      request.wants.push(text.slice(5).split(' ')[0] as string);
    } else if (text.startsWith('shallow ')) {
      request.shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (!Number.isInteger(n) || n < 1) throw new Error(`bad deepen ${JSON.stringify(text)}`);
      request.depth = n;
    }
  }
  for (const line of second) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
  }
  return request;
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, sideband pack. */
export function v0FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const { plan, pack } = cachedFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(pack, 1));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Protocol v0: receive-pack (push)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

export interface ReceivePackResult {
  unpackOk: boolean;
  unpackDetail: string;
  reports: PushReportLine[];
}

/** Parse the command list; the raw pack follows the flush. */
export function parseReceivePackRequest(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const reader = new PktReader(body);
  const lines = readTextSection(reader);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul < 0 ? text : text.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    commands.push({
      oldOid: parts[0] as string,
      newOid: parts[1] as string,
      ref: parts[2] as string,
    });
  }
  return { commands, pack: reader.rest() };
}

/**
 * Apply a push: unpack the pack, then apply each command independently so
 * one failing ref never blocks the others. A non-fast-forward update is
 * refused with the exact reason the client expects.
 */
export function applyReceivePack(repo: Repo, commands: PushCommand[], pack: Buffer): ReceivePackResult {
  const reports: PushReportLine[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    try {
      const read = readPack(pack, repo.objects);
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) putObject(repo, obj.type, obj.data);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpacker error';
    }
  }
  for (const command of commands) {
    if (!unpackOk && command.newOid !== ZERO_OID) {
      reports.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (!command.ref.startsWith('refs/heads/') && !command.ref.startsWith('refs/tags/')) {
      reports.push({ ref: command.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
      } else {
        repo.refs.delete(command.ref);
        repo.version += 1;
        repo.packCache.clear();
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      repo.version += 1;
      repo.packCache.clear();
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update.
    if (current === undefined) {
      reports.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      continue;
    }
    if (current !== command.oldOid) {
      reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    const oldCommit = peelToCommit(repo, command.oldOid);
    const newCommit = peelToCommit(repo, command.newOid);
    if (!isAncestor(repo, oldCommit, newCommit)) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    repo.version += 1;
    repo.packCache.clear();
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk, unpackDetail, reports };
}

/** The receive-pack report: pkt-lined lines inside sideband band 1. */
export function receivePackResponse(result: ReceivePackResult): Buffer {
  const inner: Buffer[] = [pktLine(`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`)];
  for (const report of result.reports) {
    if (report.ok) inner.push(pktLine(`ok ${report.ref}\n`));
    else inner.push(pktLine(`ng ${report.ref} ${report.reason}\n`));
  }
  return Buffer.concat([sideband(Buffer.concat(inner), 1), flushPkt()]);
}
