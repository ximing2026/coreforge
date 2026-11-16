// The REST v3 surface: repositories, contents, branches, commits, labels, issues, comments
// and pull requests, in GitHub's shapes. Every reply is JSON with an X-GitHub-Request-Id.

import { parseCommit } from './gitobj.ts';
import {
  Forge,
  VIEWER,
  branchRef,
  commitTree,
  ensureEmptyTree,
  flattenTree,
  makeCommit,
  mergeBase,
  reachableCommits,
  refSha,
  treeLookup,
  treeWrite,
  type IssueRecord,
  type RepoRecord,
  type ScenarioUser,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** The raw body text, to tell malformed JSON apart from an absent body. */
  rawBody: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const badRequest = (message: string): RestReply => ({ status: 400, body: { message } });
const unprocessable = (message: string): RestReply => ({ status: 422, body: { message, errors: [] } });

function asObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function userJson(user: ScenarioUser): Record<string, unknown> {
  return { login: user.login, id: user.id, type: 'User', name: user.name, email: user.email };
}

export function repoJson(forge: Forge, repo: RepoRecord): Record<string, unknown> {
  const owner = { login: repo.owner, id: VIEWER.id, type: 'User' };
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.isoOf(repo.createdSeq),
    updated_at: forge.isoOf(repo.createdSeq),
    pushed_at: forge.isoOf(repo.createdSeq),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    html_url: `http://forge.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `http://forge.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://forge.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge.invalid:${repo.owner}/${repo.name}.git`,
    homepage: '',
    language: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

function labelJson(name: string): Record<string, unknown> {
  return { name, color: 'ededed', default: false, description: null };
}

export function issueJson(forge: Forge, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(VIEWER),
    author_association: 'OWNER',
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.createdSeq),
    updated_at: forge.isoOf(issue.createdSeq),
    closed_at: issue.state === 'closed' ? forge.isoOf(issue.createdSeq) : null,
    html_url: `http://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
  if (issue.pull !== undefined) {
    base.pull_request = { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}` };
  }
  return base;
}

export function pullJson(forge: Forge, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  const pull = issue.pull as NonNullable<IssueRecord['pull']>;
  const headSha = refSha(repo, branchRef(pull.headRef)) ?? '';
  const baseSha = refSha(repo, branchRef(pull.baseRef)) ?? '';
  return {
    ...issueJson(forge, repo, issue),
    merged: pull.merged,
    merged_at: pull.mergedAtSeq === null ? null : forge.isoOf(pull.mergedAtSeq),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    mergeable: pull.merged ? false : null,
    draft: false,
  };
}

