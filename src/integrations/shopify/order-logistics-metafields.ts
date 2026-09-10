import "server-only";
import { shopifyGraphQL } from "./client";
import { assertShopifyWriteAllowed } from "./write-safety-guard";
import { ShopifyApiError } from "./errors";

// Phase 6R — mirrors the customer's logistics answers onto the Shopify Order
// as dedicated metafields, so other Stones4U systems can read them as shared
// operational values instead of reaching into Control Center's database.
//
// WHY METAFIELDS AND NOT customAttributes: `orderUpdate` replaces the whole
// customAttributes array, so every write there is a read-merge-write that can
// clobber another app's key. `metafieldsSet` is addressed per
// (ownerId, namespace, key) and touches nothing else, which is both safer and
// the reason this module never fetches or writes an unrelated metafield.
// Metafields are also not rendered on customer-facing Shopify surfaces the way
// note attributes can be, which keeps the open customer-visibility question
// from Phase 6O from widening.
//
// `requested_delivery_date` deliberately stays a customAttribute: its
// Draft -> Order propagation is proven and other systems already read it.
// Moving it is explicitly out of scope here.

export const STONES4U_METAFIELD_NAMESPACE = "stones4u";
export const DELIVERY_COMMENT_METAFIELD_KEY = "delivery_comment";
export const LARGE_TRUCK_ACCESS_METAFIELD_KEY = "large_truck_access_confirmed";

const DELIVERY_COMMENT_METAFIELD_TYPE = "multi_line_text_field";
const LARGE_TRUCK_ACCESS_METAFIELD_TYPE = "boolean";

/** Structurally identical to modules/delivery's DeliveryFieldPatch, declared
 * here rather than imported: this repo's module boundary (CLAUDE.md) forbids
 * integrations depending on modules, and TypeScript's structural typing means
 * a caller's patch is assignable either way. */
type FieldPatch<T> = { action: "PRESERVE" } | { action: "SET"; value: T };

/** What the caller wants mirrored. A field left `undefined` is not touched at
 * all — the same preserve-vs-set distinction the local write uses, carried
 * through to Shopify so a date-only submission cannot blank a metafield. */
export type OrderLogisticsMetafieldPatch = {
  deliveryComment?: FieldPatch<string | null>;
  largeTruckAccessConfirmed?: FieldPatch<boolean>;
};

export type OrderLogisticsMetafieldResult = {
  orderGid: string;
  /** Keys actually written this call. */
  written: string[];
  /** Keys actually removed this call. */
  deleted: string[];
  /** True when nothing needed doing — every field was PRESERVE, or a clear
   * was requested on an already-absent metafield. */
  noop: boolean;
};

type CurrentMetafield = { id: string; value: string; compareDigest: string } | null;

const CURRENT_QUERY = /* GraphQL */ `
  query OrderLogisticsMetafields($id: ID!, $namespace: String!, $commentKey: String!, $truckKey: String!) {
    order(id: $id) {
      id
      comment: metafield(namespace: $namespace, key: $commentKey) {
        id
        value
        compareDigest
      }
      truck: metafield(namespace: $namespace, key: $truckKey) {
        id
        value
        compareDigest
      }
    }
  }
`;

// Deliberately scoped to exactly our two keys — this never enumerates the
// Order's other metafields, so another app's data is neither read nor risked.
type CurrentResponse = { order: { id: string; comment: CurrentMetafield; truck: CurrentMetafield } | null };

const SET_MUTATION = /* GraphQL */ `
  mutation SetOrderLogisticsMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        namespace
        key
        value
        type
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

type SetResponse = {
  metafieldsSet: {
    metafields: { namespace: string; key: string; value: string; type: string }[];
    userErrors: { field: string[] | null; message: string; code: string | null }[];
  };
};

const DELETE_MUTATION = /* GraphQL */ `
  mutation DeleteOrderLogisticsMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type DeleteResponse = {
  metafieldsDelete: {
    deletedMetafields: ({ namespace: string; key: string } | null)[];
    userErrors: { field: string[] | null; message: string }[];
  };
};

function currentQueryVariables(orderGid: string) {
  return {
    id: orderGid,
    namespace: STONES4U_METAFIELD_NAMESPACE,
    commentKey: DELIVERY_COMMENT_METAFIELD_KEY,
    truckKey: LARGE_TRUCK_ACCESS_METAFIELD_KEY,
  };
}

/**
 * Mirrors the logistics answers onto the Order.
 *
 * Safety chain, every time:
 * 1. `assertShopifyWriteAllowed()` — shop-identity allowlist, before any read.
 * 2. Read the current value of *only* our two keys, for their compareDigest.
 * 3. Apply: `metafieldsSet` for values, `metafieldsDelete` to clear a remark.
 * 4. Handle `userErrors` explicitly — never infer success from their absence.
 * 5. Re-read and verify the post-state before reporting success.
 *
 * **Compare-and-set**: when a metafield already exists, its `compareDigest` is
 * sent back with the write, so Shopify rejects the update if another Stones4U
 * system changed the value in between rather than letting this call silently
 * overwrite something newer. A metafield that does not exist yet is created
 * unconditionally — there is no prior value to protect.
 *
 * **Clearing a remark** uses `metafieldsDelete`, not an empty string: a
 * `multi_line_text_field` treats "" as a value, so deleting is the only way to
 * genuinely return the Order to "no current remark".
 *
 * `orderGid` is always server-derived from the persisted handoff; no shop or
 * owner id is ever accepted from client input.
 */
