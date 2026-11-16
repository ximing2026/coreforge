// Git smart HTTP: protocol v2 (ls-refs, fetch) and v0 (upload-pack, receive-pack),
// spoken against the repo's own object store. No git binary, no outside service.

import { parseCommit, pktDelim, pktLine, pktReader, readPack, writePack, type GitObject } from './gitobj.ts';
import {
  Forge,
  branchRef,
  commitTree,
  type RepoRecord,
} from './store.ts';

export interface GitHttpRequest {
  method: string;
  owner: string;
  repo: string;
  tail: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitHttpReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const ZERO = '0'.repeat(40);
const AGENT = 'forge/1.0';

function headerOf(req: GitHttpRequest, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

function jsonError(status: number, message: string): GitHttpReply {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(`${JSON.stringify({ message })}\n`) };
}

/** Peel a (possibly annotated tag) object id down to the first non-tag object. */
function peel(repo: RepoRecord, sha: string): string {
  let current = sha;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = repo.store.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString('utf8'));
    if (match === null) return current;
    current = match[1];
  }
  return current;
}

/** All refs in advertisement order: HEAD first, then refs sorted by name. */
function refList(repo: RepoRecord): { name: string; sha: string }[] {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => ({ name, sha: repo.refs.get(name) as string }));
}

function headTarget(repo: RepoRecord): string {
  return branchRef(repo.defaultBranch);
}

function infoRefs(forge: Forge, req: GitHttpRequest, repo: RepoRecord): GitHttpReply {
  const service = req.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonError(400, 'service is required');
  }
  const wantsV2 = headerOf(req, 'git-protocol').includes('version=2');
  if (wantsV2 && service === 'git-upload-pack') {
    const lines = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      pktLine(null),
    ];
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: Buffer.concat(lines) };
  }
  const caps = service === 'git-upload-pack'
    ? 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not'
    : 'report-status side-band-64k delete-refs quiet';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktLine(null)];
  const refs = refList(repo);
  const headSha = repo.refs.get(headTarget(repo));
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps} agent=${AGENT}\n`));
  } else {
    parts.push(pktLine(`${headSha ?? refs[0].sha} HEAD\0${caps} agent=${AGENT}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.sha} ${ref.name}\n`));
  }
  parts.push(pktLine(null));
  return {
    status: 200,
    headers: { 'content-type': `application/x-${service}-advertisement` },
    body: Buffer.concat(parts),
  };
}

/** Read one pkt-line section: payloads until a flush (null) or delim ([1]). */
function readSection(reader: ReturnType<typeof pktReader>): { lines: string[]; end: 'flush' | 'delim' | 'eof' } {
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === undefined) return { lines, end: 'eof' };
    if (packet === null) return { lines, end: 'flush' };
    if (packet.length === 1 && packet[0] === 1) return { lines, end: 'delim' };
    if (packet.length === 1 && packet[0] === 2) continue;
    lines.push(packet.toString('utf8'));
  }
}

function lsRefs(repo: RepoRecord, args: string[]): GitHttpReply {
  const peelWanted = args.includes('peel');
  const symrefsWanted = args.includes('symrefs');
  const unbornWanted = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length).replace(/\n$/, ''));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const head = headTarget(repo);
  const headSha = repo.refs.get(head);
  if (keep('HEAD')) {
    if (headSha !== undefined) {
      out.push(pktLine(`${headSha} HEAD${symrefsWanted ? ` symref-target:${head}` : ''}\n`));
    } else if (unbornWanted) {
      out.push(pktLine(`unborn HEAD${symrefsWanted ? ` symref-target:${head}` : ''}\n`));
    }
  }
  for (const ref of refList(repo)) {
    if (!keep(ref.name)) continue;
    let suffix = '';
    if (peelWanted) {
      const peeled = peel(repo, ref.sha);
      if (peeled !== ref.sha) suffix += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${ref.sha} ${ref.name}${suffix}\n`));
  }
  out.push(pktLine(null));
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(out) };
}

interface CollectedPack {
  objects: GitObject[];
  shallow: string[];
}