function commitJson(forge: Forge, repo: RepoRecord, sha: string): Record<string, unknown> {
  const obj = repo.store.get(sha);
  const info = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.body) : null;
  const ident = info?.authorLine ?? '';
  const match = /^(.*) <(.*)> (\d+) /.exec(ident);
  return {
    sha,
    commit: {
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '' },
      author: { name: match?.[1] ?? '', email: match?.[2] ?? '', date: forge.isoOf(0) },
      committer: { name: match?.[1] ?? '', email: match?.[2] ?? '', date: forge.isoOf(0) },
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `http://forge.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** Count added/removed lines between two texts with a simple LCS over lines. */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // LCS length via dynamic programming over the shorter axis.
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file-level diff between two trees, GitHub's pull-files shape. */
export function diffTrees(repo: RepoRecord, baseTree: string | undefined, headTree: string | undefined): Record<string, unknown>[] {
  const baseFiles = baseTree === undefined ? new Map() : flattenTree(repo, baseTree);
  const headFiles = headTree === undefined ? new Map() : flattenTree(repo, headTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.sha === after?.sha) continue;
    const beforeText = before === undefined ? '' : (repo.store.get(before.sha)?.body.toString('utf8') ?? '');
    const afterText = after === undefined ? '' : (repo.store.get(after.sha)?.body.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(beforeText, afterText);
    files.push({
      sha: after?.sha ?? before?.sha ?? '',
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/** Three-way tree merge for a squash: returns the merged tree sha, or null on a content conflict. */
export function mergeTrees(repo: RepoRecord, base: string, ours: string, theirs: string): string | null {
  const baseFiles = flattenTree(repo, base);
  const ourFiles = flattenTree(repo, ours);
  const theirFiles = flattenTree(repo, theirs);
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  let tree = ensureEmptyTree(repo);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const o = ourFiles.get(path);
    const t = theirFiles.get(path);
    let winner = o;
    if (o?.sha === t?.sha) winner = o;
    else if (b?.sha === o?.sha) winner = t; // only theirs changed
    else if (b?.sha === t?.sha) winner = o; // only ours changed
    else {
      // Both changed the same path differently: try a line-level merge of text blobs.
      if (o !== undefined && t !== undefined && b !== undefined) {
        const merged = mergeText(
          repo.store.get(b.sha)?.body.toString('utf8') ?? '',
          repo.store.get(o.sha)?.body.toString('utf8') ?? '',
          repo.store.get(t.sha)?.body.toString('utf8') ?? '',
        );
        if (merged === null) return null;
        const sha = repo.store.put('blob', Buffer.from(merged, 'utf8'));
        winner = { mode: o.mode, name: o.name, sha };
      } else {
        return null;
      }
    }
    if (winner !== undefined) {
      tree = treeWrite(repo, tree, path.split('/'), { mode: winner.mode, name: winner.name, sha: winner.sha });
    }
  }
  return tree;
}

/** A minimal three-way line merge: applies each side's changed regions when they do not overlap. */
export function mergeText(base: string, ours: string, theirs: string): string | null {
  const baseLines = base.split('\n');
  const edits = (side: string[]): { start: number; end: number; lines: string[] }[] => {
    // Changed region = the span between the common prefix and the common suffix.
    let start = 0;
    while (start < baseLines.length && start < side.length && baseLines[start] === side[start]) start += 1;
    let endBase = baseLines.length;
    let endSide = side.length;
    while (endBase > start && endSide > start && baseLines[endBase - 1] === side[endSide - 1]) {
      endBase -= 1;
      endSide -= 1;
    }
    return [{ start, end: endBase, lines: side.slice(start, endSide) }];
  };
  const [ourEdit] = edits(ours.split('\n'));
  const [theirEdit] = edits(theirs.split('\n'));
  if (ourEdit.start === ourEdit.end && ourEdit.lines.length === 0) return theirs;
  if (theirEdit.start === theirEdit.end && theirEdit.lines.length === 0) return ours;
  const overlap = ourEdit.start < theirEdit.end && theirEdit.start < ourEdit.end;
  if (overlap) {
    const sameChange = ourEdit.start === theirEdit.start && ourEdit.end === theirEdit.end
      && ourEdit.lines.join('\n') === theirEdit.lines.join('\n');
    return sameChange ? ours : null;
  }
  const first = ourEdit.start <= theirEdit.start ? ourEdit : theirEdit;
  const second = first === ourEdit ? theirEdit : ourEdit;
  const merged = [
    ...baseLines.slice(0, first.start),
    ...first.lines,
    ...baseLines.slice(first.end, second.start),
    ...second.lines,
    ...baseLines.slice(second.end),
  ];
  return merged.join('\n');
}

/** Commit a new tree onto a branch (creating the branch's first commit when unborn); returns the commit sha. */
function commitOnBranch(forge: Forge, repo: RepoRecord, branch: string, tree: string, message: string): string {
  const ref = branchRef(branch);
  const parent = refSha(repo, ref) ?? null;
  const sha = makeCommit(repo, forge, { tree, parentSha: parent, message, author: VIEWER });
  repo.refs.set(ref, sha);
  return sha;
}

/** Handle one REST request. Auth is enforced by the caller except for the public routes. */
export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;
  if (req.rawBody !== '' && req.body === undefined) return badRequest('Problems parsing JSON');

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', current_user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      headers: { 'x-oauth-scopes': 'repo, read:org, write:org' },
    };
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0-forge', verifiable_password_authentication: false, github_services_sha: 'forge' } };
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson(VIEWER) };
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') return listUserRepos(forge, req);
    if (method === 'POST') return createRepo(forge, req);
    return notFound();
  }
  if (seg[0] === 'orgs' && seg.length === 3 && seg[2] === 'repos') {
    if (method === 'POST') return createRepo(forge, req, seg[1]);
    if (method === 'GET') return listOrgRepos(forge, req, seg[1]);
    return notFound();
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    return handleRepo(forge, req, seg[1], seg[2], seg.slice(3));
  }
  return notFound();
}

function listUserRepos(forge: Forge, req: RestRequest): RestReply {
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const all = forge.reposOf(VIEWER.login);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    headers.link = `</api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next", </api/v3/user/repos?page=${Math.ceil(all.length / perPage)}&per_page=${perPage}>; rel="last"`;
  }
  return { status: 200, body: slice.map((repo) => repoJson(forge, repo)), headers };
}

