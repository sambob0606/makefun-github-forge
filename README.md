[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sambob0606/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sambob0606/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# makefun-github-forge

A GitHub-compatible git forge in a single Node 22 process, standard library
only — no dependencies, no git binary, no network beyond the trial
environment. Written for the make.fun competition
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge").

## What it serves

One in-memory store (`store.ts`) backs four surfaces, so a repository,
issue or pull request created through any one of them reads back through
the others:

- **REST v3** (`rest.ts`) — `GET /api/v3/` and `/meta`, `/user`, `/user/repos`,
  `/repos/{owner}/{name}` (read/patch/delete), branches, git refs, commits,
  contents (create/update/delete with blob-sha checks), labels, issues and
  comments, pull requests (create, files, squash merge with three-way
  conflict detection).
- **Git smart HTTP** (`gitproto.ts`) — `info/refs`, `git-upload-pack` and
  `git-receive-pack` in protocol v0 and v2, with shallow/deepen fetches,
  sideband packfiles and report-status pushes. Packs are plain objects
  (no deltas) with a SHA-1 trailer; object ids are SHA-1.
- **GraphQL** (`graphql.ts`) — a small parser and executor for the query
  and mutation shapes the suite sends: `viewer`, `repository`, `node(id:)`,
  `__type` introspection, issue/pull-request connections with cursor
  pagination, and `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment`. Global ids are opaque base64url
  Relay ids, stable across reads.
- **MCP** (`mcp.ts`) — `server/discover` (revision `2026-07-28`) with the
  legacy `initialize` fallback, and six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Layout

| file | contents |
| --- | --- |
| `main.ts` | entrypoint: bind an ephemeral port, register it with the trial environment, poll `/done`, exit 0 |
| `app.ts` | HTTP server, routing, auth, request ids |
| `store.ts` | in-memory model, git object helpers, three-way merge |
| `gitcore.ts` | SHA-1 object ids, pkt-lines, trees/commits/tags, pack codec |
| `rest.ts` | REST v3 handlers |
| `graphql.ts` | GraphQL parser + executor |
| `mcp.ts` | MCP (JSON-RPC 2.0) handlers |
| `gitproto.ts` | git smart HTTP (v0/v2) |

## Running it

```sh
MAKEFUN_SHOP_TOKEN=<token> npm start
```

With `MAKEFUN_ENV_URL` set, the process registers its port with the trial
environment and exits when the environment reports done. Without it, it
serves on its bound port until killed (local development).

## Notes

- Stored timestamps come from a monotonic sequence counter, never the
  wall clock, so replaying the same request log leaves the state
  byte-identical.
- Authentication is the `MAKEFUN_SHOP_TOKEN` bearer token: required on
  REST, GraphQL and MCP; git endpoints reject only a wrong token and
  allow requests with none.
