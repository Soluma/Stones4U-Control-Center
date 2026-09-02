// Test-only stub for the "server-only" package, which relies on bundler-
// specific resolution conditions Next.js provides but Vite/vitest does not.
// Aliased in vitest.config.mts. This does not weaken the real guard — it
// only affects the test runner, never the Next.js production build.
export {};
