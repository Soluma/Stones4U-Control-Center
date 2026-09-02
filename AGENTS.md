# Agent instructions — Stones4U Control Center

- Always inspect the current repository state before making changes (`git status`, relevant files).
- Never assume prior chat history reflects the current codebase — read the actual files.
- Make small, targeted changes. Do not rewrite unrelated code.
- Do not change `prisma/schema.prisma` without explaining the migration first.
- Do not remove existing working functionality without being asked.
- After changes, run: `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build`.
- Never touch sibling repositories (`OfferteApp`, `s4u-quote-app`, `Kassa Systeem`, `TelefoonSysteem`) — see `CLAUDE.md`.
- Never print or commit secret values. Only environment variable **names** belong in docs/commits.
