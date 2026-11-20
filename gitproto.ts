// The git smart-HTTP surface: protocol v2 (upload-pack) and v0 (receive-pack),
// plus the pkt-line and packfile plumbing. Packs are plain (non-delta) objects;
// incoming packs may carry OFS/REF deltas and are resolved on the way in.

import type { Repo } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
} from './store.ts';

export const AGENT = 'makefun-forge/1.0';

function hexLength(length: number): string {
  return length.toString(16).padStart(4, '0');
}

/** One pkt-line framing `payload` (a Buffer, or a string encoded as utf8). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(hexLength(length), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktLine {
  readonly kind: 'data' | 'flush' | 'delim' | 'end';
  readonly data: Buffer;
}

/** Decode a pkt-line stream into lines (data payloads are raw bytes). */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(hex, 16);
    if (Number.isNaN(length)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    if (length === 0) {
      lines.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      lines.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      lines.push({ kind: 'end', data: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line body');
      lines.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return lines;
}

export function pktText(line: PktLine): string {
  return line.data.toString('utf8');
}

/** One sideband packet: band 1 = data, 2 = progress, 3 = error. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Wrap a report stream (inner pkt-lines) in side-band-64k packets. */
export function sidebandReport(innerLines: string[]): Buffer {
  const inner = Buffer.concat([...innerLines.map((line) => pktLine(line)), FLUSH]);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += 65500) {
    chunks.push(sidebandPacket(1, inner.subarray(offset, offset + 65500)));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

interface RefRow {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
}

function refRows(repo: Repo): RefRow[] {
  const rows: RefRow[] = [];
  const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of sorted) {
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object?.type === 'tag') peeled = parseTag(object.data).object;
    rows.push({ oid, name, peeled });
  }
  return rows;
}

const UPLOAD_V2_CAPABILITIES = [
  'ls-refs=unborn',
  'fetch=shallow filter',
  'object-format=sha1',
  `agent=${AGENT}`,
];

export function v2Advertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH, pktLine('version 2\n')];
  for (const capability of UPLOAD_V2_CAPABILITIES) parts.push(pktLine(`${capability}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

const UPLOAD_V0_CAPABILITIES = [
  'symref=HEAD:refs/heads/main',
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  `agent=${AGENT}`,
  'object-format=sha1',
];

export function v0Advertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const rows = refRows(repo);
  const head = repo.refs.get('refs/heads/main') ?? repo.refs.get('HEAD') ?? ZERO_OID;
  const caps = UPLOAD_V0_CAPABILITIES.join(' ');
  parts.push(pktLine(`${head} HEAD\0${caps}\n`));
  for (const row of rows) {
    parts.push(pktLine(`${row.oid} ${row.name}\n`));
    if (row.peeled !== undefined) parts.push(pktLine(`${row.peeled} ${row.name}^{}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

const RECEIVE_CAPABILITIES = [
  'report-status',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  'thin-pack',
  'shallow',
  `agent=${AGENT}`,
  'symref=HEAD:refs/heads/main',
];

export function receiveAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const rows = refRows(repo);
  const head = repo.refs.get('refs/heads/main') ?? repo.refs.get('HEAD') ?? ZERO_OID;
  const caps = RECEIVE_CAPABILITIES.join(' ');
  parts.push(pktLine(`${head} HEAD\0${caps}\n`));
  for (const row of rows) {
    parts.push(pktLine(`${row.oid} ${row.name}\n`));
    if (row.peeled !== undefined) parts.push(pktLine(`${row.peeled} ${row.name}^{}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export function lsRefs(repo: Repo, args: { peel?: boolean; symrefs?: boolean; unborn?: boolean; prefixes?: string[] }): Buffer {
  const parts: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headTarget = repo.refs.get(defaultRef);
  const prefixes = args.prefixes ?? [];
  // With a prefix filter only refs matching a prefix are returned — the HEAD
  // line is not a ref and is omitted (an unmatched prefix returns no refs).
  if (prefixes.length === 0) {
    if (headTarget !== undefined) {
      const object = repo.objects.get(headTarget);
      const peeled = args.peel === true && object?.type === 'tag' ? parseTag(object.data).object : undefined;
      parts.push(pktLine(`${headTarget} HEAD${args.symrefs === true ? ` symref-target:${defaultRef}` : ''}${peeled !== undefined ? ` peeled:${peeled}` : ''}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} HEAD${args.symrefs === true ? ` symref-target:${defaultRef}` : ''}\n`));
    }
  }
  for (const row of refRows(repo)) {
    if (args.prefixes !== undefined && args.prefixes.length > 0 && !args.prefixes.some((prefix) => row.name.startsWith(prefix))) continue;
    const object = repo.objects.get(row.oid);
    const peeled = args.peel === true && object?.type === 'tag' ? parseTag(object.data).object : undefined;
    parts.push(pktLine(`${row.oid} ${row.name}${peeled !== undefined ? ` peeled:${peeled}` : ''}\n`));
  }
  if (args.unborn === true) {
    // A branch that exists as a ref with no commits cannot happen here; the
    // empty-repo HEAD line above already carries the unborn form.
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (protocol v2)
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
}

interface FetchPlan {
  /** Objects to send (not counting those the client already has). */
  send: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/** Commit depth from the wants, following parents (depth 0 = the wants). */
function commitDepths(tips: string[], lookup: (oid: string) => GitObject | undefined): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((tip) => [tip, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, depth] = queue.shift() as [string, number];
    if (depths.has(oid)) continue;
    depths.set(oid, depth);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
  }
  return depths;
}

export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = (oid: string) => repo.objects.get(oid);
  const haveSet = new Map<string, GitObject>();
  if (request.haves.length > 0) {
    try {
      const clientShallow = new Set(request.shallow);
      for (const [oid, object] of collectReachable(request.haves, lookup, { cutoff: clientShallow })) haveSet.set(oid, object);
    } catch {
      // A have the server cannot resolve means the client is out of sync; treat
      // it as an empty have-set rather than failing the fetch.
      haveSet.clear();
    }
  }

  const send = new Map<string, GitObject>();
  const newShallow = new Set<string>();
  const depths = request.deepen !== undefined ? commitDepths(request.wants, lookup) : new Map<string, number>();
  const boundary = new Set<string>();

  for (const want of request.wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!haveSet.has(want)) send.set(want, object);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject !== undefined) {
        // Tag wants share the depth of the tag itself.
        collectReachable([target], lookup, {}).forEach((value, key) => send.set(key, value));
      }
      continue;
    }
    if (request.deepen === undefined) {
      collectReachable([want], lookup, {}).forEach((value, key) => send.set(key, value));
    } else {
      const limit = request.deepen;
      const included = new Map<string, GitObject>();
      for (const [commit, depth] of depths) {
        if (depth < limit) {
          collectReachable([commit], lookup, { cutoff: new Set([commit]) }).forEach((value, key) => included.set(key, value));
        }
      }
      for (const [key, value] of included) send.set(key, value);
      for (const [commit, depth] of depths) {
        if (depth !== limit - 1) continue;
        const objectAtBoundary = lookup(commit);
        if (objectAtBoundary?.type !== 'commit') continue;
        const parents = parseCommit(objectAtBoundary.data).parents;
        if (parents.length > 0 && parents.some((parent) => !depths.has(parent) || (depths.get(parent) as number) >= limit)) {
          boundary.add(commit);
        }
      }
      for (const commit of depths.keys()) {
        if (depths.get(commit) === limit - 1 && boundary.has(commit)) newShallow.add(commit);
      }
    }
  }

  // A former shallow boundary is unshallowed once its parents are available to
  // the client — whether they arrived in this pack or were already held.
  const unshallow: string[] = [];
  for (const old of request.shallow) {
    const object = lookup(old);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => send.has(parent) || haveSet.has(parent))) unshallow.push(old);
  }

  // Remove everything the client already holds.
  for (const oid of [...send.keys()]) if (haveSet.has(oid)) send.delete(oid);

  return { send, shallow: [...newShallow].sort(), unshallow: unshallow.sort() };
}

export function fetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.send.values());
  for (let offset = 0; offset < pack.length; offset += 65500) {
    parts.push(sidebandPacket(1, pack.subarray(offset, offset + 65500)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse a receive-pack POST body into commands plus the trailing pack bytes. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart: number | null = null;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in push');
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('invalid pkt-line in push');
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    const data = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = data.indexOf('\0');
    const text = nul < 0 ? data : data.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text);
    if (match === null) throw new Error(`unparsable push command ${JSON.stringify(text)}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    offset += length;
  }
  if (packStart === null) throw new Error('push body has no terminating flush');
  return { commands, pack: body.subarray(packStart) };
}

export interface PushResult {
  readonly unpackOk: boolean;
  readonly unpackError?: string;
  readonly reports: Array<{ ref: string; ok: boolean; reason?: string }>;
}

export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer): PushResult {
  const reports: PushResult['reports'] = [];
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let incoming = new Map<string, GitObject>();
  if (needsPack) {
    if (pack.length === 0) {
      return { unpackOk: false, unpackError: 'missing packfile', reports: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'missing packfile' })) };
    }
    try {
      incoming = readPack(pack, (oid) => repo.objects.get(oid));
    } catch (error) {
      return {
        unpackOk: false,
        unpackError: error instanceof Error ? error.message : 'corrupt packfile',
        reports: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
      };
    }
    for (const [oid, object] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  // Connectivity: every new commit's reachable set must resolve.
  for (const command of commands) {
    if (command.newOid === ZERO_OID) continue;
    try {
      collectReachable([command.newOid], (oid) => repo.objects.get(oid));
    } catch {
      return {
        unpackOk: false,
        unpackError: `pack does not contain the objects for ${command.newOid}`,
        reports: commands.map((candidate) => ({ ref: candidate.ref, ok: false, reason: 'unpack failed' })),
      };
    }
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== command.oldOid && command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        reports.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (current !== command.oldOid) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(current, command.newOid, (oid) => repo.objects.get(oid))) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true });
  }
  return { unpackOk: true, reports };
}

