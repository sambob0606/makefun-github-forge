// gitproto.ts — git smart HTTP (upload-pack / receive-pack, v0 and v2).
//
// The wire shapes here follow the git protocol itself: pkt-line framing,
// the v0 advertisement with capabilities after NUL on the first ref line,
// the v2 advertisement (`version 2` + capabilities), ls-refs / fetch
// commands, sideband-wrapped packfiles, and the report-status reply for
// receive-pack. Packs are always plain objects (no deltas) with a SHA-1
// trailer, built and parsed by gitcore.ts.

import {
  ZERO_OID,
  buildPack,
  emptyPack,
  hashObject,
  parseCommit,
  parsePack,
  parsePktLines,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  type GitObject,
} from './gitcore.ts';
import {
  ancestors,
  getObject,
  isAncestor,
  putObject,
  type Repo,
  type Store,
} from './store.ts';
import type { Ctx, Reply } from './rest.ts';

const AGENT = 'forge/1.0';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function err(status: number, message: string): Reply {
  return { status, body: { message } };
}

/** Git endpoints reject only a wrong token; an absent token is allowed. */
function gitAuth(ctx: Ctx): Reply | null {
  const header = ctx.headers.get('authorization');
  if (!header || !ctx.token) return null;
  if (header !== `Bearer ${ctx.token}`) return err(401, 'Bad credentials');
  return null;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Peel an annotated tag (recursively) to the commit it points at. */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i++) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

