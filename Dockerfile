# syntax=docker/dockerfile:1
#
# Multi-stage build for Fly.io deployment (Next.js 15 standalone output).
# See docs/build/PHASE-1-PRODUCTION-READINESS.md §7/§8 for the verified
# design this follows, and docs/deployment/FLY-STAGING.md for how it's used.
#
# No secret values are ever baked into this image or passed as build args —
# every sensitive value (DATABASE_URL, SESSION_SECRET, SHOPIFY_*) is
# injected at runtime by Fly as an environment variable from `fly secrets`.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Full install (incl. devDependencies) — tailwindcss/typescript/etc. are
# needed to run `next build` in the next stage, not at runtime.
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# The traced, minimal server that actually handles HTTP traffic.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Migration + one-time bootstrap tooling. Fly's release_command and
# `fly ssh console` both execute against this same runtime image; neither
# `prisma migrate deploy` nor scripts/bootstrap-admin.ts is reachable from
# any Next.js route, so Next's standalone tracer does not pull them in —
# they're added explicitly here.
#
# `.next/standalone` (copied above) carries the *full* original
# package.json verbatim, devDependencies and all. Installing prisma/tsx/
# dotenv straight into /app would make npm reconcile that whole
# devDependencies list (eslint/tailwind/vitest/typescript/...), defeating a
# minimal runtime image — and installing them into a sibling directory
# instead (e.g. /opt/tools) doesn't work either: Node's module resolution
# for a plain `import "dotenv/config"` walks up parent directories of the
# importing file, so a sibling directory is never found. The fix: rewrite
# package.json in place to drop devDependencies before installing, so
# prisma/tsx/dotenv land in /app/node_modules as ordinary `dependencies`
# (unaffected by NODE_ENV=production) alongside the app's own runtime deps
# that the standalone copy already installed correctly.
RUN node -e "const p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2));" \
  && npm install --no-save prisma@6.19.3 tsx@4.23.13 dotenv@17.4.2

COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/generated ./src/generated
COPY --from=builder /app/tsconfig.json ./tsconfig.json

RUN chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000
CMD ["node", "server.js"]