function listOrgRepos(forge: Forge, req: RestRequest, org: string): RestReply {
  void req;
  const all = forge.reposOf(org);
  return { status: 200, body: all.map((repo) => repoJson(forge, repo)) };
}

function createRepo(forge: Forge, req: RestRequest, ownerOverride?: string): RestReply {
  const body = asObject(req.body);
  const name = str(body.name);
  if (name === undefined || name === '') return unprocessable('name is required');
  const owner = ownerOverride ?? VIEWER.login;
  if (forge.getRepo(owner, name) !== undefined) return unprocessable('name already exists on this account');
  const repo = forge.createRepo(owner, name, {
    description: str(body.description) ?? '',
    private: body.private === true,
    defaultBranch: str(body.default_branch) ?? 'main',
  });
  return { status: 201, body: repoJson(forge, repo) };
}

/** Resolve a repo the token may see: only the viewer's own (and org) repos exist to it. */
function visibleRepo(forge: Forge, owner: string, name: string): RepoRecord | undefined {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return undefined;
  if (repo.owner !== VIEWER.login && repo.owner !== 'faint-meadow-org') return undefined;
  return repo;
}

function handleRepo(forge: Forge, req: RestRequest, owner: string, name: string, rest: string[]): RestReply {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = visibleRepo(forge, owner, name);
      return repo === undefined ? notFound() : { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'PATCH') {
      const repo = visibleRepo(forge, owner, name);
      if (repo === undefined) return notFound();
      const body = asObject(req.body);
      if (str(body.description) !== undefined) repo.description = str(body.description) as string;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (str(body.default_branch) !== undefined) repo.defaultBranch = str(body.default_branch) as string;
      const newName = str(body.name);
      if (newName !== undefined && newName !== repo.name) {
        forge.repos.delete(forge.key(repo.owner, repo.name));
        repo.name = newName;
        forge.repos.set(forge.key(repo.owner, repo.name), repo);
      }
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      const repo = visibleRepo(forge, owner, name);
      if (repo === undefined) return notFound();
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }

  const repo = visibleRepo(forge, owner, name);
  if (repo === undefined) return notFound();

  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
      return { status: 200, body: branches };
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = refSha(repo, branchRef(rest[1]));
      if (sha === undefined) return notFound();
      return { status: 200, body: { name: rest[1], commit: { sha, url: '' }, protected: false } };
    }
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = asObject(req.body);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === undefined || sha === undefined || !repo.store.has(sha)) return unprocessable('sha is not a known object');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: 'commit', url: '' }, url: '' } };
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = refSha(repo, ref);
      if (sha === undefined) return notFound();
      return { status: 200, body: { ref, object: { sha, type: 'commit', url: '' }, url: '' } };
    }
    return notFound();
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = req.query.get('sha') ?? repo.defaultBranch;
    const tip = refSha(repo, branchRef(shaParam)) ?? (repo.store.has(shaParam) ? shaParam : undefined);
    if (tip === undefined) return { status: 200, body: [] };
    const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
    const all = reachableCommits(repo, tip);
    return { status: 200, body: all.slice((page - 1) * perPage, page * perPage).map((sha) => commitJson(forge, repo, sha)) };
  }

  if (rest[0] === 'contents') {
    return handleContents(forge, req, repo, rest.slice(1).join('/'));
  }

  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = asObject(req.body);
      const labelName = str(body.name);
      if (labelName === undefined || labelName === '') return unprocessable('name is required');
      repo.labels.add(labelName);
      return { status: 201, body: labelJson(labelName) };
    }
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels].map(labelJson) };
    }
    if (method === 'GET' && rest.length === 2) {
      return repo.labels.has(rest[1]) ? { status: 200, body: labelJson(rest[1]) } : notFound();
    }
    return notFound();
  }

  if (rest[0] === 'issues') return handleIssues(forge, req, repo, rest.slice(1));
  if (rest[0] === 'pulls') return handlePulls(forge, req, repo, rest.slice(1));
  return notFound();
}

