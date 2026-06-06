import {authenticate} from "../shopify.server";

const MANAGED_TAGS = [
  "discount_15%:yes",
  "discount_10%:yes",
  "discount_5%:yes",
  "discount_3%:yes",
  "discount_2%:yes",
  "discount_ricambi_10%:yes",
  "discount_ricambi_20%:yes",
  "discount_ricambi_30%:yes",
];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

function isManaged(tag) {
  return MANAGED_TAGS.includes(tag) || tag.startsWith("discount_custom_");
}

async function getCustomerTags(admin, customerId) {
  const query = `
    query CustomerTags($id: ID!) {
      customer(id: $id) {
        tags
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: {id: customerId},
  });

  const result = await response.json();
  return result?.data?.customer?.tags || [];
}

export async function loader({request}) {
  try {
    const {admin} = await authenticate.admin(request);
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId");

    if (!customerId) return json({ok: false, error: "Missing customerId"}, 400);

    const tags = await getCustomerTags(admin, customerId);
    return json({ok: true, tags});
  } catch (error) {
    return json({ok: false, error: error.message || "Unknown error"}, 500);
  }
}

export async function action({request}) {
  try {
    const {admin} = await authenticate.admin(request);
    const {customerId, tagsToAdd = []} = await request.json();

    if (!customerId) return json({ok: false, error: "Missing customerId"}, 400);

    const existingTags = await getCustomerTags(admin, customerId);
    const keptTags = existingTags.filter((tag) => !isManaged(tag));
    const finalTags = [...keptTags, ...tagsToAdd];

    const mutation = `
      mutation CustomerUpdate($input: CustomerInput!) {
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
      }
    `;

    const response = await admin.graphql(mutation, {
      variables: {
        input: {
          id: customerId,
          tags: finalTags,
        },
      },
    });

    const result = await response.json();
    const errors = result?.data?.customerUpdate?.userErrors || [];

    if (errors.length) return json({ok: false, error: errors[0].message}, 400);

    return json({
      ok: true,
      tags: result.data.customerUpdate.customer.tags,
    });
  } catch (error) {
    return json({ok: false, error: error.message || "Unknown error"}, 500);
  }
}