export function pushResponse(result: PushResult): Buffer {
  const lines: string[] = [];
  if (result.unpackOk) lines.push('unpack ok\n');
  else lines.push(`unpack ${result.unpackError ?? 'failed'}\n`);
  for (const report of result.reports) {
    lines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason ?? 'rejected'}\n`);
  }
  return sidebandReport(lines);
}

// ---------------------------------------------------------------------------
// request parsing helpers shared by the HTTP layer
// ---------------------------------------------------------------------------

export interface V2Command {
  readonly command: string;
  readonly args: string[];
  readonly options: Map<string, string>;
}

export function parseV2Request(body: Buffer): V2Command {
  const lines = decodePktLines(body);
  let command: string | null = null;
  const args: string[] = [];
  const options = new Map<string, string>();
  let inArgs = false;
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = pktText(line).trimEnd();
    if (command === null) {
      if (!text.startsWith('command=')) throw new Error(`expected a command line, got ${JSON.stringify(text)}`);
      command = text.slice('command='.length);
      continue;
    }
    if (!inArgs) {
      const equals = text.indexOf('=');
      if (equals > 0) options.set(text.slice(0, equals), text.slice(equals + 1));
      else options.set(text, '');
      continue;
    }
    args.push(text);
  }
  if (command === null) throw new Error('no command in v2 request');
  return { command, args, options };
}

