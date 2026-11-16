// The git object model, in memory: loose objects, trees, commits, packfiles and pkt-lines.
// Pure Node builtins (crypto for SHA-1, zlib for pack compression). No git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  body: Buffer;
}

const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of the canonical loose-object framing `<type> <len>\0<body>`, as lowercase hex. */
export function hashObject(type: GitObjectType, body: Buffer): string {
  const head = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(body).digest('hex');
}

/** One tree entry: mode as git writes it ("100644", "40000" for a tree), a name, a hex sha. */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree body into entries, in stored order. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const mode = body.toString('utf8', offset, space);
    const nul = body.indexOf(0x00, space + 1);
    const name = body.toString('utf8', space + 1, nul);
    const sha = body.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with subtrees compared as if their name ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a tree body, sorted the way git sorts them. */
export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

/** Parse a commit body. Header lines end at the first blank line; the rest is the message. */
export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], authorLine: '', committerLine: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.authorLine = line.slice(7);
    else if (line.startsWith('committer ')) info.committerLine = line.slice(10);
  }
  return info;
}

/** Serialize a commit body from its parts. */
export function serializeCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorLine}`);
  lines.push(`committer ${info.committerLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** An in-memory loose-object store for one repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  /** Store an object and return its id; storing the same object twice is a no-op. */
  put(type: GitObjectType, body: Buffer): string {
    const sha = hashObject(type, body);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, body });
    return sha;
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }
}

/** Read a git varint (little-endian 7-bit groups) at `offset`; returns the value and next offset. */
function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buf[at];
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/** Apply a git delta body to a base body, producing the result body. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const src = readVarint(delta, at);
  at = src.next;
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const dst = readVarint(delta, at);
  at = dst.next;
  const out: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[at] * 2 ** (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize += delta[at] * 2 ** (8 * bit);
          at += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dst.value || written !== dst.value) throw new Error('delta result size mismatch');
  return result;
}

export interface PackReadResult {
  objects: { sha: string; type: GitObjectType; body: Buffer }[];
  count: number;
}

/**
 * Inflate the zlib stream starting at `offset`, returning its data and the offset just past it.
 * Node's inflateSync ignores trailing bytes but throws on a truncated stream, so the exact end is
 * the shortest prefix that inflates — found by binary search.
 */
function inflateAt(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const tail = pack.subarray(offset);
  let lo = 1;
  let hi = tail.length;
  let data: Buffer | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(tail.subarray(0, mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === undefined) throw new Error('corrupt zlib stream in pack');
  return { data, next: offset + lo };
}

interface PendingObject {
  type?: GitObjectType;
  body?: Buffer;
  refBase?: string;
  delta?: Buffer;
}

/** Parse a whole packfile (as receive-pack delivers one) into resolved objects. */
export function readPack(pack: Buffer): PackReadResult {
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const pending: PendingObject[] = [];
  const byOffset = new Map<number, PendingObject>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base object's start in this pack.
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(start - back);
      if (base === undefined || base.body === undefined || base.type === undefined) throw new Error('ofs-delta base not resolved');
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      void size;
      const entry: PendingObject = { type: base.type, body: applyDelta(base.body, data) };
      pending.push(entry);
      byOffset.set(start, entry);
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by id; it may sit earlier in this pack or already in the store.
      const baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      const entry: PendingObject = { refBase: baseSha, delta: data };
      pending.push(entry);
      byOffset.set(start, entry);
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      const entry: PendingObject = { type, body: data };
      pending.push(entry);
      byOffset.set(start, entry);
    }
  }
  // Resolve REF_DELTA entries: a base may itself be a delta resolved in this same pass.
  const resolved = new Map<string, GitObject>();
  const results: PackReadResult['objects'] = [];
  let progress = true;
  const queue = [...pending];
  while (queue.length > 0 && progress) {
    progress = false;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const entry = queue[i];
      if (entry.refBase !== undefined && entry.delta !== undefined) {
        const base = resolved.get(entry.refBase);
        if (base === undefined) continue;
        entry.type = base.type;
        entry.body = applyDelta(base.body, entry.delta);
        entry.refBase = undefined;
        entry.delta = undefined;
      }
      if (entry.type !== undefined && entry.body !== undefined) {
        const sha = hashObject(entry.type, entry.body);
        resolved.set(sha, { type: entry.type, body: entry.body });
        results.push({ sha, type: entry.type, body: entry.body });
        queue.splice(i, 1);
        progress = true;
      }
    }
  }
  if (queue.length > 0) throw new Error('pack holds a delta whose base is not in the pack');
  return { objects: results, count };
}

/** Encode one object into a pack stream (no delta), returning its bytes. */
function encodePackObject(type: GitObjectType, body: Buffer): Buffer {
  const code = TYPE_TO_CODE[type];
  let size = body.length;
  const head: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  head.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    head.push(byte);
  }
  return Buffer.concat([Buffer.from(head), deflateSync(body)]);
}

/** Build a complete packfile holding `objects` (already resolved), with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts = [head, ...objects.map((obj) => encodePackObject(obj.type, obj.body))];
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** One pkt-line: 4 hex digits of total length + payload; null encodes the flush packet. */
export function pktLine(payload: Buffer | string | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'latin1');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([prefix, body]);
}

/** The delimiter packet used by protocol v2 (0001). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'latin1');
}

/** The response-end packet used by protocol v2 (0002). */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'latin1');
}

export interface PktReader {
  /** The next packet's payload, or null for a flush; undefined when the stream is exhausted. */
  next(): Buffer | null | undefined;
}

/** A cursor over a pkt-line stream (git's own framing, as both protocol versions use it). */
export function pktReader(buf: Buffer): PktReader {
  let offset = 0;
  return {
    next(): Buffer | null | undefined {
      if (offset >= buf.length) return undefined;
      const hex = buf.toString('latin1', offset, offset + 4);
      const length = Number.parseInt(hex, 16);
      if (Number.isNaN(length)) throw new Error('bad pkt-line length');
      if (length === 0) {
        offset += 4;
        return null;
      }
      if (length === 1 || length === 2) {
        offset += 4;
        return Buffer.from([length], 'latin1');
      }
      const payload = buf.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
  };
}
