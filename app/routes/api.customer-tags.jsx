import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin, cors } = await authenticate.admin(request);

  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId");

    if (!customerId) {
      return cors(
        Response.json(
          { ok: false, error: "customerId mancante" },
          { status: 400 },
        ),
      );
    }

    const response = await admin.graphql(
      `#graphql
        query CustomerTags($id: ID!) {
          customer(id: $id) {
            id
            tags
          }
        }
      `,
      {
        variables: { id: customerId },
      },
    );

    const json = await response.json();
    const tags = json?.data?.customer?.tags || [];

    return cors(
      Response.json({
        ok: true,
        customerId,
        tags,
      }),
    );
  } catch (error) {
    return cors(
      Response.json(
        {
          ok: false,
          error: error?.message || "Errore interno",
        },
        { status: 500 },
      ),
    );
  }
}