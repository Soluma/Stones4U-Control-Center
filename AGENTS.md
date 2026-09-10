# Agent instructions — Stones4U Control Center

- Always inspect the current repository state before making changes (`git status`, relevant files).
- Never assume prior chat history reflects the current codebase — read the actual files.
- Make small, targeted changes. Do not rewrite unrelated code.
- Do not change `prisma/schema.prisma` without explaining the migration first.
- Do not remove existing working functionality without being asked.
- After changes, run: `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build`.
- Never touch sibling repositories (`OfferteApp`, `s4u-quote-app`, `Kassa Systeem`, `TelefoonSysteem`) — see `CLAUDE.md`.
- Never print or commit secret values. Only environment variable **names** belong in docs/commits.

## Shopify writes — the one rule that has already been broken

**Never perform a Shopify mutation with credentials outside the guarded
application client.** Every write must go through `shopifyGraphQL()` in
`src/integrations/shopify/client.ts`, so that `assertShopifyWriteAllowed()`
runs. Ad-hoc `fetch`/`curl`/script calls using the same credentials bypass the
guard completely — a repository guard cannot protect a shell script that
deliberately goes around it, which is why this is an operational rule and not
only a code one.

The two shops (verified live, 2026-09-10):

| Shop | Role | Evidence |
|---|---|---|
| `9h7x2c-ku.myshopify.com` | **PRODUCTION** | "Stones4U", www.stones4u.eu, paid plan, `plan.partnerDevelopment = false` |
| `stones4u-dev.myshopify.com` | development/staging | "Stones4U_dev", `plan.partnerDevelopment = true` |

Before any Shopify write, from anywhere, confirm the target shop by asking
Shopify itself (`shop { myshopifyDomain name plan { partnerDevelopment } }`).
A file named `.env.local`, a dev app, a local machine and a "test" marker all
describe the *caller*; only the shop domain describes the *target*. In Phase 6W
all four looked like development while the destination was production, and
eight real Orders plus two real Draft Orders were created on the live shop.
