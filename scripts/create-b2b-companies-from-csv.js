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
  "C:\\shopify-apps\\customer-discount-panel\\data\\Faber Clienti 22_01 - Foglio7 (1).csv";

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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID.trim(),
      client_secret: CLIENT_SECRET.trim(),
    }),
  });

  const json = await res.json();

  if (!res.ok || !json.access_token) {
    throw new Error(JSON.stringify(json, null, 2));
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

  const json = await res.json();

  if (!res.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json, null, 2));
  }

  return json.data;
}

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizeVat(value, country) {
  let vat = clean(value).replace(/\s+/g, "").toUpperCase();
  if (!vat) return "";

  const cc = clean(country).toUpperCase() || "IT";

  if (!vat.startsWith(cc)) {
    vat = `${cc}${vat}`;
  }

  return vat;
}

function countryCode(value) {
  const country = clean(value).toUpperCase();

  if (!country) return "IT";
  if (country === "ITALIA" || country === "ITALY") return "IT";

  return country.length === 2 ? country : "IT";
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

  return rows.filter((r) => r.some((c) => clean(c)));
}

function loadCsvRows() {
  const resolved = path.resolve(CSV_PATH);

  if (!fs.existsSync(resolved)) {
    throw new Error(`CSV not found: ${resolved}`);
  }

  const text = fs.readFileSync(resolved, "utf8");
  const rows = parseCsv(text);
  const headers = rows[0].map((h) => clean(h).replace(/^\uFEFF/, ""));

  return rows.slice(1).map((values) => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = clean(values[index]);
    });

    return item;
  });
}

function buildAddress(row) {
  const address = {
    address1: clean(row.billing_address_1),
    city: clean(row.billing_city),
    zip: clean(row.billing_postcode),
    countryCode: countryCode(row.billing_country),
  };

  Object.keys(address).forEach((key) => {
    if (!address[key]) delete address[key];
  });

  return address;
}

function buildCompanyName(customer, row) {
  return (
    clean(row.billing_company) ||
    clean(customer.displayName) ||
    clean(customer.email)
  );
}

