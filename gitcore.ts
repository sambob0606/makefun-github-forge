// gitcore.ts — the git object model, packfile codec and pkt-line framing for the
// forge. Written from the git wire format and the kit's protocol rules only.
// No git binary, no dependencies: node:crypto for SHA-1, node:zlib for pack data.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** The SHA-1 object id of `type` + `data`, as git computes it. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}


// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one pkt-line (4 hex length digits + payload). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLines(parts: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(pktFlush());
    else if (part === 'delim') out.push(pktDelim());
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/** Parse a whole buffer of pkt-lines. Throws on a malformed frame. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return packets;
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries (git-canonical order). */
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
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface CommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

/** Build a commit object. The identity strings are `Name <email>`; the timestamp is epoch seconds. */
export function buildCommit(fields: CommitFields): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  const stamp = `${fields.timestamp} +0000`;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${stamp}`);
  lines.push(`committer ${fields.committer} ${stamp}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  const stamp = `${fields.timestamp} +0000`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${stamp}\n\n${message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buffer[off] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    off += 1;
  }
  return { size, next: off, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let baseOffset = byte & 0x7f;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buffer[off] ?? 0;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    off += 1;
  }
  return { baseOffset, next: off };
}

/** Inflate a zlib stream starting at `offset`; returns the data and the offset just past it. */
export function inflateEntry(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // Binary-search the smallest end offset whose inflate succeeds and whose
  // trailing bytes look like a new object header is unnecessary: instead use
  // zlib's streaming API through a manual window. Node exposes no consumed-byte
  // count on inflateSync, so decode with a chunked Inflater via `node:zlib`
  // createInflate and feed bytes until it emits 'end'.
  // Simpler correct approach: try candidate ends with doubling + binary search
  // on the smallest length that inflates cleanly to a complete stream.
  let lo = offset + 2;
  let hi = buffer.length;
  const ok = (end: number): Buffer | null => {
    try {
      return inflateSync(buffer.subarray(offset, end));
    } catch {
      return null;
    }
  };
  // A complete zlib stream ends with adler32; a truncated stream throws.
  // First find any working end by exponential probing.
  let probe = lo;
  let found: Buffer | null = null;
  let foundEnd = -1;
  while (probe <= hi) {
    const data = ok(probe);
    if (data !== null) {
      found = data;
      foundEnd = probe;
      break;
    }
    probe = Math.min(hi, probe * 2 + 16);
    if (probe === hi) {
      const data2 = ok(hi);
      if (data2 !== null) {
        found = data2;
        foundEnd = hi;
      }
      break;
    }
  }
  if (found === null || foundEnd < 0) throw new Error('pack entry does not inflate');
  // Binary-search the smallest working end between offset+2 and foundEnd.
  let a = lo;
  let b = foundEnd;
  let best = foundEnd;
  let bestData = found;
  while (a <= b) {
    const mid = Math.floor((a + b) / 2);
    const data = ok(mid);
    if (data !== null) {
      best = mid;
      bestData = data;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  return { data: bestData, next: best };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVar();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVar();
  const chunks: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++] ?? 0;
    if (op & 0x80) {
      let srcOff = 0;
      let srcSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) srcOff |= (delta[off++] ?? 0) << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) srcSize |= (delta[off++] ?? 0) << (8 * i);
      if (srcSize === 0) srcSize = 0x10000;
      chunks.push(base.subarray(srcOff, srcOff + srcSize));
      total += srcSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackReadResult {
  objects: GitObject[];
  version: number;
  declaredCount: number;
  deltaCount: number;
}

/** Parse a packfile (v2/v3), resolving OFS/REF deltas. Throws on corruption. */
export function parsePack(pack: Buffer): PackReadResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack header is not PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateEntry(pack, offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes before trailer');

  const objects: GitObject[] = [];
  const byOid = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    const known = entry.typeCode !== 6 && entry.typeCode !== 7
      ? byOid.get(hashObject(CODE_TYPE[entry.typeCode], entry.data))
      : undefined;
    if (known !== undefined) return known;
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
      deltaCount += 1;
    } else if (entry.typeCode === 7) {
      const base = byOid.get(entry.baseOid ?? '');
      if (!base) throw new Error('ref-delta base not in pack');
      type = base.type;
      data = applyDelta(base.data, entry.data);
      deltaCount += 1;
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    resolving.delete(entry.offset);
    const obj: GitObject = { type, data };
    const oid = hashObject(type, data);
    if (!byOid.has(oid)) byOid.set(oid, obj);
    return obj;
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    const oid = hashObject(obj.type, obj.data);
    if (!objects.some((o) => hashObject(o.type, o.data) === oid)) objects.push(obj);
  }
  return { objects, version, declaredCount, deltaCount };
}

function packObjectHeader(type: ObjType, size: number): Buffer {
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

/** Build a packfile of plain (non-delta) objects, with a SHA-1 trailer. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** An empty pack (zero objects), still checksummed. */
export function emptyPack(): Buffer {
  return buildPack([]);
}
