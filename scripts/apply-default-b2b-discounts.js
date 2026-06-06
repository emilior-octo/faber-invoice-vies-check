const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const STATIC_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const DRY_RUN = process.env.DRY_RUN !== "false";

const ALL_COLLECTION_HANDLES = [
  "ricambi",
  "pro-deluxe-3-0",
  "pro-inox-3-0",
  "pro-essential-3-0",
  "slot-plast-2",
  "slot-inox-2",
  "pro-deluxe-2-0",
  "mini-agenta",
  "agenta",
];

const DEFAULT_DISCOUNTS = [
  "b2b:slot-plast-2:preset_20:yes",
  "b2b:slot-inox-2:preset_20:yes",
  "b2b:pro-inox-3-0:preset_20_5:yes",
  "b2b:pro-essential-3-0:preset_20_5:yes",
  "b2b:pro-deluxe-2-0:preset_20:yes",
  "b2b:pro-deluxe-3-0:preset_20_10:yes",
  "b2b:agenta:preset_20:yes",

  // RICAMBI = 0 → nessuna entry
  // MINI AGENTA = 0 → nessuna entry
];

let ACCESS_TOKEN_CACHE = null;

if (!SHOP) {
  console.error("Missing env var SHOPIFY_STORE_DOMAIN");
  process.exit(1);
}

if (!STATIC_TOKEN && (!CLIENT_ID || !CLIENT_SECRET)) {
  console.error(
    "Missing auth env vars. Use either SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET."
  );
  process.exit(1);
}

async function getAccessToken() {
  if (ACCESS_TOKEN_CACHE) return ACCESS_TOKEN_CACHE;

  if (STATIC_TOKEN) {
    ACCESS_TOKEN_CACHE = STATIC_TOKEN.trim().replace(/^["']|["']$/g, "");
    return ACCESS_TOKEN_CACHE;
  }

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID.trim(),
      client_secret: CLIENT_SECRET.trim(),
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json?.access_token) {
    throw new Error(
      `Unable to get access token via client credentials: ${JSON.stringify(
        json,
        null,
        2
      )}`
    );
  }

  ACCESS_TOKEN_CACHE = json.access_token;
  return ACCESS_TOKEN_CACHE;
}

async function graphql(query, variables = {}) {
  const token = await getAccessToken();

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.errors) {
    throw new Error(JSON.stringify(json?.errors || json, null, 2));
  }

  return json.data;
}

function isManagedB2BTag(tag) {
  if (typeof tag !== "string") return false;

  return ALL_COLLECTION_HANDLES.some((handle) => {
    return (
      tag.startsWith(`b2b:${handle}:preset_`) ||
      tag.startsWith(`b2b:${handle}:discount_`)
    );
  });
}

function cleanTags(existingTags) {
  const preservedTags = existingTags.filter((tag) => !isManagedB2BTag(tag));

  return Array.from(new Set([...preservedTags, ...DEFAULT_DISCOUNTS]));
}

async function getCustomers(cursor = null) {
  const data = await graphql(
    `query Customers($cursor: String) {
      customers(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          displayName
          email
          tags
        }
      }
    }`,
    { cursor }
  );

  return data.customers;
}

async function updateCustomerTags(customerId, tags) {
  const data = await graphql(
    `mutation UpdateCustomerTags($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer {
          id
          tags
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      input: {
        id: customerId,
        tags,
      },
    }
  );

  const errors = data.customerUpdate.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return data.customerUpdate.customer.tags;
}

async function updateCustomerDiscountMetafield(customerId) {
  const data = await graphql(
    `mutation SetCustomerDiscountMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          type
          value
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      metafields: [
        {
          ownerId: customerId,
          namespace: "custom",
          key: "discount",
          type: "list.single_line_text_field",
          value: JSON.stringify(DEFAULT_DISCOUNTS),
        },
      ],
    }
  );

  const errors = data.metafieldsSet.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return data.metafieldsSet.metafields[0];
}

async function main() {
  console.log(`Shop: ${SHOP}`);
  console.log(`API version: ${API_VERSION}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(
    `Auth mode: ${
      STATIC_TOKEN ? "SHOPIFY_ADMIN_ACCESS_TOKEN" : "CLIENT_CREDENTIALS"
    }`
  );
  console.log("Default discounts:", DEFAULT_DISCOUNTS);

  let cursor = null;
  let total = 0;
  let updated = 0;
  let failed = 0;

  do {
    const page = await getCustomers(cursor);

    for (const customer of page.nodes) {
      total += 1;

      const currentTags = Array.isArray(customer.tags) ? customer.tags : [];
      const nextTags = cleanTags(currentTags);

      console.log("");
      console.log(`Customer: ${customer.displayName || customer.email || customer.id}`);
      console.log(`ID: ${customer.id}`);
      console.log(`B2B entries: ${DEFAULT_DISCOUNTS.join(", ")}`);

      if (DRY_RUN) {
        console.log("DRY RUN: skipped write");
        continue;
      }

      try {
        await updateCustomerDiscountMetafield(customer.id);
        await updateCustomerTags(customer.id, nextTags);

        updated += 1;
        console.log("Updated");
      } catch (err) {
        failed += 1;
        console.error("Failed:", err.message);
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  console.log("");
  console.log("DONE");
  console.log({ total, updated, failed, dryRun: DRY_RUN });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});