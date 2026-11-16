// The forge's state: users from the kit's fixed scenario, repositories with their own object
// stores, refs, issues, pull requests, labels and comments. Everything is deterministic — a
// logical clock, never the wall clock — because a trial is replayed and must agree byte for byte.

import {
  ObjectStore,
  parseCommit,
  parseTree,
  serializeCommit,
  serializeTree,
  type TreeEntry,
} from './gitobj.ts';

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

// The kit's scenario seed is a published constant (SCENARIO_SEED 0x6a09e667f3bcc909 in wire.ts);
// these are the identities its generator derives from it, identical in every trial.
export const VIEWER: ScenarioUser = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE: ScenarioUser = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER: ScenarioUser = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const ORG_LOGIN = 'faint-meadow-org';
export const USERS: readonly ScenarioUser[] = [VIEWER, TEAMMATE, STRANGER];

export function userByLogin(login: string): ScenarioUser | undefined {
  return USERS.find((user) => user.login === login);
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  authorLogin: string;
  createdSeq: number;
  comments: { id: number; body: string; authorLogin: string; createdSeq: number }[];
  /** Set when this number is a pull request (GitHub numbers issues and pulls from one sequence). */
  pull?: PullRecord;
}

export interface PullRecord {
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAtSeq: number | null;
  mergeCommitSha: string | null;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  store: ObjectStore;
  /** Full ref name ("refs/heads/main") to commit sha. */
  refs: Map<string, string>;
  issues: Map<number, IssueRecord>;
  /** The shared issue/pull number sequence. */
  nextNumber: number;
  labels: Set<string>;
  createdSeq: number;
}

const EPOCH_BASE = 1_700_000_000; // fixed base for the logical clock, in epoch seconds

export class Forge {
  readonly repos = new Map<string, RepoRecord>();
  private seq = 0;
  private nextRepoId = 1;
  private nextCommentId = 1;
  private nextIssueId = 1;

  /** The next logical timestamp: strictly increasing, identical across live and replay. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ISO-8601 rendering of a logical sequence number. */
  isoOf(seq: number): string {
    return new Date((EPOCH_BASE + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** A git author/committer line for a user at a logical time. */
  identOf(user: ScenarioUser, seq: number): string {
    return `${user.name} <${user.email}> ${EPOCH_BASE + seq} +0000`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, init: { description?: string; private?: boolean; defaultBranch?: string }): RepoRecord {
    const repo: RepoRecord = {
      id: this.nextRepoId,
      owner,
      name,
      description: init.description ?? '',
      private: init.private ?? false,
      defaultBranch: init.defaultBranch ?? 'main',
      store: new ObjectStore(),
      refs: new Map(),
      issues: new Map(),
      nextNumber: 1,
      labels: new Set(),
      createdSeq: this.tick(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  reposOf(owner: string): RepoRecord[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  nextIssueIdValue(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }
}

/** The sha a ref points at, or undefined. */
export function refSha(repo: RepoRecord, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** The full ref name for a branch short name. */
export function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** The tree sha of a commit, or undefined when the commit is unknown. */
export function commitTree(repo: RepoRecord, commitSha: string): string | undefined {
  const obj = repo.store.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.body).tree;
}

/** Walk a tree by path segments; returns the final entry, or undefined. */
export function treeLookup(repo: RepoRecord, treeSha: string, segments: readonly string[]): TreeEntry | undefined {
  let current = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.store.get(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.body).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.sha;
  }
  return undefined;
}

/** List a tree's entries, or undefined when the sha is not a tree. */
export function treeEntries(repo: RepoRecord, treeSha: string): TreeEntry[] | undefined {
  const obj = repo.store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return undefined;
  return parseTree(obj.body);
}

/**
 * Return a new tree sha with `segments` set to `entry` (or removed when entry is null),
 * rebuilding the trees along the path. The base tree may be the empty tree.
 */
export function treeWrite(repo: RepoRecord, treeSha: string, segments: readonly string[], entry: TreeEntry | null): string {
  const existing = treeSha === EMPTY_TREE_SHA ? [] : (treeEntries(repo, treeSha) ?? []);
  const [head, ...rest] = segments;
  const kept = existing.filter((candidate) => candidate.name !== head);
  if (rest.length === 0) {
    if (entry !== null) kept.push(entry);
  } else {
    const child = existing.find((candidate) => candidate.name === head);
    const childTree = child !== undefined && child.mode === '40000' ? child.sha : EMPTY_TREE_SHA;
    const newChild = treeWrite(repo, childTree, rest, entry);
    if (!(entry === null && newChild === EMPTY_TREE_SHA)) {
      kept.push({ mode: '40000', name: head, sha: newChild });
    }
  }
  if (kept.length === 0) return EMPTY_TREE_SHA;
  return repo.store.put('tree', serializeTree(kept));
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Make sure the empty tree object exists in a repo's store; returns its sha. */
export function ensureEmptyTree(repo: RepoRecord): string {
  if (!repo.store.has(EMPTY_TREE_SHA)) repo.store.put('tree', Buffer.alloc(0));
  return EMPTY_TREE_SHA;
}

/** Create a commit on top of `parentSha` (or a root commit when null) and return its sha. */
export function makeCommit(
  repo: RepoRecord,
  forge: Forge,
  input: { tree: string; parentSha: string | null; message: string; author: ScenarioUser },
): string {
  const seq = forge.tick();
  const ident = forge.identOf(input.author, seq);
  const body = serializeCommit({
    tree: input.tree,
    parents: input.parentSha === null ? [] : [input.parentSha],
    authorLine: ident,
    committerLine: ident,
    message: input.message,
  });
  return repo.store.put('commit', body);
}

/** All commit shas reachable from a tip, newest first (parents after their children). */
export function reachableCommits(repo: RepoRecord, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = repo.store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of parseCommit(obj.body).parents) stack.push(parent);
  }
  return order;
}

/** The merge base of two commits: the first commit reachable from `a` that is also reachable from `b`. */
export function mergeBase(repo: RepoRecord, a: string, b: string): string | null {
  const fromB = new Set(reachableCommits(repo, b));
  for (const sha of reachableCommits(repo, a)) {
    if (fromB.has(sha)) return sha;
  }
  return null;
}

/** Flatten a tree into a map from path to blob entry, recursively. */
export function flattenTree(repo: RepoRecord, treeSha: string, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const entries = treeEntries(repo, treeSha) ?? [];
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(repo, entry.sha, path)) out.set(childPath, child);
    } else {
      out.set(path, entry);
    }
  }
  return out;
}
