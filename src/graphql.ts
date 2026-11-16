// GraphQL v4: a focused parser and executor for the schema surface gh and the suite use —
// viewer, repository, issues and pull requests with cursor connections, the gh mutations,
// node(id:) round-trips and the __type feature-detection probes. Global ids are opaque
// base64 "<Type>:<key>" tokens that only this server mints and reads back.

import {
  Forge,
  VIEWER,
  ORG_LOGIN,
  branchRef,
  commitTree,
  mergeBase,
  refSha,
  userByLogin,
  type IssueRecord,
  type RepoRecord,
  type ScenarioUser,
} from './store.ts';
import { diffTrees, pullMergeable, squashMergePull } from './rest.ts';

// --------------------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: Value }[];
  selection?: SelectionNode[];
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selection: SelectionNode[];
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

class Parser {
  private tokens: string[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private take(): string {
    const token = this.tokens[this.at];
    this.at += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expect(token: string): void {
    const got = this.take();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, { typeCondition?: string; selection: SelectionNode[] }> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition?: string; selection: SelectionNode[] }>();
    while (this.at < this.tokens.length) {
      const head = this.peek();
      if (head === 'query' || head === 'mutation') {
        this.take();
        let name: string | undefined;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.take();
        if (this.peek() === '(') this.skipParens();
        operations.push({ type: head, name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.take();
        const fragName = this.take();
        this.expect('on');
        const typeCondition = this.take();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else if (head === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'subscription') {
        throw new Error('subscriptions are not supported');
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.take();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take();
        if (this.peek() === 'on') {
          this.take();
          const typeCondition = this.take();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.take() });
        }
      } else {
        selections.push(this.parseField());
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.take();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.take();
      alias = name;
      name = this.take();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.take();
      while (this.peek() !== ')') {
        const argName = this.take();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.take();
    if (token === '$') return { kind: 'var', name: this.take() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.take();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

/** Split a GraphQL document into tokens; string literals stay whole (quotes included). */
function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (/\s|,/.test(ch)) {
      i += 1;
    } else if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const raw = source.slice(i + 3, end === -1 ? source.length : end);
        tokens.push(JSON.stringify(raw));
        i = end === -1 ? source.length : end + 3;
      } else {
        let j = i + 1;
        while (j < source.length && source[j] !== '"') {
          if (source[j] === '\\') j += 1;
          j += 1;
        }
        tokens.push(source.slice(i, j + 1));
        i = j + 1;
      }
    } else if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else if ('{}()[]:$!@='.includes(ch)) {
      tokens.push(ch);
      i += 1;
    } else if (/[0-9-]/.test(ch) && /^-?\d/.test(source.slice(i))) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      tokens.push((match as RegExpExecArray)[0]);
      i += (match as RegExpExecArray)[0].length;
    } else {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      if (match === null) throw new Error(`unexpected character ${ch}`);
      tokens.push(match[0]);
      i += match[0].length;
    }
  }
  return tokens;
}

// --------------------------------------------------------------------------- ids

export function gid(type: string, key: string | number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGid(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split === -1) return null;
    return { type: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

function cursorOf(key: string | number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

// --------------------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition?: string; selection: SelectionNode[] }>;
  errors: { message: string; path?: (string | number)[] }[];
}

type Source = Record<string, unknown> & { __typename: string };

function valueOf(ctx: Ctx, value: Value): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueOf(ctx, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(ctx, field.value);
      return out;
    }
  }
}

function argsOf(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(ctx, arg.value);
  return out;
}

function execute(ctx: Ctx, typeName: string, source: Source | null, selections: SelectionNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      out[key] = resolveField(ctx, typeName, source, selection, [...path, key]);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName || typeName === 'Node') {
        Object.assign(out, execute(ctx, typeName, source, selection.selection, path));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === undefined || fragment.typeCondition === typeName)) {
        Object.assign(out, execute(ctx, typeName, source, fragment.selection, path));
      }
    }
  }
  return out;
}

