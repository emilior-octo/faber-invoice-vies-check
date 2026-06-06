import fs from "node:fs";
import path from "node:path";

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const STATIC_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const DRY_RUN = process.env.DRY_RUN !== "false";
const CSV_PATH =
  process.env.CSV_PATH ||
  "C:\\shopify-apps\\customer-discount-panel\\data\\Faber Clienti 22_01 - Foglio6 (1).csv";

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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && insideQuotes && next === '"') {
      cell += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") i += 1;

      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function normalizeHeader(value) {
  return String(value || "").trim().replace(/^\uFEFF/, "");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function clean(value) {
  return String(value || "").trim();
}

function empty(value) {
  return !String(value || "").trim();
}

function normalizeVat(value) {
  return clean(value).replace(/\s+/g, "").toUpperCase();
}

function buildCompanyName(company, vatId) {
  const cleanCompany = clean(company);
  const cleanVat = normalizeVat(vatId);

  if (cleanCompany && cleanVat) return `${cleanCompany} - P.IVA ${cleanVat}`;
  if (cleanCompany) return cleanCompany;
  if (cleanVat) return `P.IVA ${cleanVat}`;

  return "";
}

function countryCodeFromCsv(value) {
  const country = clean(value).toUpperCase();

  if (!country) return null;
  if (country === "IT" || country === "ITALIA" || country === "ITALY") return "IT";

  return country.length === 2 ? country : null;
}

function provinceFromCsv(value) {
  return clean(value) || null;
}

function rowToAddress(row) {
  return {
    firstName: clean(row.shipping_first_name),
    lastName: clean(row.shipping_last_name),
    address1: clean(row.shipping_address_1),
    city: clean(row.shipping_city),
    province: provinceFromCsv(row.shipping_state),
    zip: clean(row.shipping_postcode),
    countryCode: countryCodeFromCsv(row.shipping_country),
    company: clean(row.billing_company),
  };
}

function mergeAddress(existingAddress, csvAddress, vatId) {
  const company = buildCompanyName(csvAddress.company, vatId);

  const input = {};

  if (empty(existingAddress?.firstName) && csvAddress.firstName) {
    input.firstName = csvAddress.firstName;
  }

  if (empty(existingAddress?.lastName) && csvAddress.lastName) {
    input.lastName = csvAddress.lastName;
  }

  if (empty(existingAddress?.address1) && csvAddress.address1) {
    input.address1 = csvAddress.address1;
  }

  if (empty(existingAddress?.city) && csvAddress.city) {
    input.city = csvAddress.city;
  }

  if (empty(existingAddress?.province) && csvAddress.province) {
    input.province = csvAddress.province;
  }

  if (empty(existingAddress?.zip) && csvAddress.zip) {
    input.zip = csvAddress.zip;
  }

  if (empty(existingAddress?.countryCodeV2) && csvAddress.countryCode) {
    input.countryCode = csvAddress.countryCode;
  }

  if (empty(existingAddress?.company) && company) {
    input.company = company;
  }

  return input;
}

function addressForCreate(csvAddress, vatId) {
  return {
    firstName: csvAddress.firstName || null,
    lastName: csvAddress.lastName || null,
    address1: csvAddress.address1 || null,
    city: csvAddress.city || null,
    province: csvAddress.province || null,
    zip: csvAddress.zip || null,
    countryCode: csvAddress.countryCode || null,
    company: buildCompanyName(csvAddress.company, vatId) || null,
  };
}

function hasAddressInputFields(input) {
  return Object.keys(input).some((key) => key !== "id" && input[key]);
}

async function getCustomerByEmail(email) {
  const data = await graphql(
    `query CustomerByEmail($query: String!) {
      customers(first: 2, query: $query) {
        nodes {
          id
          displayName
          email
          defaultAddress {
            id
            firstName
            lastName
            company
            address1
            city
            province
            zip
            countryCodeV2
          }
          vatId: metafield(namespace: "talon-approval", key: "vat_id") {
            value
          }
        }
      }
    }`,
    { query: `email:${email}` }
  );

  return data.customers.nodes[0] || null;
}

async function customerAddressUpdate(customerId, addressId, address) {
  const data = await graphql(
    `mutation CustomerAddressUpdate(
      $customerId: ID!
      $addressId: ID!
      $address: MailingAddressInput!
    ) {
      customerAddressUpdate(
        customerId: $customerId
        addressId: $addressId
        address: $address
      ) {
        address {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { customerId, addressId, address }
  );

  const errors = data.customerAddressUpdate.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return data.customerAddressUpdate.address;
}

async function customerAddressCreate(customerId, address) {
  const data = await graphql(
    `mutation CustomerAddressCreate(
      $customerId: ID!
      $address: MailingAddressInput!
      $defaultAddress: Boolean
    ) {
      customerAddressCreate(
        customerId: $customerId
        address: $address
        defaultAddress: $defaultAddress
      ) {
        address {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { customerId, address, defaultAddress: true }
  );

  const errors = data.customerAddressCreate.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return data.customerAddressCreate.address;
}

function loadCsvRows() {
  const resolvedPath = path.resolve(CSV_PATH);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`CSV not found: ${resolvedPath}`);
  }

  const text = fs.readFileSync(resolvedPath, "utf8");
  const rows = parseCsv(text);
  const headers = rows[0].map(normalizeHeader);

  return rows.slice(1).map((values) => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = clean(values[index]);
    });

    return item;
  });
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
  console.log(`CSV: ${CSV_PATH}`);

  const rows = loadCsvRows();
  const byEmail = new Map();

  for (const row of rows) {
    const email = normalizeEmail(row.billing_email);
    if (!email) continue;

    if (!byEmail.has(email)) {
      byEmail.set(email, row);
    }
  }

  let total = 0;
  let notFound = 0;
  let skippedNoVat = 0;
  let skippedNoChanges = 0;
  let skippedNoUsableAddress = 0;
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const [email, row] of byEmail.entries()) {
    total += 1;

    try {
      const customer = await getCustomerByEmail(email);

      if (!customer) {
        notFound += 1;
        console.log(`NOT FOUND: ${email}`);
        continue;
      }

      const vatId = normalizeVat(customer.vatId?.value);

      if (!vatId) {
        skippedNoVat += 1;
        console.log(`SKIP no talon-approval.vat_id: ${email}`);
        continue;
      }

      const csvAddress = rowToAddress(row);
      const existingAddress = customer.defaultAddress;

      if (existingAddress?.id) {
        const input = mergeAddress(existingAddress, csvAddress, vatId);

        if (!hasAddressInputFields(input)) {
          skippedNoChanges += 1;
          console.log(`SKIP no empty fields: ${email}`);
          continue;
        }

        console.log("");
        console.log(`UPDATE: ${email}`);
        console.log(input);

        if (!DRY_RUN) {
          await customerAddressUpdate(customer.id, existingAddress.id, input);
        }

        updated += 1;
      } else {
        const input = addressForCreate(csvAddress, vatId);

        if (!hasAddressInputFields(input)) {
          skippedNoUsableAddress += 1;
          console.log(`SKIP no usable address fields: ${email}`);
          continue;
        }

        console.log("");
        console.log(`CREATE ADDRESS: ${email}`);
        console.log(input);

        if (!DRY_RUN) {
          await customerAddressCreate(customer.id, input);
        }

        created += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`FAILED ${email}:`, err.message);
    }
  }

  console.log("");
  console.log("DONE");
  console.log({
    total,
    notFound,
    skippedNoVat,
    skippedNoChanges,
    skippedNoUsableAddress,
    created,
    updated,
    failed,
    dryRun: DRY_RUN,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});