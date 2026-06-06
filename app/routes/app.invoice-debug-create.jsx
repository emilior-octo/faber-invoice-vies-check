import { data as json, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);

  const created = await prisma.invoiceRequest.create({
    data: {
      shop: session.shop,
      invoiceType: "private",
      status: "validated",
      fiscalCode: "DEBUG-CF",
      pec: "debug@example.com",
      sdi: "DEBUG",
      companyName: "",
      vatNumber: "",
      countryCode: "IT",
      reverseCharge: false,
      viesChecked: false,
      viesValid: null,
      taxExemptApplied: false,
    },
  });

  const count = await prisma.invoiceRequest.count();

  return json({
    ok: true,
    sessionShop: session.shop,
    createdId: created.id,
    count,
  });
}

export default function DebugCreate() {
  const data = useLoaderData();

  return (
    <pre style={{ padding: 24, whiteSpace: "pre-wrap" }}>
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}