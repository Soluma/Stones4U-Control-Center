# Release strategy — Stones4U Control Center

Written after the logistics release of 23-09-2026, when it turned out that
`main` contained finished-but-never-released work that would have ridden
along with a routine deploy — including two schema migrations. This file
exists so the next release does not have to rediscover that.

Companion documents: `docs/deployment/FLY-PRODUCTION.md` (how to deploy),
`docs/deployment/FLY-STAGING.md` (staging). This one is about *what* to
deploy and from *where*.

## What is running right now

| | Commit | Fly app | Release |
|---|---|---|---|
| CRM | `8f23016` (tag `prod-crm-v30`) | `stones4u-control-center` | v30, 23-09-2026 |
| OfferteApp | `9eb16c5` | `offerteapp` | v477, 23-09-2026 |

The CRM commit is **not** the tip of `main`. It is `6f725de` (the previous
production state) with exactly three logistics commits cherry-picked onto
it.

## Branches

| Branch | Meaning |
|---|---|
| `production` | Exactly the code running in production. Only ever moved forward by an actual, verified deploy, and tagged `prod-crm-v<fly release>`. |
| `main` | Integration/development. May contain work that is finished but deliberately not released. |
| `release/<feature>` | A release candidate: branched from `production`, carrying only the commits of that release. |

## Why `main` currently differs from production

`main` is ahead of `production` by two delivery commits that have never run
in production:

- `9286b5a` — fulfillment-date customer request flow (public `/delivery/[token]`
  form, new staff and API routes)
- `d1f3618` — Shopify Order Status fulfillment-date backend (extension session
  tokens, new API route and service)

Together they also carry two migrations:

```
20260911101850_add_handoff_fulfillment_mode
20260911142110_make_handoff_creator_nullable
```

Both are additive and harmless in themselves, but `prisma migrate deploy`
runs as the Fly release command, so deploying `main` would have changed the
production schema as a side effect of shipping a read-only feature. That is
why the logistics release was assembled on its own branch instead.

## Where new work starts

Branch from **`production`**, not from `main`, unless the feature genuinely
needs code that only exists on `main`. If it does need that code, then it
cannot ship before that code ships — decide that consciously at the start,
not on release day.

```bash
git switch -c feature/<name> production
```

## Releasing

1. **Assemble the candidate.** Branch from `production` and cherry-pick only
   the commits of this release. If a cherry-pick conflicts, resolve it
   against production's code — never by importing the unreleased work the
   conflict is pointing at.
2. **Read the diff before anything else:**
   ```bash
   git diff --stat production..release/<feature>
   git diff --name-only production..release/<feature> -- prisma/    # expect empty
   ```
   Every changed file should be explainable in one sentence. Anything else
   is a stop signal.
3. **Build and test from a clean worktree**, never from the normal working
   tree:
   ```bash
   git worktree add <tmp> release/<feature>
   cd <tmp> && npm ci && npx prisma generate
   npm run lint && npm run typecheck && npm run build && npm run test
   ```
   The generated Prisma client is gitignored, so a fresh worktree needs
   `prisma generate` before `typecheck` will pass.
4. **Deploy with the production config.** A bare `fly deploy` uses `fly.toml`,
   which is **staging**:
   ```bash
   fly deploy -a stones4u-control-center --config fly.production.toml
   ```
5. **Record it.** Move `production` to the deployed commit and tag it:
   ```bash
   git branch -f production <sha>
   git tag -a prod-crm-v<NN> <sha> -m "CRM production release v<NN>, <date>: <what>"
   ```

## Rules that came from real incidents

- **Never deploy a dirty working tree.** The normal CRM working tree usually
  carries unfinished work. Deploy from a worktree pinned to a commit, so what
  ships is exactly what was reviewed.
- **Never stash, reset or discard someone's uncommitted work to make a release
  possible.** A worktree costs nothing and touches nothing.
- **Check for migrations every time.** They ride along silently in the release
  command; `git diff production..<candidate> -- prisma/` is the whole check.
- **Verify what production actually runs** rather than assuming it matches a
  commit. The image ships the sources, so a file-level comparison settles it:
  ```bash
  fly ssh console -a stones4u-control-center -C "cat /app/src/<file>"
  ```
  Route probes work too: an existing authenticated route answers 401, a route
  that does not exist answers 404.

## Not on GitHub yet

`origin/main` is at `9286b5a`. The logistics commits, the `production`
branch and the `prod-crm-v30` tag exist **only on this machine**. Until they
are pushed, the exact code running in production is not backed up anywhere
else.
