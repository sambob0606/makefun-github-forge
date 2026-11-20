# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sambob0606/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sambob0606/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge — REST v3, GraphQL v4, MCP tools, and the git smart-HTTP protocol (upload-pack v2/v0, receive-pack, shallow fetch) in dependency-free TypeScript. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

The entrypoint listens on an ephemeral port and registers it with the trial
environment. It reads its configuration from the environment:

| Variable | Meaning |
| --- | --- |
| `MAKEFUN_ENV_URL` | Trial environment base URL (`/register` + `/done`). Without it, the server just listens locally until killed. |
| `MAKEFUN_SHOP_TOKEN` | Bearer token the suite calls this entry with. |
| `MAKEFUN_TRIAL_NOW` | The trial's logical "now" (ISO 8601). All timestamps derive from it, so a live pass and its replay produce identical state. |
| `MAKEFUN_TRIAL_SEED` | Seed for randomness (unused — this entry is deterministic). |

Requires Node 22.18+ (type-stripping runs `main.ts` directly). No
dependencies, no install step, no build step.

## What it implements

- **Git smart HTTP** (`/<owner>/<repo>.git/info/refs`, `git-upload-pack`,
  `git-receive-pack`): protocol v2 (`ls-refs` with peel/symrefs/unborn/
  ref-prefix, `fetch` with thin-pack, ofs-delta, shallow/deepen) and
  protocol v0 (advertisement, fetch, receive-pack with `report-status`).
  Packs are written plain (no deltas) with a valid SHA-1 trailer; packs
  read back may carry ofs/ref deltas. Non-fast-forward pushes are refused
  with the exact reason `non-fast-forward`, and a failing ref never blocks
  the other refs in the same push.
- **REST v3** (`/api/v3/`): repos, branches, refs, commits, contents
  (create/update/delete with sha checks, unborn-repo first commit),
  labels, issues, comments, pull requests (three-way file merge,
  squash-merge, conflict → 405). Every reply is JSON with
  `X-GitHub-Request-Id` and `X-OAuth-Scopes`; any owner other than the
  token's user is a 404, never a 403.
- **GraphQL v4** (`/api/graphql`): `viewer`, `repository` (issues and pull
  requests as Relay connections with cursors), `node`, `__type`, batched
  operations, and the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations — all over the same store
  as REST, so the two views can never disagree.
- **MCP** (`/mcp`): JSON-RPC 2.0 with the 2026-07-28 `server/discover`
  handshake (plus legacy `initialize`), nine tools including
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request`.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entrypoint: listen, register with the trial environment, wait for done. |
| `app.ts` | HTTP server: auth, routing, response framing. |
| `rest.ts` | REST v3 surface. |
| `graphql.ts` | GraphQL v4 surface (parser + resolvers). |
| `mcp.ts` | MCP surface (JSON-RPC 2.0 tools). |
| `gitproto.ts` | Git wire protocol: pkt-lines, packfiles, v2/v0 fetch, receive-pack. |
| `service.ts` | Domain operations shared by REST, GraphQL and MCP. |
| `store.ts` | In-memory store, git object model, deterministic logical clock. |

## Determinism

The forge keeps all state in memory and never consults the wall clock or
`Math.random` in a graded run: every timestamp comes from a logical clock
seeded by `MAKEFUN_TRIAL_NOW` (one logical second per created entity),
every id from a counter, every pack byte from a sorted object list. The
same request order therefore leaves the same state export in a live pass
and in its replay.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=w3shbtmr&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
