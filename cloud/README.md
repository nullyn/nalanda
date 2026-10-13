# Nalanda remote MCP

This is the Cloudflare implementation of Nalanda. It uses Workers, D1, Vectorize,
Workers AI, Browser Run and Queues. Your Mac runs only the agent client after
migration. It needs no local server, Ollama, OpenRouter or paid JEV API.

**Current state:** deployed at `https://nalanda.nullyn.workers.dev/mcp`. Authentication,
MCP discovery, GitHub hydration, semantic search and document reading have been
verified against the hosted bindings. All 5,162 archived documents have been ingested and indexed; live searches across
all three sources return results with no pending imports or embeddings. Consult
`nalanda_status` for current coverage. The existing CLI archive
remains intact. Cloud Chromium previously synced X and Instagram to that archive;
Worker-based X hydration is deferred after the account's free browser allowance
was consumed during testing. Following an Instagram account security alert, the
old cloud session was removed and replaced after the user signed in again locally.
Instagram refresh is configured again, with a bounded validation job queued;
successful Worker-based Instagram fetching remains unverified. Captured Instagram
content remains searchable.

Cloud embeddings use `@cf/google/embeddinggemma-300m`: the Gemma 3-based model,
reduced to 512 dimensions and normalized. Existing local EmbeddingGemma 2 vectors
are not uploaded or mixed with it. Indexing uses captured text to create new
vectors. D1 holds the canonical text and provenance; Vectorize is derived data.

## Connect after deployment

The endpoint is `https://nalanda.nullyn.workers.dev/mcp`.
Authentication uses a dedicated Nalanda token, **not your Cloudflare API token**.
Keep the Nalanda token in the client's environment or a protected local file.

```bash
# Start Codex with NALANDA_MCP_TOKEN available in its environment:
codex mcp add nalanda \
  --url https://nalanda.<your-workers-subdomain>.workers.dev/mcp \
  --bearer-token-env-var NALANDA_MCP_TOKEN

# Claude Code supports HTTP MCP servers with an Authorization header:
claude mcp add --transport http --scope user nalanda \
  https://nalanda.<your-workers-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer $NALANDA_MCP_TOKEN"
```

Restart/reconnect the agent after adding the server. Claude Code's `/mcp` shows
its connection state. A browser opening `/mcp` without credentials receives 401;
the endpoint is intended for MCP clients.

| Tool | Purpose |
| --- | --- |
| `nalanda_status` | Counts, last fetch timestamps, source configuration, pending vectors |
| `nalanda_search` | Hybrid, semantic or keyword search; source/account filters; citation evidence |
| `nalanda_read` | Read a document by its search-result ID, with text offsets |
| `nalanda_sync` | Start/reuse a bounded source hydration job |
| `nalanda_sync_status` | Inspect a job's completion, errors and partial coverage |
| `nalanda_index` | Queue missing/changed embeddings |
| `nalanda_import` | Import saved text from the existing archive |
| `nalanda_enrich` | Queue keywords and an inferred summary written by the calling agent |

Example agent request:

> Use Nalanda to refresh my X bookmarks and Instagram AI collection. Check each
> sync job's status, and report partial scans or expired sessions. Search my saved
> material for browser automation approaches. Cite the original URLs and preserve
> the distinction between captured text and inferred summaries.

The calling agent can categorize with its own model and submit `nalanda_enrich`.
Nalanda does not ask a paid provider to generate answers or tags. It never needs
the calling agent's inference API key. No MCP sampling support is required.
Enrichment returns an `importJob` ID; poll it before expecting the new keywords
in search. It keeps captured text and inference provenance separate.

## Hydration and recovery

Sync returns a durable job ID immediately. Queue consumers process one bounded
step at a time. D1 leases prevent simultaneous work on the same job; overlapping
requests reuse an active source job. Queue failures leave the job recoverable.
Every ten minutes a scheduled recovery pass redispatches pending/expired work.
A daily schedule requests all configured sources at 01:15 UTC.
Captured pages enter the same bounded ingestion queue as archive imports. A source
job's completion describes fetching; follow `result.importJob` and library pending
counts to check ingestion and indexing. This keeps a twenty-post X page within
D1's free per-invocation query budget.

X captures ordinary authenticated web Bookmarks responses through Playwright.
It keeps a page cursor between job steps and stops on a fully known page. A
`maxPages` cap explicitly reports partial coverage; the next request resumes its
checkpoint instead of restarting that capped scan. Instagram verifies the configured collection's link and performs up to five bounded
scroll passes, retaining at most 250 discovered links. Already captured/staged
items are skipped during discovery. It processes one pending post per browser
step and keeps the complete discovered backlog in D1 across capped or failed jobs.
`maxItems` limits each run; it does not truncate the backlog. `result.coverage`
reports discovered backlog and remaining items. Coverage is always **partial**:
there is no guarantee of complete collection pagination or discovery.