function handleContents(forge: Forge, req: RestRequest, repo: RepoRecord, path: string): RestReply {
  const method = req.method;
  const refParam = req.query.get('ref') ?? str(asObject(req.body).branch) ?? repo.defaultBranch;
  const tip = refSha(repo, branchRef(refParam));
  const baseTree = tip === undefined ? ensureEmptyTree(repo) : (commitTree(repo, tip) ?? ensureEmptyTree(repo));
  const segments = path === '' ? [] : path.split('/');

  if (method === 'GET') {
    if (segments.length === 0) {
      const entries = flattenListing(repo, baseTree, '');
      return { status: 200, body: entries };
    }
    const entry = treeLookup(repo, baseTree, segments);
    if (entry === undefined) return notFound();
    if (entry.mode === '40000') {
      return { status: 200, body: flattenListing(repo, entry.sha, path) };
    }
    const blob = repo.store.get(entry.sha);
    const content = blob?.body ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
        sha: entry.sha,
        size: content.length,
        name: segments[segments.length - 1],
        path,
        url: '',
        html_url: '',
        download_url: '',
      },
    };
  }

  if (method === 'PUT') {
    const body = asObject(req.body);
    const message = str(body.message) ?? 'Update file';
    const encoded = str(body.content);
    if (encoded === undefined) return unprocessable('content is required');
    const data = Buffer.from(encoded.replace(/\s/g, ''), 'base64');
    const existing = segments.length === 0 ? undefined : treeLookup(repo, baseTree, segments);
    const providedSha = str(body.sha);
    if (existing !== undefined && providedSha !== undefined && providedSha !== existing.sha) {
      return { status: 409, body: { message: 'Conflict: sha does not match the current file' } };
    }
    if (existing !== undefined && providedSha === undefined) return unprocessable('sha is required when updating a file');
    const blobSha = repo.store.put('blob', data);
    const newTree = treeWrite(repo, baseTree, segments, { mode: '100644', name: segments[segments.length - 1], sha: blobSha });
    const branch = str(body.branch) ?? repo.defaultBranch;
    const commitSha = commitOnBranch(forge, repo, branch, newTree, message);
    return {
      status: existing === undefined ? 201 : 200,
      body: {
        content: { name: segments[segments.length - 1], path, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha },
      },
    };
  }

  if (method === 'DELETE') {
    const body = asObject(req.body);
    const existing = treeLookup(repo, baseTree, segments);
    if (existing === undefined) return notFound();
    const providedSha = str(body.sha);
    if (providedSha !== undefined && providedSha !== existing.sha) {
      return { status: 409, body: { message: 'Conflict: sha does not match the current file' } };
    }
    const newTree = treeWrite(repo, baseTree, segments, null);
    const branch = str(body.branch) ?? repo.defaultBranch;
    const commitSha = commitOnBranch(forge, repo, branch, newTree, str(body.message) ?? 'Delete file');
    return { status: 200, body: { content: null, commit: { sha: commitSha } } };
  }

  return notFound();
}

/** A directory listing in GitHub's contents shape. */
function flattenListing(repo: RepoRecord, treeSha: string, prefix: string): Record<string, unknown>[] {
  const entries = (repo.store.get(treeSha)?.type === 'tree' ? treeEntriesSafe(repo, treeSha) : []) ?? [];
  return entries.map((entry) => ({
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.sha,
    size: entry.mode === '40000' ? 0 : (repo.store.get(entry.sha)?.body.length ?? 0),
    type: entry.mode === '40000' ? 'dir' : 'file',
    url: '',
    html_url: '',
    download_url: null,
  }));
}

import { treeEntries as treeEntriesSafe } from './store.ts';

function handleIssues(forge: Forge, req: RestRequest, repo: RepoRecord, rest: string[]): RestReply {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = asObject(req.body);
      const title = str(body.title);
      if (title === undefined || title === '') return unprocessable('title is required');
      const labels = Array.isArray(body.labels) ? body.labels.map((label) => (typeof label === 'string' ? label : str(asObject(label).name) ?? '')).filter((label) => label !== '') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(`label '${label}' does not exist`);
      }
      const issue: IssueRecord = {
        id: forge.nextIssueIdValue(),
        number: repo.nextNumber,
        title,
        body: str(body.body) ?? '',
        state: 'open',
        labels,
        authorLogin: VIEWER.login,
        createdSeq: forge.tick(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()].filter((issue) => issue.pull === undefined);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const labelFilter = req.query.get('labels');
      if (labelFilter !== null && labelFilter !== '') {
        const wanted = labelFilter.split(',');
        list = list.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
      }
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      return { status: 200, body: list.map((issue) => issueJson(forge, repo, issue)) };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isNaN(number) ? undefined : repo.issues.get(number);
  if (issue === undefined) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
    if (method === 'PATCH') {
      const body = asObject(req.body);
      if (str(body.title) !== undefined) issue.title = str(body.title) as string;
      if (str(body.body) !== undefined) issue.body = str(body.body) as string;
      const state = str(body.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      if (Array.isArray(body.labels)) {
        issue.labels = body.labels.map((label) => (typeof label === 'string' ? label : str(asObject(label).name) ?? '')).filter((label) => label !== '');
      }
      return { status: 200, body: issueJson(forge, repo, issue) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = asObject(req.body);
      const comment = { id: forge.nextCommentIdValue(), body: str(body.body) ?? '', authorLogin: VIEWER.login, createdSeq: forge.tick() };
      issue.comments.push(comment);
      return { status: 201, body: commentJson(forge, repo, issue, comment) };
    }
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(forge, repo, issue, comment)) };
    }
  }
  return notFound();
}

