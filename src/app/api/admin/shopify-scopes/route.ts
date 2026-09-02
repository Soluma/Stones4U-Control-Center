import { NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/guards";
import { shopifyGraphQL } from "@/integrations/shopify/client";
import { toErrorResponse } from "@/lib/api-error";

// TEMPORARY diagnostic route — ADMIN-only. Confirms which Shopify Admin API
// scopes the configured client-credentials app actually has, for comparing
// against what each integration needs (docs/platform-discovery/03). Read-only
// against Shopify (no mutation, matches ADR-006 "Phase 1 is read-only").
//
// Response is deliberately narrowed to scope handles only — never the access
// token, client secret, or any other credential. Remove this route once its
// diagnostic purpose is served; it isn't part of Phase 1 product scope.

const ACCESS_SCOPE_LIST_QUERY = /* GraphQL */ `
  query AccessScopeList {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

type AccessScopeListResponse = {
  currentAppInstallation: {
    accessScopes: { handle: string }[];
  };
};

export async function GET() {
  try {
    await requireAdmin();

    const data = await shopifyGraphQL<AccessScopeListResponse>(ACCESS_SCOPE_LIST_QUERY);
    const scopes = data.currentAppInstallation.accessScopes.map((scope) => scope.handle);

    return NextResponse.json({ scopes });
  } catch (error) {
    return toErrorResponse(error);
  }
}