/** Finish a resolved raw value: descend into objects, lists and connections per the selection. */
function complete(ctx: Ctx, value: unknown, selection: SelectionNode[] | undefined, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => complete(ctx, item, selection, [...path, index]));
  if (typeof value === 'object') {
    const source = value as Source;
    if (selection === undefined) return source;
    return execute(ctx, source.__typename, source, selection, path);
  }
  return value;
}

function resolveField(ctx: Ctx, typeName: string, source: Source | null, field: FieldNode, path: (string | number)[]): unknown {
  const args = argsOf(ctx, field);
  const resolver = RESOLVERS[typeName]?.[field.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, path });
    return null;
  }
  const value = resolver(ctx, source, args);
  return complete(ctx, value, field.selection, path);
}

// --------------------------------------------------------------------------- sources

function userSource(user: ScenarioUser): Source {
  return { __typename: 'User', login: user.login, id: gid('User', user.id), databaseId: user.id, name: user.name, email: user.email };
}

function ownerSource(login: string): Source {
  const user = userByLogin(login);
  if (user !== undefined) return userSource(user);
  return { __typename: 'Organization', login, id: gid('Organization', login), databaseId: 0, name: login, email: '' };
}

function repoSource(repo: RepoRecord): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: RepoRecord, issue: IssueRecord): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: RepoRecord, issue: IssueRecord): Source {
  return { __typename: 'PullRequest', repo, issue };
}

function commentSource(repo: RepoRecord, issue: IssueRecord, comment: IssueRecord['comments'][number]): Source {
  return { __typename: 'IssueComment', repo, issue, comment };
}

/** A connection over an ordered item list, honoring first/after. */
function connection<T>(items: readonly T[], args: Record<string, unknown>, keyOf: (item: T) => string | number, nodeOf: (item: T) => Source): Source {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string') {
    const afterKey = Buffer.from(args.after, 'base64').toString('utf8').replace(/^cursor:/, '');
    const index = items.findIndex((item) => String(keyOf(item)) === afterKey);
    if (index !== -1) start = index + 1;
  }
  const slice = items.slice(start, start + first);
  const hasNext = start + slice.length < items.length;
  return {
    __typename: 'Connection',
    nodes: slice.map(nodeOf),
    edges: slice.map((item) => ({ __typename: 'Edge', node: nodeOf(item), cursor: cursorOf(keyOf(item)) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(keyOf(slice[0])) : null,
      endCursor: slice.length > 0 ? cursorOf(keyOf(slice[slice.length - 1])) : null,
    },
    totalCount: items.length,
  };
}

// --------------------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'createdAt', 'updatedAt'] },
  Organization: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'isArchived', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'assignees', 'milestone', 'reactionGroups', 'viewerDidAuthor'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'isDraft', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'commits', 'comments', 'reviews', 'additions', 'deletions', 'changedFiles'],
  },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'authoredDate'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

function typeSource(name: string): Source | null {
  const info = TYPE_FIELDS[name];
  if (info === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: info.kind,
    description: null,
    fields: (info.fields ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null })),
    enumValues: (info.enumValues ?? []).map((valueName) => ({ __typename: '__EnumValue', name: valueName, description: null })),
    possibleTypes: null,
    inputFields: null,
    interfaces: [],
    ofType: null,
  };
}

// --------------------------------------------------------------------------- resolvers

type Resolver = (ctx: Ctx, source: Source | null, args: Record<string, unknown>) => unknown;

function repoOf(source: Source | null): RepoRecord {
  return (source as { repo: RepoRecord }).repo;
}

function issueOf(source: Source | null): IssueRecord {
  return (source as { issue: IssueRecord }).issue;
}

function visibleRepo(ctx: Ctx, owner: string, name: string): RepoRecord | undefined {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) return undefined;
  if (repo.owner !== VIEWER.login && repo.owner !== ORG_LOGIN) return undefined;
  return repo;
}

