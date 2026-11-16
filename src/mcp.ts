// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP, speaking the 2026-07-28 revision
// (server/discover) and the classic initialize handshake. Its tools act on the same store
// as REST, so an object made over MCP reads back over /api/v3 unchanged.

import {
  Forge,
  VIEWER,
  branchRef,
  refSha,
  type IssueRecord,
  type RepoRecord,
} from './store.ts';
import { issueJson, pullJson, repoJson, squashMergePull } from './rest.ts';

export interface McpRequest {
  method: string;
  body: string;
  authed: boolean;
  headers: Record<string, string | string[] | undefined>;
}

export interface McpReply {
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

const REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair, as an alternative to owner and repo.' },
    },
    required: [],
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: repoProperty(),
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: repoProperty(),
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: repoProperty(),
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: repoProperty(),
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List a repository\u2019s pull requests.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: repoProperty(),
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: repoProperty(),
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function repoProperty(): { type: string; description: string } {
  return { type: 'string', description: 'The repository name.' };
}

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
      },
    })),
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(forge: Forge, args: Record<string, unknown>): RepoRecord | undefined {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let name = typeof args.repo === 'string' ? args.repo : undefined;
  if ((owner === undefined || name === undefined) && typeof args.full_name === 'string') {
    const split = args.full_name.indexOf('/');
    if (split !== -1) {
      owner = args.full_name.slice(0, split);
      name = args.full_name.slice(split + 1);
    }
  }
  if (owner === undefined || name === undefined) return undefined;
  return forge.getRepo(owner, name);
}

function callTool(forge: Forge, name: string, rawArgs: unknown): Record<string, unknown> | null {
  const tool = TOOLS.find((candidate) => candidate.name === name || candidate.name.endsWith(`__${name}`) || name.endsWith(`__${candidate.name}`));
  if (tool === undefined) return null;
  const args = (rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName) !== undefined) return toolError('repository already exists');
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      return repo === undefined ? toolError('repository not found') : toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const issue: IssueRecord = {
        id: forge.nextIssueIdValue(),
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        authorLogin: VIEWER.login,
        createdSeq: forge.tick(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => issue.pull === undefined)
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq)
        .map((issue) => issueJson(forge, repo, issue));
      return toolResult({ issues: list, count: list.length });
    }
    case 'get_issue': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      return issue === undefined ? toolError('issue not found') : toolResult(issueJson(forge, repo, issue));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const head = String(args.head).includes(':') ? String(args.head).slice(String(args.head).indexOf(':') + 1) : String(args.head);
      const base = String(args.base).includes(':') ? String(args.base).slice(String(args.base).indexOf(':') + 1) : String(args.base);
      if (refSha(repo, branchRef(head)) === undefined || refSha(repo, branchRef(base)) === undefined) {
        return toolError('head or base branch does not exist');
      }
      const issue: IssueRecord = {
        id: forge.nextIssueIdValue(),
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        authorLogin: VIEWER.login,
        createdSeq: forge.tick(),
        comments: [],
        pull: {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullJson(forge, repo, issue));
    }
    case 'list_pull_requests': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => issue.pull !== undefined)
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq)
        .map((issue) => pullJson(forge, repo, issue));
      return toolResult({ pull_requests: list, count: list.length });
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const issue = repo.issues.get(Number(args.pull_number));
      if (issue === undefined || issue.pull === undefined) return toolError('pull request not found');
      if (issue.pull.merged) return toolError('pull request is already merged');
      const result = squashMergePull(forge, repo, issue);
      if (result === 'conflict') return toolError('merge conflict');
      return toolResult({ ...pullJson(forge, repo, issue), sha: result, merged: true });
    }
    default:
      return null;
  }
}

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: id ?? null };
}

function handleOne(forge: Forge, message: RpcMessage): Record<string, unknown> | null {
  const { id, method } = message;
  const params = message.params ?? {};
  const isNotification = id === undefined;
  switch (method) {
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        result: {
          protocolVersion: REVISION,
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
        id,
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
      const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : REVISION;
      return {
        jsonrpc: '2.0',
        result: { protocolVersion: chosen, capabilities: CAPABILITIES, serverInfo: SERVER_INFO },
        id,
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', result: {}, id };
    case 'tools/list':
      return { jsonrpc: '2.0', result: toolsListResult(), id };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const result = callTool(forge, name, params.arguments);
      if (result === null) return rpcError(id, -32601, `unknown tool: ${name}`);
      return { jsonrpc: '2.0', result, id };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', result: { resources: [] }, id };
    case 'prompts/list':
      return { jsonrpc: '2.0', result: { prompts: [] }, id };
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method ?? ''}`);
  }
}

/** Handle one MCP HTTP request. */
export async function handleMcp(forge: Forge, req: McpRequest): Promise<McpReply> {
  if (!req.authed) {
    return { status: 401, body: { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null } };
  }
  if (req.method === 'GET') return { status: 405, headers: { allow: 'POST' } };
  if (req.method === 'DELETE') return { status: 405, headers: { allow: 'POST' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'parse error') };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((entry) => handleOne(forge, entry as RpcMessage))
      .filter((reply) => reply !== null);
    if (replies.length === 0) return { status: 202 };
    return { status: 200, body: replies };
  }
  const message = parsed as RpcMessage;
  const reply = handleOne(forge, message);
  if (reply === null) return { status: 202 };
  const headers: Record<string, string> = {};
  if (message.method === 'initialize') headers['mcp-session-id'] = 'forge-session';
  return { status: 200, body: reply, headers };
}