export async function mirrorOrderLogisticsMetafields(
  orderGid: string,
  patch: OrderLogisticsMetafieldPatch,
): Promise<OrderLogisticsMetafieldResult> {
  const commentPatch = patch.deliveryComment;
  const truckPatch = patch.largeTruckAccessConfirmed;

  const wantsComment = commentPatch?.action === "SET";
  const wantsTruck = truckPatch?.action === "SET";
  if (!wantsComment && !wantsTruck) {
    // Nothing was stated, so nothing is touched — not even a read.
    return { orderGid, written: [], deleted: [], noop: true };
  }

  await assertShopifyWriteAllowed();

  const current = await shopifyGraphQL<CurrentResponse>(CURRENT_QUERY, currentQueryVariables(orderGid));
  if (!current.order) {
    throw new ShopifyApiError(`Order ${orderGid} bestaat niet (meer) in Shopify.`);
  }

  const sets: {
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
    compareDigest?: string;
  }[] = [];
  const deletes: { ownerId: string; namespace: string; key: string }[] = [];

  if (commentPatch?.action === "SET") {
    if (commentPatch.value === null) {
      // Only delete something that is actually there; deleting an absent
      // metafield is a no-op we simply skip.
      if (current.order.comment) {
        deletes.push({
          ownerId: orderGid,
          namespace: STONES4U_METAFIELD_NAMESPACE,
          key: DELIVERY_COMMENT_METAFIELD_KEY,
        });
      }
    } else {
      sets.push({
        ownerId: orderGid,
        namespace: STONES4U_METAFIELD_NAMESPACE,
        key: DELIVERY_COMMENT_METAFIELD_KEY,
        type: DELIVERY_COMMENT_METAFIELD_TYPE,
        value: commentPatch.value,
        ...(current.order.comment ? { compareDigest: current.order.comment.compareDigest } : {}),
      });
    }
  }

  if (truckPatch?.action === "SET") {
    sets.push({
      ownerId: orderGid,
      namespace: STONES4U_METAFIELD_NAMESPACE,
      key: LARGE_TRUCK_ACCESS_METAFIELD_KEY,
      type: LARGE_TRUCK_ACCESS_METAFIELD_TYPE,
      // A Shopify boolean metafield carries the string "true"/"false".
      value: truckPatch.value ? "true" : "false",
      ...(current.order.truck ? { compareDigest: current.order.truck.compareDigest } : {}),
    });
  }

  if (sets.length > 0) {
    const result = await shopifyGraphQL<SetResponse>(SET_MUTATION, { metafields: sets });
    const errors = result.metafieldsSet.userErrors;
    if (errors.length > 0) {
      // Includes a compareDigest conflict, which means another system wrote a
      // newer value — surfaced as a failure rather than retried blindly.
      throw new ShopifyApiError("Shopify metafieldsSet gaf userErrors terug.", { graphqlErrors: errors });
    }
  }

  if (deletes.length > 0) {
    const result = await shopifyGraphQL<DeleteResponse>(DELETE_MUTATION, { metafields: deletes });
    const errors = result.metafieldsDelete.userErrors;
    if (errors.length > 0) {
      throw new ShopifyApiError("Shopify metafieldsDelete gaf userErrors terug.", { graphqlErrors: errors });
    }
  }

  // Verification — never report success on the strength of an absent
  // userErrors array alone.
  const after = await shopifyGraphQL<CurrentResponse>(CURRENT_QUERY, currentQueryVariables(orderGid));
  if (!after.order) {
    throw new ShopifyApiError(`Order ${orderGid} kon na de metafield-schrijfactie niet worden gelezen.`);
  }

  if (commentPatch?.action === "SET") {
    const stored = after.order.comment?.value ?? null;
    if (stored !== commentPatch.value) {
      throw new ShopifyApiError(
        `Verificatie na metafield-schrijfactie mislukt: ${DELIVERY_COMMENT_METAFIELD_KEY} op ${orderGid} heeft niet de verwachte waarde.`,
      );
    }
  }
  if (truckPatch?.action === "SET") {
    const expected = truckPatch.value ? "true" : "false";
    if ((after.order.truck?.value ?? null) !== expected) {
      throw new ShopifyApiError(
        `Verificatie na metafield-schrijfactie mislukt: ${LARGE_TRUCK_ACCESS_METAFIELD_KEY} op ${orderGid} heeft niet de verwachte waarde.`,
      );
    }
  }

  return {
    orderGid,
    written: sets.map((s) => s.key),
    deleted: deletes.map((d) => d.key),
    noop: sets.length === 0 && deletes.length === 0,
  };
}

/** Read-only helper for drift detection — reads only our two keys. */
export async function readOrderLogisticsMetafields(
  orderGid: string,
): Promise<{ deliveryComment: string | null; largeTruckAccessConfirmed: boolean | null }> {
  const data = await shopifyGraphQL<CurrentResponse>(CURRENT_QUERY, currentQueryVariables(orderGid));
  if (!data.order) {
    throw new ShopifyApiError(`Order ${orderGid} bestaat niet (meer) in Shopify.`);
  }
  const truckRaw = data.order.truck?.value ?? null;
  return {
    deliveryComment: data.order.comment?.value ?? null,
    largeTruckAccessConfirmed: truckRaw === null ? null : truckRaw === "true",
  };
}