/** The object closure for a fetch: from the wants, minus everything reachable from the haves. */
function collectPack(repo: RepoRecord, wants: readonly string[], haves: ReadonlySet<string>, depthLimit: number | null): CollectedPack {
  // Everything reachable from a have is already with the client.
  const excluded = new Set<string>();
  const markExcluded = (tip: string): void => {
    const stack = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (excluded.has(sha)) continue;
      const obj = repo.store.get(sha);
      if (obj === undefined) continue;
      excluded.add(sha);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.body);
        stack.push(info.tree, ...info.parents);
      } else if (obj.type === 'tree') {
        for (const entry of parseTreeEntries(repo, sha)) stack.push(entry.sha);
      } else if (obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString('utf8'));
        if (match !== null) stack.push(match[1]);
      }
    }
  };
  for (const have of haves) markExcluded(have);

  const included = new Map<string, GitObject>();
  const shallow: string[] = [];
  const include = (sha: string): GitObject | undefined => {
    if (excluded.has(sha) || included.has(sha)) return repo.store.get(sha);
    const obj = repo.store.get(sha);
    if (obj === undefined) return undefined;
    included.set(sha, obj);
    return obj;
  };
  const includeTree = (treeSha: string): void => {
    if (include(treeSha) === undefined && !repo.store.has(treeSha)) return;
    if (excluded.has(treeSha)) return;
    include(treeSha);
    for (const entry of parseTreeEntries(repo, treeSha)) {
      if (entry.mode === '40000') includeTree(entry.sha);
      else include(entry.sha);
    }
  };

  // Breadth-first over commits so deepen counts generations the way git does.
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const obj = repo.store.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (!depthOf.has(want)) {
        depthOf.set(want, 1);
        queue.push(want);
      }
    } else if (obj.type === 'tree') {
      includeTree(want);
    } else {
      include(want);
      if (obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString('utf8'));
        if (match !== null && repo.store.get(match[1])?.type === 'commit' && !depthOf.has(match[1])) {
          depthOf.set(match[1], 1);
          queue.push(match[1]);
        }
      }
    }
  }
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    const depth = depthOf.get(sha) as number;
    if (excluded.has(sha)) continue;
    const obj = include(sha);
    if (obj === undefined) continue;
    const info = parseCommit(obj.body);
    includeTree(info.tree);
    const atLimit = depthLimit !== null && depth >= depthLimit;
    if (atLimit) {
      if (info.parents.length > 0) shallow.push(sha);
      continue;
    }
    for (const parent of info.parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return { objects: [...included.values()], shallow };
}

import { parseTree as parseTreeOf } from './gitobj.ts';
function parseTreeEntries(repo: RepoRecord, treeSha: string): { mode: string; name: string; sha: string }[] {
  const obj = repo.store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTreeOf(obj.body);
}

