import "dotenv/config";

// Integration tests (customer-profile, notes, tasks, audit) run against the
// real local Postgres started for development (see README.md "Lokale
// setup") — DATABASE_URL comes from .env.local, loaded here. Pure unit
// tests (phone, rich-text, password, shopify-client) do not touch the
// database at all.