async function getCustomerByEmail(email) {
  const data = await graphql(
    `query GetCustomer($query: String!) {
      customers(first: 1, query: $query) {
        nodes {
          id
          email
          displayName
          companyContactProfiles {
            id
            company {
              id
              name
              contactRoles(first: 10) {
                nodes {
                  id
                  name
                }
              }
              locations(first: 10) {
                nodes {
                  id
                  name
                  taxSettings {
                    taxRegistrationId
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { query: `email:${email}` }
  );

  return data.customers.nodes[0] || null;
}

async function createCompany(companyName, address) {
  const data = await graphql(
    `mutation CompanyCreate($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          contactRoles(first: 10) {
            nodes {
              id
              name
            }
          }
          locations(first: 10) {
            nodes {
              id
              name
              taxSettings {
                taxRegistrationId
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      input: {
        company: {
          name: companyName,
        },
        companyLocation: {
          name: companyName,
          shippingAddress: address,
          billingAddress: address,
        },
      },
    }
  );

  const errors = data.companyCreate.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return data.companyCreate.company;
}

async function assignCustomer(companyId, customerId) {
  const data = await graphql(
    `mutation AssignCustomer($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { companyId, customerId }
  );

  const errors = data.companyAssignCustomerAsContact.userErrors || [];

  if (errors.length) {
    const alreadyExists = errors.some((e) =>
      String(e.message || "").toLowerCase().includes("already")
    );

    if (alreadyExists) return null;

    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return data.companyAssignCustomerAsContact.companyContact;
}

async function assignRoleToContact(companyContactId, companyLocationId, companyContactRoleId) {
  const data = await graphql(
    `mutation AssignRole(
      $companyContactId: ID!
      $companyLocationId: ID!
      $companyContactRoleId: ID!
    ) {
      companyContactAssignRole(
        companyContactId: $companyContactId
        companyLocationId: $companyLocationId
        companyContactRoleId: $companyContactRoleId
      ) {
        userErrors {
          field
          message
        }
      }
    }`,
    {
      companyContactId,
      companyLocationId,
      companyContactRoleId,
    }
  );

  const errors = data.companyContactAssignRole.userErrors || [];

  if (errors.length) {
    const alreadyExists = errors.some((e) =>
      String(e.message || "").toLowerCase().includes("already")
    );

    if (alreadyExists) return true;

    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return true;
}

async function updateVat(locationId, vatId) {
  if (!vatId) return null;

  const data = await graphql(
    `mutation UpdateVat($companyLocationId: ID!, $taxRegistrationId: String) {
      companyLocationTaxSettingsUpdate(
        companyLocationId: $companyLocationId
        taxRegistrationId: $taxRegistrationId
      ) {
        userErrors {
          field
          message
        }
      }
    }`,
    {
      companyLocationId: locationId,
      taxRegistrationId: vatId,
    }
  );

  const errors = data.companyLocationTaxSettingsUpdate.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return true;
}

async function approveLocation(locationId) {
  const data = await graphql(
    `mutation CompanyLocationUpdate($companyLocationId: ID!, $input: CompanyLocationUpdateInput!) {
      companyLocationUpdate(companyLocationId: $companyLocationId, input: $input) {
        companyLocation {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      companyLocationId: locationId,
      input: {
        buyerExperienceConfiguration: {
          checkoutToDraft: false,
          editableShippingAddress: true,
        },
      },
    }
  );

  const errors = data.companyLocationUpdate.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(" "));
  }

  return true;
}

function pickRole(company) {
  const roles = company.contactRoles?.nodes || [];

  return (
    roles.find((role) =>
      String(role.name || "").toLowerCase().includes("admin")
    ) ||
    roles.find((role) =>
      String(role.name || "").toLowerCase().includes("ordering")
    ) ||
    roles[0]
  );
}

function firstLocation(company) {
  return company.locations?.nodes?.[0] || null;
}

function existingContactProfile(customer) {
  return customer.companyContactProfiles?.[0] || null;
}

async function processExistingCompany(customer, row, vatId) {
  const profile = existingContactProfile(customer);

  if (!profile?.id || !profile?.company?.id) {
    throw new Error(`Existing company profile invalid for customer ${customer.id}`);
  }

  const company = profile.company;
  const location = firstLocation(company);
  const role = pickRole(company);

  if (!location?.id) {
    throw new Error(`Existing company has no location: ${company.id}`);
  }

  if (!role?.id) {
    throw new Error(`Existing company has no contact role: ${company.id}`);
  }

  await assignRoleToContact(profile.id, location.id, role.id);

  if (vatId && !location.taxSettings?.taxRegistrationId) {
    await updateVat(location.id, vatId);
  }

  await approveLocation(location.id);

  return company;
}

async function processNewCompany(customer, row, vatId) {
  const companyName = buildCompanyName(customer, row);
  const address = buildAddress(row);

  const company = await createCompany(companyName, address);
  const location = firstLocation(company);
  const role = pickRole(company);

  if (!location?.id) {
    throw new Error(`Company created but location not found: ${company.id}`);
  }

  if (!role?.id) {
    throw new Error(`Company created but no contact role found: ${company.id}`);
  }

  const contact = await assignCustomer(company.id, customer.id);

  if (!contact?.id) {
    throw new Error(`Company created but contact assignment returned empty: ${company.id}`);
  }

  await assignRoleToContact(contact.id, location.id, role.id);

  if (vatId) {
    await updateVat(location.id, vatId);
  }

  await approveLocation(location.id);

  return company;
}

async function main() {
  console.log(`Shop: ${SHOP}`);
  console.log(`API version: ${API_VERSION}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
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
  let created = 0;
  let fixedExisting = 0;
  let withoutVat = 0;
  let skippedNoCustomer = 0;
  let skippedNoCompanyName = 0;
  let failed = 0;

  for (const [email, row] of byEmail.entries()) {
    total += 1;

    try {
      const customer = await getCustomerByEmail(email);

      if (!customer) {
        skippedNoCustomer += 1;
        console.log(`NO CUSTOMER: ${email}`);
        continue;
      }

      const companyName = buildCompanyName(customer, row);

      if (!companyName) {
        skippedNoCompanyName += 1;
        console.log(`NO COMPANY NAME: ${email}`);
        continue;
      }

      const vatId = normalizeVat(
        row.b2bking_custom_field_72270,
        row.billing_country
      );

      const hasCompany = !!existingContactProfile(customer);

      console.log("");
      console.log(`${hasCompany ? "FIX EXISTING COMPANY" : "CREATE COMPANY"}: ${email}`);
      console.log(`Company: ${companyName}`);
      console.log(`VAT: ${vatId || "MISSING"}`);

      if (!DRY_RUN) {
        if (hasCompany) {
          const company = await processExistingCompany(customer, row, vatId);
          console.log(`FIXED EXISTING: ${company.name}`);
          fixedExisting += 1;
        } else {
          const company = await processNewCompany(customer, row, vatId);
          console.log(`CREATED: ${company.name}`);
          created += 1;
        }
      } else {
        if (hasCompany) fixedExisting += 1;
        else created += 1;
      }

      if (!vatId) {
        withoutVat += 1;
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
    created,
    fixedExisting,
    withoutVat,
    skippedNoCustomer,
    skippedNoCompanyName,
    failed,
    dryRun: DRY_RUN,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});