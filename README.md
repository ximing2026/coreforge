# Coreforge — a GitHub-compatible git forge in one Node process

A standalone forge that speaks the four surfaces GitHub's own tooling uses, built for
[make.fun's github-core-clone-01](https://make.fun/bounty/github-core-clone-01). No git binary,
no database, no packages: one Node 22 process, Node builtins only, everything in memory.

## The four surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (`ls-refs` with peel/symrefs/unborn,
  `fetch` with haves negotiation, `deepen` and shallow boundaries) and protocol v0
  (upload-pack and receive-pack with report-status, side-band-64k and delete-refs).
  Pushes are fast-forward only; a mixed push applies the good refs and reports `ng` per bad ref.
- **REST v3** under `/api/v3` — repositories, contents (file writes are real commits),
  branches, git refs, commits, labels, issues with comments, and pull requests with
  file diffs and squash merges (three-way, with a line-level fallback before calling a conflict).
- **GraphQL v4** at `/api/graphql` — viewer, repository, issues/pullRequests connections with
  cursor pagination, `node(id:)` round-trips, the mutations gh drives (createIssue, closeIssue,
  createPullRequest, mergePullRequest, addComment), batched operations, and the `__type`
  feature-detection probes.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, the 2026-07-28 revision with
  `server/discover` (plus the classic initialize handshake), and eight tools that act on the
  same store as REST, so an issue created over MCP reads back over `/api/v3` unchanged.

## How it is put together

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register it, poll until done).
  Unchanged from the kit starter, by the contest's design.
- `app.ts` — the HTTP router: auth, request ids, and dispatch to the four surfaces.
- `src/gitobj.ts` — the git object model: SHA-1 loose objects, trees, commits, packfile
  reading (OFS/REF deltas) and writing, pkt-line framing.
- `src/store.ts` — the forge state: repositories with their own object stores and refs,
  issues and pull requests sharing GitHub's single number sequence, and a logical clock —
  every generated value is deterministic, because a trial is replayed and must agree byte
  for byte.
- `src/githttp.ts`, `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts` — one file per surface.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18+, which strips TypeScript types on its
own. There is nothing to install: no `node_modules`, no build step.

## License

MIT — see `LICENSE`.