function isAnnotatedTag(repo: Repo, oid: string): boolean {
  const obj = getObject(repo, oid);
  return obj?.type === 'tag';
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const defaultBranch = repo.defaultBranch;
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k shallow thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/${defaultBranch} object-format=sha1 agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${defaultBranch}`);
  if (refs.length === 0) {
    // Empty repository: git advertises the zero oid with the capabilities.
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    if (headOid) {
      lines.push(`${headOid} HEAD\0${caps}\n`);
      first = false;
    }
    for (const [ref, oid] of refs) {
      const suffix = first ? `\0${caps}` : '';
      lines.push(`${oid} ${ref}${suffix}\n`);
      first = false;
      if (isAnnotatedTag(repo, oid)) {
        lines.push(`${peelToCommit(repo, oid)} ${ref}^{}\n`);
      }
    }
  }
  return pktLines(lines);
}

function advertiseV2(repo: Repo): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  included: Set<string>;
  shallow: string[];
  unshallow: string[];
  extraObjects: GitObject[];
  /** Objects the client already holds in full (closure of complete haves). */
  held: Set<string>;
}

function commitTimestamp(repo: Repo, oid: string): number {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return 0;
  const author = parseCommit(obj.data).author;
  const m = / (\d+) [+-]\d{4}$/.exec(author);
  return m ? Number(m[1]) : 0;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  deepen: number | null,
  deepenSince: number | null,
  deepenNot: string[],
): FetchPlan {
  // A `have` the client also lists as a shallow boundary is held only
  // shallowly: it has the commit, not its history, so its ancestors are
  // still candidates. Only complete haves cut the walk.
  const shallowSet = new Set(shallowReq);
  const completeHaves = haves.filter((h) => !shallowSet.has(h));
  const excluded = new Set<string>();
  for (const h of completeHaves) for (const a of ancestors(repo, h)) excluded.add(a);
  for (const ref of deepenNot) {
    const oid = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? ref;
    for (const a of ancestors(repo, oid)) excluded.add(a);
  }

  const extraObjects: GitObject[] = [];
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const obj = getObject(repo, want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraObjects.push(obj);
      const target = peelToCommit(repo, want);
      queue.push({ oid: target, dist: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    }
  }

  const included = new Set<string>();
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (!oid || oid === ZERO_OID || seen.has(oid) || excluded.has(oid)) continue;
    seen.add(oid);
    if (deepen !== null && dist >= deepen) continue;
    if (deepenSince !== null && commitTimestamp(repo, oid) < deepenSince) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    for (const p of parseCommit(obj.data).parents) {
      queue.push({ oid: p, dist: dist + 1 });
    }
  }

  const shallow: string[] = [];
  for (const oid of included) {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const cut = parents.some((p) => !included.has(p) && !excluded.has(p));
    if (cut) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const b of shallowReq) {
    if (!included.has(b)) continue;
    const obj = getObject(repo, b);
    if (!obj || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.every((p) => included.has(p))) {
      unshallow.push(b);
    }
  }
  return { included, shallow, unshallow, extraObjects, held: heldObjects(repo, completeHaves) };
}

/** Every object reachable from the complete haves (commits, trees, blobs). */
function heldObjects(repo: Repo, completeHaves: string[]): Set<string> {
  const held = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (treeOid === ZERO_OID || held.has(treeOid)) return;
    const obj = getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') return;
    held.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walkTree(e.oid);
      else held.add(e.oid);
    }
  };
  const seen = new Set<string>();
  const stack = [...completeHaves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      walkTree(parsed.tree);
      for (const p of parsed.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return held;
}

/** Every object reachable from the included commits, plus the extras. */
function collectPackObjects(repo: Repo, plan: FetchPlan): GitObject[] {
  const out: GitObject[] = [...plan.extraObjects];
  const added = new Set<string>(plan.extraObjects.map((o) => hashObject(o.type, o.data)));
  const add = (oid: string): void => {
    if (added.has(oid) || plan.held.has(oid)) return;
    const obj = getObject(repo, oid);
    if (!obj) return;
    added.add(oid);
    out.push(obj);
  };
  const walkTree = (treeOid: string): void => {
    add(treeOid);
    const obj = getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walkTree(e.oid);
      else add(e.oid);
    }
  };
  for (const oid of plan.included) {
    add(oid);
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') walkTree(parseCommit(obj.data).tree);
  }
  return out;
}

/** Wrap pack bytes in sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < pack.length; off += MAX) {
    const slice = pack.subarray(off, Math.min(off + MAX, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Upload-pack: v2 ls-refs / fetch
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'delim') {
      inArgs = true;
      continue;
    }
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  void symrefs;
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const out: string[] = [];
  const defaultBranch = repo.defaultBranch;
  const headOid = repo.refs.get(`refs/heads/${defaultBranch}`);
  if (!headOid) {
    if (keep('HEAD')) out.push(`unborn HEAD symref-target:refs/heads/${defaultBranch}\n`);
  } else {
    if (keep('HEAD')) out.push(`${headOid} HEAD symref-target:refs/heads/${defaultBranch}\n`);
    for (const [ref, oid] of sortedRefs(repo)) {
      if (!keep(ref)) continue;
      let line = `${oid} ${ref}`;
      if (peel && isAnnotatedTag(repo, oid)) {
        line += ` peeled:${peelToCommit(repo, oid)}`;
      }
      out.push(`${line}\n`);
    }
  }
  out.push('flush');
  return pktLines(out);
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const req = parseFetchLines(lines);
  const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.deepen, req.deepenSince, req.deepenNot);
  const objects = collectPackObjects(repo, plan);
  const pack = objects.length > 0 ? buildPack(objects) : emptyPack();
  const parts: Array<string | Buffer | 'flush' | 'delim'> = [
    'acknowledgments\n',
    'NAK\n',
    'delim',
  ];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push('shallow-info\n');
    for (const s of plan.shallow) parts.push(`shallow ${s}\n`);
    for (const u of plan.unshallow) parts.push(`unshallow ${u}\n`);
    parts.push('delim');
  }
  parts.push('packfile\n');
  const head = pktLines(parts);
  return Buffer.concat([head, sidebandPack(pack), pktLines(['flush'])]);
}

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const req = parseFetchLines(lines);
  const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.deepen, req.deepenSince, req.deepenNot);
  const objects = collectPackObjects(repo, plan);
  const pack = objects.length > 0 ? buildPack(objects) : emptyPack();
  const parts: Array<string | Buffer | 'flush'> = ['NAK\n'];
  for (const s of plan.shallow) parts.push(`shallow ${s}\n`);
  for (const u of plan.unshallow) parts.push(`unshallow ${u}\n`);
  const head = pktLines(parts);
  return Buffer.concat([head, sidebandPack(pack), pktLines(['flush'])]);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/** Parse want/have/shallow/deepen lines out of a fetch request body. */
function parseFetchLines(lines: string[]): FetchRequest {
  const req: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
  };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) req.deepen = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13), 10);
      if (Number.isFinite(n)) req.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      req.deepenNot.push(line.slice(11).trim());
    }
  }
  return req;
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

/** Split a receive-pack body into the command pkt-lines and the raw pack. */
function splitCommands(body: Buffer): { lines: string[]; pack: Buffer } {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (head === '0000') {
      off += 4;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) break;
    lines.push(body.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, pack: body.subarray(off) };
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, pack } = splitCommands(body);
  const report: Array<'flush' | string> = [];
  let unpackOk = true;

  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '').split('\0')[0];
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }

  // Store the pushed objects first; ref updates are validated below.
  if (pack.length > 0) {
    try {
      const parsed = parsePack(pack);
      for (const obj of parsed.objects) {
        putObject(repo, obj.type, obj.data);
      }
    } catch (e) {
      unpackOk = false;
      report.push(`unpack ${(e as Error).message}\n`);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    report.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          results.push({ ref: cmd.ref, ok: false, reason: 'old oid does not match' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
          continue;
        }
      } else {
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
          continue;
        }
        if (current !== cmd.oldOid) {
          results.push({ ref: cmd.ref, ok: false, reason: 'old oid does not match' });
          continue;
        }
        if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  } else {
    for (const cmd of commands) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
    }
  }
  for (const r of results) {
    report.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }

  const inner = pktLines(report);
  return Buffer.concat([sidebandPack(inner), pktLines(['flush'])]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Handle a git smart-HTTP request. Returns null when the path is not one. */
export function handleGit(store: Store, ctx: Ctx): Reply | null {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(ctx.pathname);
  if (!m) return null;
  const [, owner, name, endpoint] = m;
  const repo = store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  const auth = gitAuth(ctx);
  if (auth) return auth;

  try {
    if (endpoint === 'info/refs') {
      if (ctx.method !== 'GET') return err(405, 'Method Not Allowed');
      const service = ctx.query.get('service');
      if (service === 'git-receive-pack') {
        return { status: 200, buf: advertiseV0(repo, 'git-receive-pack'), contentType: RECEIVE_AD };
      }
      if (service !== 'git-upload-pack') return err(400, 'service is required');
      const v2 = (ctx.headers.get('git-protocol') ?? '') === 'version=2';
      return {
        status: 200,
        buf: v2 ? advertiseV2(repo) : advertiseV0(repo, 'git-upload-pack'),
        contentType: UPLOAD_AD,
      };
    }

    if (endpoint === 'git-upload-pack') {
      if (ctx.method !== 'POST') return err(405, 'Method Not Allowed');
      const packets = parsePktLines(ctx.body);
      // Keep delim/flush markers as the literal words so the command
      // handlers can tell the argument section from the header section.
      const lines = packets.map((p) =>
        p.kind === 'data' ? p.payload.toString('utf8') : p.kind,
      );
      const isV2 = (ctx.headers.get('git-protocol') ?? '') === 'version=2';
      const command = lines[0]?.replace(/\n$/, '') ?? '';
      if (isV2 && command === 'command=ls-refs') {
        return { status: 200, buf: handleLsRefs(repo, lines), contentType: UPLOAD_RESULT };
      }
      if (isV2 && command === 'command=fetch') {
        return { status: 200, buf: handleFetchV2(repo, lines), contentType: UPLOAD_RESULT };
      }
      // v0 fetch.
      return { status: 200, buf: handleFetchV0(repo, lines), contentType: UPLOAD_RESULT };
    }

    // git-receive-pack
    if (ctx.method !== 'POST') return err(405, 'Method Not Allowed');
    return { status: 200, buf: handleReceivePack(repo, ctx.body), contentType: RECEIVE_RESULT };
  } catch (e) {
    // A malformed pkt-line stream must never kill the server.
    return err(400, (e as Error).message);
  }
}
