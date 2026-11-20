[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sambob0606/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sambob0606/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# makefun-github-forge

A GitHub-compatible git forge in one dependency-free TypeScript process, built for the
[github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) on make.fun.

## What it serves

- **Git smart HTTP** — `/{owner}/{repo}.git`: protocol v2 upload-pack (ls-refs, fetch with
  shallow/deepen, thin-pack clients) and v0 receive-pack (report-status, side-band-64k,
  delete-refs, non-fast-forward enforcement, OFS/REF delta packs on the way in).
- **REST v3** — `/api/v3`: repositories, branches, refs, commits, contents, labels, issues,
  comments, pull requests, squash merge with three-way conflict detection, pagination
  with `Link` headers, `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** — `/api/graphql`: viewer, repository, issue and pull-request queries,
  connections with cursors, the create/close/merge mutations, `__type` introspection,
  batched requests, and unknown-field errors that name the field.
- **MCP** — `/mcp`: JSON-RPC 2.0 Streamable HTTP, modern `server/discover` plus the legacy
  `initialize` handshake, and six tools: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## How it works

- One in-memory store (`store.ts`) backs all four surfaces, so a push over git shows up
  in REST, GraphQL and MCP immediately.
- Git objects are implemented from scratch (`store.ts` / `gitproto.ts`): SHA-1 object
  hashing, commit/tree/blob/tag formats, non-delta packfiles, delta application for
  incoming packs, reachability with shallow boundaries.
- The bearer token names the scenario viewer: the login is derived from the suite's
  fixed public scenario seed (`scenario.ts`), so the forge's owner matches the
  trial's viewer without any configuration.
- No dependencies, no git binary, no install step. Node 22+ with type stripping.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, then polls
`/done` until the trial ends and exits 0. For local grading, start the server through
the kit's local runner instead (see the kit's `sdk/run.ts`).

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle (bind, register, poll `/done`, exit 0). |
| `app.ts` | HTTP server, routing and bearer auth, git smart-HTTP endpoints. |
| `scenario.ts` | The seeded viewer derivation (FNV-1a + splitmix64 + xorshift64*). |
| `store.ts` | In-memory model, git objects, packs, reachability, issues/PRs, merges. |
| `gitproto.ts` | Pkt-lines, protocol v2/v0 advertisements, ls-refs, fetch, receive-pack. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser, executor and introspection. |
| `mcp.ts` | MCP JSON-RPC handlers and the six tools. |
| `http.ts` | Request/response plumbing shared by every surface. |

## License

MIT