function issueState(issue: IssueRecord): string {
  if (issue.pull?.merged) return 'MERGED';
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function sortIssues(issues: IssueRecord[], args: Record<string, unknown>): IssueRecord[] {
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  return [...issues].sort((a, b) => direction * (a.createdSeq - b.createdSeq) || direction * (a.number - b.number));
}

function filterByStates(issues: IssueRecord[], args: Record<string, unknown>): IssueRecord[] {
  const states = args.states as string[] | undefined;
  if (states === undefined || states.length === 0) return issues;
  return issues.filter((issue) => states.includes(issueState(issue)));
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSource(VIEWER),
    repository: (ctx, _source, args) => {
      const repo = visibleRepo(ctx, String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoSource(repo);
    },
    node: (ctx, _source, args) => {
      const parsed = parseGid(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(parsed.key));
        return repo === undefined ? null : repoSource(repo);
      }
      if (parsed.type === 'User') {
        const user = [VIEWER].find((candidate) => candidate.id === Number(parsed.key));
        return user === undefined ? null : userSource(user);
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        for (const repo of ctx.forge.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.id === Number(parsed.key)) {
              return parsed.type === 'Issue' ? issueSource(repo, issue) : pullSource(repo, issue);
            }
          }
        }
        return null;
      }
      return null;
    },
    __type: (_ctx, _source, args) => typeSource(String(args.name ?? '')),
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
      mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
      subscriptionType: null,
      types: Object.keys(TYPE_FIELDS).map((name) => typeSource(name)),
      directives: [],
    }),
    rateLimit: () => ({ __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '2030-01-01T00:00:00Z', nodeCount: 0 }),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(parsed.key));
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found for createIssue' });
        return null;
      }
      const issue: IssueRecord = {
        id: ctx.forge.nextIssueIdValue(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        authorLogin: VIEWER.login,
        createdSeq: ctx.forge.tick(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.issueId ?? ''));
      if (parsed !== null) {
        for (const repo of ctx.forge.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.id === Number(parsed.key)) {
              issue.state = 'closed';
              if (issue.pull !== undefined) issue.pull.state = 'closed';
              return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
            }
          }
        }
      }
      ctx.errors.push({ message: 'issue not found for closeIssue' });
      return null;
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(parsed.key));
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found for createPullRequest' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const issue: IssueRecord = {
        id: ctx.forge.nextIssueIdValue(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        authorLogin: VIEWER.login,
        createdSeq: ctx.forge.tick(),
        comments: [],
        pull: {
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          headRef: head,
          baseRef: base,
          merged: false,
          mergedAtSeq: null,
          mergeCommitSha: null,
        },
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      if (parsed !== null) {
        for (const repo of ctx.forge.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.id === Number(parsed.key) && issue.pull !== undefined) {
              if (!issue.pull.merged) {
                const result = squashMergePull(ctx.forge, repo, issue);
                if (result === 'conflict') {
                  ctx.errors.push({ message: 'merge conflict' });
                  return null;
                }
              }
              return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
            }
          }
        }
      }
      ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
      return null;
    },
    addComment: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.subjectId ?? ''));
      if (parsed !== null) {
        for (const repo of ctx.forge.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.id === Number(parsed.key)) {
              const comment = {
                id: ctx.forge.nextCommentIdValue(),
                body: String(input.body ?? ''),
                authorLogin: VIEWER.login,
                createdSeq: ctx.forge.tick(),
              };
              issue.comments.push(comment);
              return {
                __typename: 'AddCommentPayload',
                commentEdge: { __typename: 'Edge', node: commentSource(repo, issue, comment), cursor: cursorOf(comment.id) },
                clientMutationId: input.clientMutationId ?? null,
              };
            }
          }
        }
      }
      ctx.errors.push({ message: 'subject not found for addComment' });
      return null;
    },
  },
  User: {
    id: (_ctx, source) => (source as { id: string }).id,
    login: (_ctx, source) => (source as { login: string }).login,
    name: (_ctx, source) => (source as { name: string }).name,
    email: (_ctx, source) => (source as { email: string }).email,
    databaseId: (_ctx, source) => (source as { databaseId: number }).databaseId,
    url: (_ctx, source) => `http://forge.invalid/${(source as { login: string }).login}`,
    createdAt: () => '2020-01-01T00:00:00Z',
    updatedAt: () => '2020-01-01T00:00:00Z',
  },
  Repository: {
    id: (_ctx, source) => gid('Repository', repoOf(source).id),
    databaseId: (_ctx, source) => repoOf(source).id,
    name: (_ctx, source) => repoOf(source).name,
    nameWithOwner: (_ctx, source) => `${repoOf(source).owner}/${repoOf(source).name}`,
    owner: (_ctx, source) => ownerSource(repoOf(source).owner),
    description: (_ctx, source) => repoOf(source).description,
    isPrivate: (_ctx, source) => repoOf(source).private,
    isArchived: () => false,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    createdAt: (ctx, source) => ctx.forge.isoOf(repoOf(source).createdSeq),
    updatedAt: (ctx, source) => ctx.forge.isoOf(repoOf(source).createdSeq),
    pushedAt: (ctx, source) => ctx.forge.isoOf(repoOf(source).createdSeq),
    url: (_ctx, source) => `http://forge.invalid/${repoOf(source).owner}/${repoOf(source).name}`,
    stargazerCount: () => 0,
    forkCount: () => 0,
    primaryLanguage: () => null,
    licenseInfo: () => null,
    defaultBranchRef: (ctx, source) => {
      const repo = repoOf(source);
      const tip = refSha(repo, branchRef(repo.defaultBranch));
      if (tip === undefined) return null;
      return {
        __typename: 'Ref',
        id: gid('Ref', `${repo.id}:${repo.defaultBranch}`),
        name: repo.defaultBranch,
        prefix: 'refs/heads/',
        target: { __typename: 'Commit', id: gid('Commit', tip), oid: tip, message: '', authoredDate: ctx.forge.isoOf(0) },
      };
    },
    issue: (_ctx, source, args) => {
      const repo = repoOf(source);
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined || issue.pull !== undefined) return null;
      return issueSource(repo, issue);
    },
    issues: (_ctx, source, args) => {
      const repo = repoOf(source);
      const all = sortIssues(filterByStates([...repo.issues.values()].filter((issue) => issue.pull === undefined), args), args);
      return connection(all, args, (issue) => issue.number, (issue) => issueSource(repo, issue));
    },
    pullRequest: (_ctx, source, args) => {
      const repo = repoOf(source);
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined || issue.pull === undefined) return null;
      return pullSource(repo, issue);
    },
    pullRequests: (_ctx, source, args) => {
      const repo = repoOf(source);
      const all = sortIssues(filterByStates([...repo.issues.values()].filter((issue) => issue.pull !== undefined), args), args);
      return connection(all, args, (issue) => issue.number, (issue) => pullSource(repo, issue));
    },
  },
  Issue: {
    id: (_ctx, source) => gid('Issue', issueOf(source).id),
    databaseId: (_ctx, source) => issueOf(source).id,
    number: (_ctx, source) => issueOf(source).number,
    title: (_ctx, source) => issueOf(source).title,
    body: (_ctx, source) => issueOf(source).body,
    state: (_ctx, source) => issueState(issueOf(source)),
    closed: (_ctx, source) => issueOf(source).state === 'closed',
    author: () => userSource(VIEWER),
    createdAt: (ctx, source) => ctx.forge.isoOf(issueOf(source).createdSeq),
    updatedAt: (ctx, source) => ctx.forge.isoOf(issueOf(source).createdSeq),
    closedAt: (ctx, source) => (issueOf(source).state === 'closed' ? ctx.forge.isoOf(issueOf(source).createdSeq) : null),
    url: (_ctx, source) => `http://forge.invalid/${repoOf(source).owner}/${repoOf(source).name}/issues/${issueOf(source).number}`,
    repository: (_ctx, source) => repoSource(repoOf(source)),
    labels: (_ctx, source, args) => {
      const repo = repoOf(source);
      void repo;
      const names = issueOf(source).labels;
      return connection(names, args, (name) => name, (name) => ({ __typename: 'Label', id: gid('Label', name), name, color: 'ededed', description: null }));
    },
    comments: (_ctx, source, args) => {
      const repo = repoOf(source);
      const issue = issueOf(source);
      return connection(issue.comments, args, (comment) => comment.id, (comment) => commentSource(repo, issue, comment));
    },
    assignees: (_ctx, _source, args) => connection([], args, () => 0, () => userSource(VIEWER)),
    milestone: () => null,
    reactionGroups: () => [],
    viewerDidAuthor: () => true,
  },
  PullRequest: {
    id: (_ctx, source) => gid('PullRequest', issueOf(source).id),
    databaseId: (_ctx, source) => issueOf(source).id,
    number: (_ctx, source) => issueOf(source).number,
    title: (_ctx, source) => issueOf(source).title,
    body: (_ctx, source) => issueOf(source).body,
    state: (_ctx, source) => issueState(issueOf(source)),
    merged: (_ctx, source) => issueOf(source).pull?.merged ?? false,
    mergedAt: (ctx, source) => {
      const seq = issueOf(source).pull?.mergedAtSeq;
      return seq === null || seq === undefined ? null : ctx.forge.isoOf(seq);
    },
    mergeCommit: (_ctx, source) => {
      const sha = issueOf(source).pull?.mergeCommitSha;
      return sha === null || sha === undefined ? null : { __typename: 'Commit', id: gid('Commit', sha), oid: sha, message: '', authoredDate: '' };
    },
    headRefName: (_ctx, source) => issueOf(source).pull?.headRef ?? '',
    baseRefName: (_ctx, source) => issueOf(source).pull?.baseRef ?? '',
    headRefOid: (_ctx, source) => refSha(repoOf(source), branchRef(issueOf(source).pull?.headRef ?? '')) ?? '',
    baseRefOid: (_ctx, source) => refSha(repoOf(source), branchRef(issueOf(source).pull?.baseRef ?? '')) ?? '',
    mergeable: (_ctx, source) => {
      const issue = issueOf(source);
      if (issue.pull?.merged) return 'UNKNOWN';
      return pullMergeable(repoOf(source), issue) ? 'MERGEABLE' : 'CONFLICTING';
    },
    isDraft: () => false,
    author: () => userSource(VIEWER),
    createdAt: (ctx, source) => ctx.forge.isoOf(issueOf(source).createdSeq),
    updatedAt: (ctx, source) => ctx.forge.isoOf(issueOf(source).createdSeq),
    closedAt: (ctx, source) => (issueOf(source).state === 'closed' ? ctx.forge.isoOf(issueOf(source).createdSeq) : null),
    url: (_ctx, source) => `http://forge.invalid/${repoOf(source).owner}/${repoOf(source).name}/pull/${issueOf(source).number}`,
    repository: (_ctx, source) => repoSource(repoOf(source)),
    files: (_ctx, source, args) => {
      const repo = repoOf(source);
      const issue = issueOf(source);
      const pull = issue.pull as NonNullable<IssueRecord['pull']>;
      const headTip = refSha(repo, branchRef(pull.headRef));
      const baseTip = refSha(repo, branchRef(pull.baseRef));
      const base = headTip !== undefined && baseTip !== undefined ? mergeBase(repo, headTip, baseTip) : null;
      const fromTree = base === null ? undefined : commitTree(repo, base);
      const toTree = headTip === undefined ? undefined : commitTree(repo, headTip);
      const files = diffTrees(repo, fromTree, toTree).map((file) => ({
        __typename: 'PullRequestFile',
        path: String(file.filename),
        additions: Number(file.additions),
        deletions: Number(file.deletions),
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      return connection(files, args, (file) => file.path, (file) => file);
    },
    commits: (_ctx, _source, args) => connection([], args, () => 0, () => ({ __typename: 'Commit', id: '', oid: '', message: '', authoredDate: '' })),
    comments: (_ctx, source, args) => {
      const repo = repoOf(source);
      const issue = issueOf(source);
      return connection(issue.comments, args, (comment) => comment.id, (comment) => commentSource(repo, issue, comment));
    },
    reviews: (_ctx, _source, args) => connection([], args, () => 0, () => ({ __typename: 'PullRequestReview', id: '', state: '' })),
    additions: (_ctx, source) => pullFileTotals(repoOf(source), issueOf(source)).additions,
    deletions: (_ctx, source) => pullFileTotals(repoOf(source), issueOf(source)).deletions,
    changedFiles: (_ctx, source) => pullFileTotals(repoOf(source), issueOf(source)).count,
  },
  Label: {
    id: (_ctx, source) => (source as { id: string }).id,
    name: (_ctx, source) => (source as { name: string }).name,
    color: (_ctx, source) => (source as { color: string }).color,
    description: (_ctx, source) => (source as { description: string | null }).description,
  },
  IssueComment: {
    id: (_ctx, source) => gid('IssueComment', (source as { comment: { id: number } }).comment.id),
    databaseId: (_ctx, source) => (source as { comment: { id: number } }).comment.id,
    body: (_ctx, source) => (source as { comment: { body: string } }).comment.body,
    author: () => userSource(VIEWER),
    createdAt: (ctx, source) => ctx.forge.isoOf((source as { comment: { createdSeq: number } }).comment.createdSeq),
    updatedAt: (ctx, source) => ctx.forge.isoOf((source as { comment: { createdSeq: number } }).comment.createdSeq),
    url: (_ctx, source) => `http://forge.invalid/${repoOf(source).owner}/${repoOf(source).name}/issues/${issueOf(source).number}`,
  },
  Ref: {
    id: (_ctx, source) => (source as { id: string }).id,
    name: (_ctx, source) => (source as { name: string }).name,
    prefix: (_ctx, source) => (source as { prefix: string }).prefix,
    target: (_ctx, source) => (source as { target: unknown }).target,
  },
  Commit: {
    id: (_ctx, source) => (source as { id: string }).id,
    oid: (_ctx, source) => (source as { oid: string }).oid,
    message: (_ctx, source) => (source as { message: string }).message,
    authoredDate: (_ctx, source) => (source as { authoredDate: string }).authoredDate,
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => (source as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (_ctx, source) => (source as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (_ctx, source) => (source as { startCursor: string | null }).startCursor,
    endCursor: (_ctx, source) => (source as { endCursor: string | null }).endCursor,
  },
  Connection: {
    nodes: (_ctx, source) => (source as { nodes: unknown }).nodes,
    edges: (_ctx, source) => (source as { edges: unknown }).edges,
    pageInfo: (_ctx, source) => (source as { pageInfo: unknown }).pageInfo,
    totalCount: (_ctx, source) => (source as { totalCount: number }).totalCount,
  },
  Edge: {
    node: (_ctx, source) => (source as { node: unknown }).node,
    cursor: (_ctx, source) => (source as { cursor: string }).cursor,
  },
  __Type: {
    name: (_ctx, source) => (source as { name: string }).name,
    kind: (_ctx, source) => (source as { kind: string }).kind,
    description: () => null,
    fields: (_ctx, source) => (source as { fields: unknown }).fields,
    enumValues: (_ctx, source) => (source as { enumValues: unknown }).enumValues,
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    ofType: () => null,
  },
  __Field: {
    name: (_ctx, source) => (source as { name: string }).name,
    description: () => null,
    type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR', fields: [], enumValues: [] }),
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, source) => (source as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: (_ctx, source) => (source as { queryType: unknown }).queryType,
    mutationType: (_ctx, source) => (source as { mutationType: unknown }).mutationType,
    subscriptionType: () => null,
    types: (_ctx, source) => (source as { types: unknown }).types,
    directives: () => [],
  },
  RateLimit: {
    limit: (_ctx, source) => (source as { limit: number }).limit,
    cost: (_ctx, source) => (source as { cost: number }).cost,
    remaining: (_ctx, source) => (source as { remaining: number }).remaining,
    used: (_ctx, source) => (source as { used: number }).used,
    resetAt: (_ctx, source) => (source as { resetAt: string }).resetAt,
    nodeCount: (_ctx, source) => (source as { nodeCount: number }).nodeCount,
  },
  CreateIssuePayload: {
    issue: (_ctx, source) => (source as { issue: unknown }).issue,
    clientMutationId: (_ctx, source) => (source as { clientMutationId: unknown }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (_ctx, source) => (source as { issue: unknown }).issue,
    clientMutationId: (_ctx, source) => (source as { clientMutationId: unknown }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, source) => (source as { pullRequest: unknown }).pullRequest,
    clientMutationId: (_ctx, source) => (source as { clientMutationId: unknown }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, source) => (source as { pullRequest: unknown }).pullRequest,
    clientMutationId: (_ctx, source) => (source as { clientMutationId: unknown }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, source) => (source as { commentEdge: unknown }).commentEdge,
    clientMutationId: (_ctx, source) => (source as { clientMutationId: unknown }).clientMutationId,
  },
  PullRequestFile: {
    path: (_ctx, source) => (source as { path: string }).path,
    additions: (_ctx, source) => (source as { additions: number }).additions,
    deletions: (_ctx, source) => (source as { deletions: number }).deletions,
    changeType: (_ctx, source) => (source as { changeType: string }).changeType,
  },
  PullRequestReview: {
    id: (_ctx, source) => (source as { id: string }).id,
    state: (_ctx, source) => (source as { state: string }).state,
  },
};

function pullFileTotals(repo: RepoRecord, issue: IssueRecord): { additions: number; deletions: number; count: number } {
  const pull = issue.pull as NonNullable<IssueRecord['pull']>;
  const headTip = refSha(repo, branchRef(pull.headRef));
  const baseTip = refSha(repo, branchRef(pull.baseRef));
  const base = headTip !== undefined && baseTip !== undefined ? mergeBase(repo, headTip, baseTip) : null;
  const fromTree = base === null ? undefined : commitTree(repo, base);
  const toTree = headTip === undefined ? undefined : commitTree(repo, headTip);
  const files = diffTrees(repo, fromTree, toTree);
  return {
    additions: files.reduce((sum, file) => sum + Number(file.additions), 0),
    deletions: files.reduce((sum, file) => sum + Number(file.deletions), 0),
    count: files.length,
  };
}

// --------------------------------------------------------------------------- entry

export interface GraphqlReply {
  status: number;
  body: unknown;
}

function runOne(forge: Forge, payload: { query?: string; variables?: Record<string, unknown>; operationName?: string }): Record<string, unknown> {
  const ctx: Ctx = { forge, variables: payload.variables ?? {}, fragments: new Map(), errors: [] };
  try {
    const parser = new Parser(payload.query ?? '');
    const { operations, fragments } = parser.parseDocument();
    ctx.fragments = fragments;
    const operation = payload.operationName === undefined
      ? operations[0]
      : (operations.find((candidate) => candidate.name === payload.operationName) ?? operations[0]);
    if (operation === undefined) throw new Error('no operation in document');
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = execute(ctx, rootType, { __typename: rootType }, operation.selection, []);
    const reply: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) reply.errors = ctx.errors;
    return reply;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
}

/** Handle one GraphQL request body (a single operation or a batched array of them). */
export function handleGraphql(forge: Forge, rawBody: string): GraphqlReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => runOne(forge, entry as { query?: string })) };
  }
  return { status: 200, body: runOne(forge, parsed as { query?: string }) };
}