function commentJson(
  forge: Forge,
  repo: RepoRecord,
  issue: IssueRecord,
  comment: { id: number; body: string; authorLogin: string; createdSeq: number },
): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(VIEWER),
    author_association: 'OWNER',
    created_at: forge.isoOf(comment.createdSeq),
    updated_at: forge.isoOf(comment.createdSeq),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: '',
  };
}

function handlePulls(forge: Forge, req: RestRequest, repo: RepoRecord, rest: string[]): RestReply {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = asObject(req.body);
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base);
      if (title === undefined || headRaw === undefined || baseRaw === undefined) return unprocessable('title, head and base are required');
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.slice(baseRaw.indexOf(':') + 1) : baseRaw;
      if (refSha(repo, branchRef(head)) === undefined || refSha(repo, branchRef(base)) === undefined) {
        return unprocessable('head or base branch does not exist');
      }
      const issue: IssueRecord = {
        id: forge.nextIssueIdValue(),
        number: repo.nextNumber,
        title,
        body: str(body.body) ?? '',
        state: 'open',
        labels: [],
        authorLogin: VIEWER.login,
        createdSeq: forge.tick(),
        comments: [],
        pull: { title, body: str(body.body) ?? '', state: 'open', headRef: head, baseRef: base, merged: false, mergedAtSeq: null, mergeCommitSha: null },
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { status: 201, body: pullJson(forge, repo, issue) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((issue) => issue.pull !== undefined);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return { status: 200, body: list.map((issue) => pullJson(forge, repo, issue)) };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isNaN(number) ? undefined : repo.issues.get(number);
  if (issue === undefined || issue.pull === undefined) return notFound();
  const pull = issue.pull;

  if (rest.length === 1 && method === 'GET') return { status: 200, body: pullJson(forge, repo, issue) };
  if (rest.length === 1 && method === 'PATCH') {
    const body = asObject(req.body);
    if (str(body.title) !== undefined) {
      issue.title = str(body.title) as string;
      pull.title = issue.title;
    }
    if (str(body.body) !== undefined) {
      issue.body = str(body.body) as string;
      pull.body = issue.body;
    }
    const state = str(body.state);
    if (state === 'open' || state === 'closed') {
      issue.state = state;
      pull.state = state;
    }
    return { status: 200, body: pullJson(forge, repo, issue) };
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = refSha(repo, branchRef(pull.headRef));
    const baseTip = refSha(repo, branchRef(pull.baseRef));
    const base = headTip !== undefined && baseTip !== undefined ? mergeBase(repo, headTip, baseTip) : null;
    const fromTree = base === null ? undefined : commitTree(repo, base);
    const toTree = headTip === undefined ? undefined : commitTree(repo, headTip);
    return { status: 200, body: diffTrees(repo, fromTree, toTree) };
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    const headTip = refSha(repo, branchRef(pull.headRef));
    const baseTip = refSha(repo, branchRef(pull.baseRef));
    if (headTip === undefined || baseTip === undefined) return notFound();
    const base = mergeBase(repo, headTip, baseTip);
    const ancestorTree = base === null ? ensureEmptyTree(repo) : (commitTree(repo, base) ?? ensureEmptyTree(repo));
    const baseTree = commitTree(repo, baseTip) ?? ensureEmptyTree(repo);
    const headTree = commitTree(repo, headTip) ?? ensureEmptyTree(repo);
    const mergedTree = mergeTrees(repo, ancestorTree, baseTree, headTree);
    if (mergedTree === null) return { status: 405, body: { message: 'Merge conflict: the pull request cannot be merged cleanly' } };
    const body = asObject(req.body);
    const message = str(body.commit_message) ?? str(body.commit_title) ?? `Merge pull request #${issue.number} (squash)`;
    const sha = makeCommit(repo, forge, { tree: mergedTree, parentSha: baseTip, message, author: VIEWER });
    repo.refs.set(branchRef(pull.baseRef), sha);
    pull.merged = true;
    pull.mergedAtSeq = forge.tick();
    pull.mergeCommitSha = sha;
    pull.state = 'closed';
    issue.state = 'closed';
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return notFound();
}