Instagram diagnostics identify `open-saved`, `verify-account`, `open-collection`,
`discover-posts` or `read-post`. Detected login pages, challenges and account
mismatches stop without automatic retries. Daily cron leaves a renewal-required
job stopped. After the owner signs in and an authorized operator updates
`INSTAGRAM_SESSION_COOKIES`, call `nalanda_sync` for Instagram with
`sessionRenewed: true`. This explicitly resumes the job; it does not log in or
update cookies itself. No export-import recovery is configured. UI/network
failures remain bounded retries with stage diagnostics.

GitHub's cloud adapter reads public stars and READMEs via GitHub's
free API; private repository refresh is not supported without separately scoped
GitHub authorization. Previously captured private content remains in the archive.

The free browser plan allows one launch every 20 seconds and ten minutes/day.
Jobs reserve at most six launches/day, pace starts, cap session work at 45 seconds
and use a ten-second inactivity timeout. Budget-deferred jobs resume on a later
UTC day. This is a conservative application limit, not proof of unused account
quota: other Cloudflare browser activity shares the provider allowance. Free
quotas fail closed; there is no paid fallback or automatic upgrade.

Posts removed from a saved collection and unstarred repositories stay archived.
No media, screenshots, HTML captures, audio or verbatim speech transcripts are
stored. Speech/OCR extraction is not implemented by this phase. Agent summaries
are stored separately as inferred metadata and included in retrieval with an
explicit label. Source refreshes preserve those enrichments.

## Deployment

Deployment requires account-scoped API permissions for Workers Scripts, D1,
Vectorize and Queues (Edit), plus Browser Run Edit and Workers AI Read. Creating
that credential and storing ongoing X/Instagram sessions as Worker secrets
requires the user's specific confirmation. No paid plan is required by this
configuration, but actual free CPU and usage limits must be tested after deploy.

1. Install with `pnpm install` and run `pnpm --filter @nalanda/cloud build`.
2. Create a D1 database named `nalanda`; set its actual ID in a private Wrangler
   config derived from `wrangler.jsonc`. Set your source account names in `vars`.
3. Create `nalanda-embeddinggemma-512` with 512 dimensions and cosine distance.
   Create string metadata indexes for `source` and `account` before inserting.
4. Create the `nalanda-jobs` queue. Apply all tracked migrations with
   `wrangler d1 migrations apply nalanda --remote --config <private-config>`.
5. Deploy using the private config. Without `MCP_TOKEN`, all HTTP requests fail
   authentication. Set a fresh random `MCP_TOKEN` and JSON cookie arrays in
   `X_SESSION_COOKIES` and `INSTAGRAM_SESSION_COOKIES` using Worker secrets.
   Session values must stay out of Git, model prompts and deployment logs.
6. Check authenticated MCP discovery and unauthorized 401 behavior, then import
   the archive. Test cloud source jobs and usage before depending on the schedule.

```bash
# One-time archive migration; run from the cloud directory:
NALANDA_MCP_URL=https://nalanda.<your-workers-subdomain>.workers.dev/mcp \
NALANDA_MCP_TOKEN_FILE=/absolute/path/to/private-token \
  pnpm exec tsx scripts/import-local.ts
```

Migration imports only X bookmarks, saved Instagram content and GitHub stars.
It retains timestamps and citation URLs, ignores old vectors and legacy media,
and keeps the local archive available for rollback. The HTTP tool durably stages
each batch in D1 and returns its import job; a Queue consumer does chunking and
index updates outside the HTTP request's small free CPU budget. Staged text is
deleted after processing. Batches are idempotent and can be rerun after interruption;
`NALANDA_IMPORT_OFFSET` can resume a reported batch offset. Check both
`pendingImports` and `pendingPassages`; acceptance does not imply searchable
content or completed embeddings yet.

## Development checks

```bash
pnpm --filter @nalanda/cloud typecheck
pnpm --filter @nalanda/cloud build
pnpm --filter @nalanda/cloud test
```

Tests use real D1/FTS execution in Miniflare and an actual MCP client. AI and
Vectorize are simulated for repeatable correctness tests; hosted Workers AI and
authenticated Browser Run probes were tested separately. Cloud Worker CPU,
Vectorize propagation, provider rate limits and full daily hydration still need
deployment measurements.