/** Frame pack bytes as side-band-64k packets (band 1), in under-64k chunks. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65519;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, at + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

function fetchV2(repo: RepoRecord, args: string[]): GitHttpReply {
  const wants: string[] = [];
  const wantRefs: string[] = [];
  const haves = new Set<string>();
  let done = false;
  let depthLimit: number | null = null;
  for (const rawLine of args) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) wantRefs.push(line.slice('want-ref '.length).trim());
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('deepen ')) depthLimit = Number.parseInt(line.slice('deepen '.length), 10) || null;
    else if (line === 'done') done = true;
  }
  const wantedRefLines: { oid: string; ref: string }[] = [];
  for (const ref of wantRefs) {
    const sha = repo.refs.get(ref);
    if (sha !== undefined) {
      wants.push(sha);
      wantedRefLines.push({ oid: sha, ref });
    }
  }
  const out: Buffer[] = [];
  const common = [...haves].filter((have) => repo.store.has(have));
  if (!done) {
    out.push(pktLine('acknowledgments\n'));
    if (common.length === 0) out.push(pktLine('NAK\n'));
    else for (const sha of common) out.push(pktLine(`ACK ${sha}\n`));
    out.push(pktLine(null));
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(out) };
  }
  // With `done` in the request the server answers with the pack directly — acknowledgments
  // belong to negotiation rounds, and git rejects an acknowledgments section after done.
  const { objects, shallow } = collectPack(repo, wants, haves, depthLimit);
  if (depthLimit !== null) {
    out.push(pktLine('shallow-info\n'));
    for (const sha of shallow) out.push(pktLine(`shallow ${sha}\n`));
    out.push(pktLine(null));
  }
  if (wantedRefLines.length > 0) {
    out.push(pktLine('wanted-refs\n'));
    for (const entry of wantedRefLines) out.push(pktLine(`${entry.oid} ${entry.ref}\n`));
    out.push(pktLine(null));
  }
  const pack = writePack(objects);
  out.push(pktLine('packfile\n'));
  out.push(...sidebandPack(pack));
  out.push(pktLine(null));
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(out) };
}

function uploadPackV0(repo: RepoRecord, body: Buffer): GitHttpReply {
  const reader = pktReader(body);
  const first = readSection(reader);
  const wants: string[] = [];
  let sideband = false;
  let noDone = false;
  for (const rawLine of first.lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      wants.push((space === -1 ? rest : rest.slice(0, space)).trim());
      if (space !== -1) {
        const caps = rest.slice(space + 1);
        if (caps.includes('side-band-64k') || caps.includes('side-band')) sideband = true;
        if (caps.includes('no-done')) noDone = true;
      }
    }
  }
  const second = readSection(reader);
  const haves = new Set<string>();
  let done = second.end === 'eof';
  for (const rawLine of second.lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    if (line === 'done') done = true;
  }
  const common = [...haves].filter((have) => repo.store.has(have));
  const out: Buffer[] = [];
  if (!done && noDone) {
    // Negotiation round only: acknowledge the common haves, send no pack.
    if (common.length === 0) out.push(pktLine('NAK\n'));
    else for (const sha of common) out.push(pktLine(`ACK ${sha} common\n`));
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(out) };
  }
  if (haves.size > 0) {
    if (common.length === 0) out.push(pktLine('NAK\n'));
    else {
      for (let i = 0; i < common.length - 1; i += 1) out.push(pktLine(`ACK ${common[i]} common\n`));
      out.push(pktLine(`ACK ${common[common.length - 1]}\n`));
    }
  } else {
    out.push(pktLine('NAK\n'));
  }
  const { objects } = collectPack(repo, wants, haves, null);
  const pack = writePack(objects);
  if (sideband) {
    out.push(...sidebandPack(pack));
    out.push(pktLine(null));
  } else {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat([...out, pack]) };
  }
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(out) };
}

function receivePack(repo: RepoRecord, body: Buffer): GitHttpReply {
  const reader = pktReader(body);
  const commands: { oldSha: string; newSha: string; ref: string }[] = [];
  let reportStatus = false;
  let sideband = false;
  // The command list is pkt-lines terminated by a flush; the pack follows raw.
  let offset = 0;
  {
    const view = pktReader(body);
    let consumed = 0;
    for (;;) {
      const before = consumed;
      const packet = view.next();
      if (packet === undefined) {
        consumed = body.length;
        break;
      }
      if (packet === null) {
        // Measure how far the reader walked by re-framing: track via a second pass below.
        consumed = -1;
        break;
      }
      void before;
      const text = packet.toString('utf8');
      const nul = text.indexOf('\0');
      const line = (nul === -1 ? text : text.slice(0, nul)).replace(/\n$/, '');
      if (commands.length === 0 && nul !== -1) {
        const caps = text.slice(nul + 1);
        if (caps.includes('report-status')) reportStatus = true;
        if (caps.includes('side-band-64k') || caps.includes('side-band')) sideband = true;
      }
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
    }
    void consumed;
    // Find the pack start: re-walk the framing deterministically.
    offset = 0;
    for (;;) {
      if (offset >= body.length) break;
      const length = Number.parseInt(body.toString('latin1', offset, offset + 4), 16);
      if (Number.isNaN(length)) break;
      offset += length === 0 ? 4 : length;
      if (length === 0) break;
    }
    void reader;
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes);
      for (const obj of objects) {
        if (!repo.store.has(obj.sha)) repo.store.put(obj.type, obj.body);
      }
    } catch {
      unpackOk = false;
    }
  }
  const report: string[] = [];
  if (reportStatus) report.push(unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n');
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO;
    if (command.newSha === ZERO) {
      // Delete.
      if (current === ZERO) {
        report.push(`ng ${command.ref} already deleted\n`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.store.has(command.newSha)) {
      report.push(`ng ${command.ref} unknown object\n`);
      continue;
    }
    if (current !== command.oldSha) {
      report.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (current !== ZERO) {
      // Every update must fast-forward.
      const ancestors = new Set<string>();
      const stack = [command.newSha];
      let isAncestor = false;
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (sha === current) {
          isAncestor = true;
          break;
        }
        if (ancestors.has(sha)) continue;
        ancestors.add(sha);
        const obj = repo.store.get(sha);
        if (obj !== undefined && obj.type === 'commit') stack.push(...parseCommit(obj.body).parents);
      }
      if (!isAncestor) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newSha);
    report.push(`ok ${command.ref}\n`);
  }
  if (!reportStatus) {
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: Buffer.alloc(0) };
  }
  const reportBody = Buffer.concat([...report.map((line) => pktLine(line)), pktLine(null)]);
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65519;
    for (let at = 0; at < reportBody.length; at += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportBody.subarray(at, at + CHUNK)])));
    }
    parts.push(pktLine(null));
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: Buffer.concat(parts) };
  }
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: reportBody };
}

/** Handle one git smart-HTTP request. */
export function handleGitHttp(forge: Forge, req: GitHttpRequest): GitHttpReply {
  const repo = forge.getRepo(req.owner, req.repo);
  if (req.tail === '/info/refs' && req.method === 'GET') {
    if (repo === undefined) return jsonError(404, 'Not Found');
    return infoRefs(forge, req, repo);
  }
  if (repo === undefined) return jsonError(404, 'Not Found');
  if (req.tail === '/git-upload-pack' && req.method === 'POST') {
    const wantsV2 = headerOf(req, 'git-protocol').includes('version=2');
    if (wantsV2) {
      const reader = pktReader(req.body);
      const commandSection = readSection(reader);
      const commandLine = commandSection.lines.map((line) => line.replace(/\n$/, '')).find((line) => line.startsWith('command='));
      const argsSection = readSection(reader);
      if (commandLine === 'command=ls-refs') return lsRefs(repo, argsSection.lines);
      if (commandLine === 'command=fetch') return fetchV2(repo, argsSection.lines);
      return jsonError(400, 'unknown command');
    }
    return uploadPackV0(repo, req.body);
  }
  if (req.tail === '/git-receive-pack' && req.method === 'POST') {
    return receivePack(repo, req.body);
  }
  return jsonError(404, 'Not Found');
}
