import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for the Fly.io/Docker deployment (a minimal runtime image with
  // only the traced production dependencies — matches every other app in
  // the landscape). Verified working end-to-end on Linux/musl (node:22-alpine)
  // during the Phase 1 production readiness review: `next build --turbopack`
  // with this enabled produces .next/standalone/server.js correctly.
  //
  // On the Windows dev machine used for local development, this (and,
  // separately, Next's own built-in build-time lint pass) triggers a `glob`
  // EPERM scanning a legacy "Application Data" junction under the Windows
  // user profile — confirmed Windows-local-machine-specific, NOT a Next.js/
  // Turbopack/project bug: reproduced and ruled out independently, and does
  // not occur on Linux. `npm run build` is pinned to `--turbopack` (see
  // package.json) so local Windows builds keep working; the standalone
  // output itself needs no platform-specific handling.
  output: "standalone",
  // `npm run lint` remains the authoritative lint check (run separately,
  // always green) — Next's own built-in build-time lint pass is redundant
  // with that and was one of the two triggers of the Windows-only issue
  // above, so it stays disabled regardless of platform.
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
