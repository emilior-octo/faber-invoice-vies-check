import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import soap from "soap";

const STORE_COUNTRY_CODE = (process.env.STORE_COUNTRY_CODE || "IT").toUpperCase();
const ENABLE_VIES_CHECK = (process.env.ENABLE_VIES_CHECK || "true") === "true";
const VIES_WSDL = "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";
const EU_REVERSE_CHARGE_EXEMPTION = "EU_REVERSE_CHARGE_EXEMPTION_RULE";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
  "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

function responseJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clean(value) {
  return String(value || "").trim();
}

function cleanUpper(value) {
  return clean(value).toUpperCase();
}

function cleanEmailLike(value) {
  return clean(value).toLowerCase();
}

function normalizeVat(countryCode, vatNumber) {
  const country = cleanUpper(countryCode);
  let vat = cleanUpper(vatNumber).replace(/[\s.\-_/]/g, "");

  if (country && vat.startsWith(country)) {
    vat = vat.slice(country.length);
  }

  if (country === "AT" && /^\d{8}$/.test(vat)) {
    vat = `U${vat}`;
  }

  return { countryCode: country, vatNumber: vat };
}

function normalizeFullVat(value) {
  return cleanUpper(value).replace(/[\s.\-_/]/g, "");
}

function classifyViesSoapError(error) {
  const message = String(error?.message || error || "");
  const raw = JSON.stringify(error || {});
  const combined = `${message} ${raw}`.toUpperCase();

  if (combined.includes("MS_MAX_CONCURRENT_REQ")) return "MS_MAX_CONCURRENT_REQ";
  if (combined.includes("MS_UNAVAILABLE")) return "MS_UNAVAILABLE";
  if (combined.includes("SERVICE_UNAVAILABLE")) return "SERVICE_UNAVAILABLE";
  if (combined.includes("TIMEOUT") || combined.includes("ETIMEDOUT") || combined.includes("ECONNRESET")) return "TIMEOUT";
  if (combined.includes("INVALID_INPUT")) return "INVALID_INPUT";

  return "VIES_TECHNICAL_ERROR";
}

function localeFrom(value) {
  return clean(value).toLowerCase().startsWith("it") ? "it" : "en";
}

function messages(locale) {
  const isIt = localeFrom(locale) === "it";

  return {
    invalidType: isIt ? "Tipo fattura non valido." : "Invalid invoice type.",
    requiredVat: isIt
      ? "Paese e partita IVA sono obbligatori."
      : "Country and VAT number are required.",
    viesUnavailable: () =>
      isIt
        ? "VIES momentaneamente occupato. Richiesta fattura registrata: completa il checkout e, se ti serve reverse charge, contatta l’assistenza."
        : "VIES is temporarily busy. Your invoice request was saved: complete checkout and contact support if you need reverse charge.",
    invalidVat: (fullVatNumber) =>
      isIt
        ? `VAT non validato (${fullVatNumber}). Richiesta fattura registrata: completa il checkout e contatta l’assistenza se serve verifica.`
        : `VAT could not be validated (${fullVatNumber}). Your invoice request was saved: complete checkout and contact support if you need verification.`,
    reverseChargeSaved: isIt
      ? "Reverse charge validato. La richiesta fattura è stata salvata."
      : "Reverse charge validated. Your invoice request has been saved.",
    taxExemptPrepared: isIt
      ? "Reverse charge validato e profilo cliente preparato per esenzione IVA. Usa la stessa email al checkout."
      : "Reverse charge validated and customer profile prepared for VAT exemption. Use the same email at checkout.",
    loggedTaxExemptApplied: isIt
      ? "Reverse charge validato e profilo cliente aggiornato per esenzione IVA."
      : "Reverse charge validated and customer profile updated for VAT exemption.",
  };
}

function viesUnavailableMessage(countryCode, fullVatNumber, locale = "it") {
  return messages(locale).viesUnavailable(countryCode, fullVatNumber);
}

function toCustomerGid(customerId) {
  const raw = clean(customerId);
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const formData = await request.formData();
  return Object.fromEntries(formData.entries());
}

async function checkVies(countryCode, vatNumber) {
  const normalized = normalizeVat(countryCode, vatNumber);

  if (!normalized.countryCode || !normalized.vatNumber) {
    throw new Error("Paese e partita IVA sono obbligatori.");
  }

  console.log("[Invoice Request] VIES SOAP request", {
    countryCode: normalized.countryCode,
    vatNumber: normalized.vatNumber,
  });

  try {
    const client = await soap.createClientAsync(VIES_WSDL);
    const [result] = await client.checkVatAsync({
      countryCode: normalized.countryCode,
      vatNumber: normalized.vatNumber,
    });

    const response = {
      valid: result?.valid === true || String(result?.valid).toLowerCase() === "true",
      unavailable: false,
      countryCode: normalized.countryCode,
      vatNumber: normalized.vatNumber,
      fullVatNumber: `${normalized.countryCode}${normalized.vatNumber}`,
      requestDate: result?.requestDate || "",
      name: result?.name || "",
      address: result?.address || "",
      raw: result || null,
    };

    console.log("[Invoice Request] VIES SOAP response", response);

    return response;
  } catch (error) {
    const errorCode = classifyViesSoapError(error);
    const response = {
      valid: null,
      unavailable: true,
      errorCode,
      errorMessage: error?.message || String(error || ""),
      countryCode: normalized.countryCode,
      vatNumber: normalized.vatNumber,
      fullVatNumber: `${normalized.countryCode}${normalized.vatNumber}`,
      raw: null,
    };

    console.error("[Invoice Request] VIES SOAP unavailable", response);

    return response;
  }
}

async function graphQL(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function setCustomerMetafields(admin, customerGid, fields) {
  if (!customerGid) return;

  const metafields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({
      ownerId: customerGid,
      namespace: "custom",
      key,
      type: "single_line_text_field",
      value: String(value),
    }));

  if (!metafields.length) return;

  const mutation = `#graphql
    mutation SetCustomerInvoiceMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, { metafields });
  const errors = data?.data?.metafieldsSet?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }
}


async function findCustomerByEmail(admin, email) {
  const cleanEmail = cleanEmailLike(email);
  if (!cleanEmail) return null;

  const query = `#graphql
    query FindInvoiceCustomerByEmail($query: String!) {
      customers(first: 10, query: $query) {
        nodes {
          id
          email
          firstName
          lastName
          taxExempt
          taxExemptions
        }
      }
    }
  `;

  const data = await graphQL(admin, query, { query: `email:${cleanEmail}` });
  const candidates = data?.data?.customers?.nodes || [];
  const exact = candidates.filter(
    (customer) => cleanEmailLike(customer?.email) === cleanEmail,
  );

  if (exact.length > 1) {
    throw new Error(`Più clienti Shopify hanno la stessa email ${cleanEmail}. Associazione automatica interrotta.`);
  }

  const customer = exact[0] || null;

  console.log("[Invoice Request] exact customer lookup by email", {
    email: cleanEmail,
    found: Boolean(customer?.id),
    customerId: customer?.id || "",
    candidateCount: candidates.length,
    exactCount: exact.length,
  });

  return customer;
}

async function createCustomerForInvoice(admin, email, companyName, firstName = "", lastName = "") {
  const cleanEmail = cleanEmailLike(email);
  if (!cleanEmail) return null;

  const mutation = `#graphql
    mutation CreateInvoiceCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          taxExempt
          taxExemptions
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    input: {
      email: cleanEmail,
      ...(clean(firstName) ? { firstName: clean(firstName) } : {}),
      ...(clean(lastName) ? { lastName: clean(lastName) } : {}),
      note: companyName
        ? `Invoice request reverse charge - ${companyName}`
        : "Invoice request reverse charge",
    },
  });

  const errors = data?.data?.customerCreate?.userErrors || [];
  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    console.error("[Invoice Request] customerCreate failed", {
      email: cleanEmail,
      errors,
    });
    throw new Error(message);
  }

  const customer = data?.data?.customerCreate?.customer || null;

  console.log("[Invoice Request] customer created for invoice", {
    email: cleanEmail,
    customerId: customer?.id || "",
  });

  return customer;
}

async function findOrCreateCustomerByEmail(admin, email, companyName, firstName = "", lastName = "") {
  const existing = await findCustomerByEmail(admin, email);
  if (existing?.id) return existing;
  return createCustomerForInvoice(admin, email, companyName, firstName, lastName);
}

function normalizeVatForCompany(value) {
  return cleanUpper(value).replace(/[\s.\-_/]/g, "");
}

function temporaryCompanyName(vatNumber) {
  const vat = normalizeVatForCompany(vatNumber);
  return vat ? `invoice-${vat}` : "Invoice company";
}


async function findCompaniesByExactVat(admin, vatNumber) {
  const wantedVat = normalizeVatForCompany(vatNumber);
  if (!wantedVat) return [];

  const wantedExternalId = `invoice-${wantedVat}`;
  const matchesById = new Map();
  let after = null;
  let page = 0;

  const query = `#graphql
    query InvoiceCompaniesForExactVat($after: String) {
      companies(first: 250, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          name
          externalId
          defaultRole { id name }
          contactRoles(first: 20) {
            nodes { id name }
          }
          locations(first: 50) {
            nodes {
              id
              name
              taxSettings {
                taxRegistrationId
                taxExempt
                taxExemptions
              }
            }
          }
        }
      }
    }
  `;

  do {
    page += 1;
    const data = await graphQL(admin, query, { after });
    const connection = data?.data?.companies;
    const companies = connection?.nodes || [];

    for (const company of companies) {
      const locations = company?.locations?.nodes || [];
      const nativeExactLocations = locations.filter(
        (location) =>
          normalizeVatForCompany(location?.taxSettings?.taxRegistrationId) === wantedVat,
      );
      const externalExact = clean(company?.externalId) === wantedExternalId;

      if (nativeExactLocations.length || externalExact) {
        matchesById.set(company.id, {
          company,
          locations,
          nativeExactLocations,
          externalExact,
        });
      }
    }

    after = connection?.pageInfo?.hasNextPage
      ? connection?.pageInfo?.endCursor
      : null;
  } while (after && page < 20);

  const matches = [...matchesById.values()];

  console.log("[Invoice Request] exact VAT Company lookup", {
    vatNumber: wantedVat,
    matches: matches.map((match) => ({
      companyId: match.company?.id,
      companyName: match.company?.name,
      externalId: match.company?.externalId,
      nativeExactLocationIds: match.nativeExactLocations.map((location) => location.id),
      externalExact: match.externalExact,
      locationCount: match.locations.length,
    })),
  });

  return matches;
}

async function createPreCheckoutCompany(admin, {
  vatNumber,
  companyName,
}) {
  const vat = normalizeVatForCompany(vatNumber);
  if (!vat) throw new Error("VAT mancante durante la preparazione Company B2B");

  const resolvedName = clean(companyName) || temporaryCompanyName(vat);
  const externalId = `invoice-${vat}`;

  const mutation = `#graphql
    mutation CreateInvoicePreCheckoutCompany($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          externalId
          defaultRole { id name }
          contactRoles(first: 20) {
            nodes { id name }
          }
          locations(first: 20) {
            nodes {
              id
              name
              taxSettings {
                taxRegistrationId
                taxExempt
                taxExemptions
              }
            }
          }
        }
        userErrors { field message code }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    input: {
      company: {
        name: resolvedName,
        externalId,
      },
      companyLocation: {
        name: resolvedName,
      },
    },
  });

  const errors = data?.data?.companyCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }

  const company = data?.data?.companyCreate?.company || null;
  if (!company?.id) throw new Error("Creazione Company B2B non riuscita");

  return company;
}

async function createPreCheckoutCompanyLocation(admin, companyId, companyName, vatNumber) {
  if (!companyId) throw new Error("Company ID mancante per creazione sede");

  const resolvedName = clean(companyName) || temporaryCompanyName(vatNumber);

  const mutation = `#graphql
    mutation CreateInvoiceCompanyLocation($companyId: ID!, $input: CompanyLocationInput!) {
      companyLocationCreate(companyId: $companyId, input: $input) {
        companyLocation {
          id
          name
          taxSettings {
            taxRegistrationId
            taxExempt
            taxExemptions
          }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    companyId,
    input: {
      name: resolvedName,
    },
  });

  const errors = data?.data?.companyLocationCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }

  const location = data?.data?.companyLocationCreate?.companyLocation || null;
  if (!location?.id) throw new Error("Creazione Company Location non riuscita");

  return location;
}

async function getCustomerCompanyContactProfiles(admin, customerGid) {
  if (!customerGid) return [];

  const query = `#graphql
    query InvoiceCustomerCompanyContactProfiles($customerId: ID!) {
      customer(id: $customerId) {
        id
        companyContactProfiles {
          id
          company {
            id
            name
          }
          roleAssignments(first: 100) {
            nodes {
              id
              companyLocation { id }
              role { id name }
            }
          }
        }
      }
    }
  `;

  const data = await graphQL(admin, query, { customerId: customerGid });
  return data?.data?.customer?.companyContactProfiles || [];
}

async function getCompanyContactForCustomer(admin, companyId, customerGid) {
  if (!companyId || !customerGid) return null;

  const profiles = await getCustomerCompanyContactProfiles(admin, customerGid);
  const matches = profiles.filter((profile) => profile?.company?.id === companyId);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.warn("[Invoice Request] multiple CompanyContact profiles for same Company", {
      customerGid,
      companyId,
      companyContactIds: matches.map((profile) => profile.id),
    });
  }

  return matches[0] || null;
}

async function assignCustomerToPreCheckoutCompany(admin, companyId, customerGid) {
  const profilesBefore = await getCustomerCompanyContactProfiles(admin, customerGid);
  const targetProfilesBefore = profilesBefore.filter(
    (profile) => profile?.company?.id === companyId,
  );

  if (targetProfilesBefore.length === 1) {
    return {
      companyContact: targetProfilesBefore[0],
      created: false,
      alreadyAssociated: true,
      ambiguous: false,
    };
  }

  if (targetProfilesBefore.length > 1) {
    return {
      companyContact: null,
      created: false,
      alreadyAssociated: true,
      ambiguous: true,
      warning: `Più CompanyContact trovati per Customer ${customerGid} e Company ${companyId}.`,
    };
  }

  const mutation = `#graphql
    mutation AssignInvoicePreCheckoutCustomer($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact {
          id
          customer { id }
          company { id name }
          roleAssignments(first: 100) {
            nodes {
              id
              companyLocation { id }
              role { id name }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    companyId,
    customerId: customerGid,
  });

  const errors = data?.data?.companyAssignCustomerAsContact?.userErrors || [];
  if (!errors.length) {
    return {
      companyContact: data?.data?.companyAssignCustomerAsContact?.companyContact || null,
      created: true,
      alreadyAssociated: false,
      ambiguous: false,
    };
  }

  const message = errors.map((error) => error.message).join(" | ");

  // Shopify can answer "already associated" even when our Company-side lookup did not
  // expose the contact. Re-read the Customer globally before deciding this needs manual sync.
  if (/already|associated|contact/i.test(message)) {
    const profilesAfter = await getCustomerCompanyContactProfiles(admin, customerGid);
    const targetProfilesAfter = profilesAfter.filter(
      (profile) => profile?.company?.id === companyId,
    );

    if (targetProfilesAfter.length === 1) {
      return {
        companyContact: targetProfilesAfter[0],
        created: false,
        alreadyAssociated: true,
        ambiguous: false,
      };
    }

    return {
      companyContact: null,
      created: false,
      alreadyAssociated: profilesAfter.length > 0,
      ambiguous: targetProfilesAfter.length > 1,
      warning: message,
      otherCompanyIds: profilesAfter
        .map((profile) => profile?.company?.id)
        .filter(Boolean),
    };
  }

  throw new Error(message);
}

function findOrderingRole(company) {
  const roles = company?.contactRoles?.nodes || [];
  const orderingRole = roles.find((role) => {
    const name = clean(role?.name).toLowerCase();
    return name === "buyer" || name === "ordering only" || name.includes("ordering");
  });

  if (orderingRole?.id) return orderingRole;

  const defaultName = clean(company?.defaultRole?.name).toLowerCase();
  if (
    company?.defaultRole?.id &&
    (defaultName === "buyer" ||
      defaultName === "ordering only" ||
      defaultName.includes("ordering"))
  ) {
    return company.defaultRole;
  }

  return null;
}

function hasPurchasingPermission(companyContact, locationId) {
  return (companyContact?.roleAssignments?.nodes || []).some((assignment) => {
    if (assignment?.companyLocation?.id !== locationId) return false;

    const roleName = clean(assignment?.role?.name).toLowerCase();

    return (
      roleName === "buyer" ||
      roleName === "ordering only" ||
      roleName.includes("ordering") ||
      roleName.includes("location admin") ||
      roleName === "admin"
    );
  });
}

async function assignPreCheckoutOrderingRole(admin, company, companyContact, locationId) {
  if (!company?.id || !companyContact?.id || !locationId) {
    throw new Error("Company/Contact/Location mancanti durante autorizzazione B2B");
  }

  if (hasPurchasingPermission(companyContact, locationId)) {
    return {
      assigned: false,
      alreadyAllowed: true,
    };
  }

  const orderingRole = findOrderingRole(company);
  if (!orderingRole?.id) {
    throw new Error(`Ruolo Ordering only non trovato per Company ${company.id}`);
  }

  const mutation = `#graphql
    mutation AssignInvoicePreCheckoutOrderingRole(
      $companyContactId: ID!,
      $companyContactRoleId: ID!,
      $companyLocationId: ID!
    ) {
      companyContactAssignRole(
        companyContactId: $companyContactId,
        companyContactRoleId: $companyContactRoleId,
        companyLocationId: $companyLocationId
      ) {
        companyContactRoleAssignment { id }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    companyContactId: companyContact.id,
    companyContactRoleId: orderingRole.id,
    companyLocationId: locationId,
  });

  const errors = data?.data?.companyContactAssignRole?.userErrors || [];
  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");

    if (/already|assigned/i.test(message)) {
      return {
        assigned: false,
        alreadyAllowed: true,
      };
    }

    throw new Error(message);
  }

  return {
    assigned: true,
    alreadyAllowed: false,
  };
}

async function applyPreCheckoutCompanyTaxSettings(admin, {
  locationId,
  vatNumber,
  reverseCharge = false,
}) {
  if (!locationId) throw new Error("Company Location mancante per i dati fiscali");

  const taxRegistrationId = normalizeVatForCompany(vatNumber);
  if (!taxRegistrationId) throw new Error("VAT mancante per i dati fiscali Company");

  if (!reverseCharge) {
    const mutation = `#graphql
      mutation PrepareInvoiceCompanyTaxRegistration(
        $companyLocationId: ID!,
        $taxRegistrationId: String!
      ) {
        companyLocationTaxSettingsUpdate(
          companyLocationId: $companyLocationId,
          taxRegistrationId: $taxRegistrationId
        ) {
          companyLocation {
            id
            taxSettings {
              taxRegistrationId
              taxExempt
              taxExemptions
            }
          }
          userErrors { field message }
        }
      }
    `;

    const data = await graphQL(admin, mutation, {
      companyLocationId: locationId,
      taxRegistrationId,
    });

    const errors = data?.data?.companyLocationTaxSettingsUpdate?.userErrors || [];
    if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));

    return;
  }

  const mutation = `#graphql
    mutation PrepareInvoiceCompanyReverseCharge(
      $companyLocationId: ID!,
      $taxRegistrationId: String!,
      $taxExempt: Boolean!,
      $exemptionsToAssign: [TaxExemption!]
    ) {
      companyLocationTaxSettingsUpdate(
        companyLocationId: $companyLocationId,
        taxRegistrationId: $taxRegistrationId,
        taxExempt: $taxExempt,
        exemptionsToAssign: $exemptionsToAssign
      ) {
        companyLocation {
          id
          taxSettings {
            taxRegistrationId
            taxExempt
            taxExemptions
          }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    companyLocationId: locationId,
    taxRegistrationId,
    taxExempt: true,
    exemptionsToAssign: [EU_REVERSE_CHARGE_EXEMPTION],
  });

  const errors = data?.data?.companyLocationTaxSettingsUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));
}

async function setCompanyInvoiceMetafields(admin, {
  companyId,
  locationId,
  vatNumber,
  pec,
  sdi,
  companyName,
}) {
  const metafields = [];

  const push = (ownerId, key, value) => {
    if (!ownerId || !clean(value)) return;
    metafields.push({
      ownerId,
      namespace: "custom",
      key,
      type: "single_line_text_field",
      value: String(value),
    });
  };

  push(companyId, "vat_number", normalizeVatForCompany(vatNumber));
  push(companyId, "pec", cleanEmailLike(pec));
  push(companyId, "sdi", cleanUpper(sdi));
  push(companyId, "invoice_company_name", clean(companyName));

  push(locationId, "vat_number", normalizeVatForCompany(vatNumber));
  push(locationId, "pec", cleanEmailLike(pec));
  push(locationId, "sdi", cleanUpper(sdi));

  if (!metafields.length) return;

  const mutation = `#graphql
    mutation SetInvoiceCompanyMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, { metafields });
  const errors = data?.data?.metafieldsSet?.userErrors || [];

  if (errors.length) {
    console.warn("[Invoice Request] Company fiscal metafields warning", { errors });
  }
}

function emptyCompanyPreflight(overrides = {}) {
  return {
    state: "not_started",
    vatMatch: "",
    companyId: "",
    companyLocationId: "",
    companyContactId: "",
    companyCreated: false,
    locationCreated: false,
    contactCreated: false,
    orderingRoleAssigned: false,
    purchasePermissionReady: false,
    requiresB2BContextRefresh: false,
    syncRequired: false,
    syncReason: "",
    warnings: [],
    ...overrides,
  };
}

function manualCompanyPreflight(state, reason, overrides = {}) {
  const warningList = [
    ...(Array.isArray(overrides.warnings) ? overrides.warnings : []),
    reason,
  ].filter(Boolean);

  const result = emptyCompanyPreflight({
    ...overrides,
    state,
    syncRequired: true,
    syncReason: reason,
    warnings: warningList,
    // IMPORTANT: manual-sync edge cases must not force the storefront into a
    // half-prepared B2B purchasing context. Checkout can continue as D2C and
    // the invoice request remains available for later reconciliation.
    requiresB2BContextRefresh: false,
  });

  console.warn("[Invoice Request] B2B preflight deferred to manual sync", result);
  return result;
}

async function ensurePreCheckoutInvoiceCompany(admin, {
  customerGid,
  vatNumber,
  companyName,
  pec,
  sdi,
}) {
  const wantedVat = normalizeVatForCompany(vatNumber);
  let state = emptyCompanyPreflight();

  if (!customerGid) {
    return manualCompanyPreflight(
      "customer_missing",
      "Cliente Shopify non disponibile per la preparazione B2B.",
      { vatMatch: wantedVat ? "unresolved" : "" },
    );
  }

  if (!wantedVat) {
    return manualCompanyPreflight(
      "vat_missing",
      "VAT non disponibile per la preparazione B2B.",
    );
  }

  let exactMatches;
  try {
    exactMatches = await findCompaniesByExactVat(admin, wantedVat);
  } catch (error) {
    return manualCompanyPreflight(
      "company_lookup_failed",
      `Ricerca Company per VAT non riuscita: ${error?.message || error}`,
    );
  }

  if (exactMatches.length > 1) {
    return manualCompanyPreflight(
      "company_ambiguous",
      `Trovate ${exactMatches.length} Company con VAT ${wantedVat}; nessuna associazione automatica.`,
      {
        vatMatch: "ambiguous",
        warnings: exactMatches.map(
          (match) => `Candidate Company: ${match.company?.id || "?"}`,
        ),
      },
    );
  }

  let company = null;
  let location = null;

  if (exactMatches.length === 0) {
    try {
      company = await createPreCheckoutCompany(admin, {
        vatNumber: wantedVat,
        companyName,
      });

      state.companyCreated = true;
      state.vatMatch = "created";
      location = company?.locations?.nodes?.[0] || null;

      if (!location?.id) {
        location = await createPreCheckoutCompanyLocation(
          admin,
          company.id,
          companyName,
          wantedVat,
        );
        state.locationCreated = true;
      }
    } catch (error) {
      return manualCompanyPreflight(
        "company_create_failed",
        `Creazione Company/sede non riuscita: ${error?.message || error}`,
        {
          vatMatch: "create_failed",
          companyId: company?.id || "",
          companyCreated: Boolean(state.companyCreated),
        },
      );
    }
  } else {
    const match = exactMatches[0];
    company = match.company;

    if (match.nativeExactLocations.length > 1) {
      return manualCompanyPreflight(
        "location_ambiguous",
        `Più sedi della stessa Company hanno VAT ${wantedVat}; scelta automatica evitata.`,
        {
          vatMatch: "ambiguous",
          companyId: company?.id || "",
          warnings: match.nativeExactLocations.map(
            (candidate) => `Candidate Location: ${candidate.id}`,
          ),
        },
      );
    }

    if (match.nativeExactLocations.length === 1) {
      location = match.nativeExactLocations[0];
      state.vatMatch = "native_exact";
    } else if (match.externalExact) {
      state.vatMatch = "legacy_external_id";

      if (match.locations.length === 0) {
        try {
          location = await createPreCheckoutCompanyLocation(
            admin,
            company.id,
            companyName || company.name,
            wantedVat,
          );
          state.locationCreated = true;
        } catch (error) {
          return manualCompanyPreflight(
            "location_create_failed",
            `Company legacy trovata, ma creazione sede non riuscita: ${error?.message || error}`,
            {
              companyId: company?.id || "",
              vatMatch: state.vatMatch,
            },
          );
        }
      } else if (match.locations.length === 1) {
        location = match.locations[0];

        const existingNativeVat = normalizeVatForCompany(
          location?.taxSettings?.taxRegistrationId,
        );

        if (existingNativeVat && existingNativeVat !== wantedVat) {
          return manualCompanyPreflight(
            "vat_conflict",
            `Conflitto VAT: externalId indica ${wantedVat}, ma la sede Shopify contiene ${existingNativeVat}.`,
            {
              companyId: company?.id || "",
              companyLocationId: location?.id || "",
              vatMatch: "conflict",
            },
          );
        }
      } else {
        return manualCompanyPreflight(
          "legacy_location_ambiguous",
          `Company legacy ${company?.id || ""} ha più sedi e nessuna con VAT nativo esatto ${wantedVat}.`,
          {
            companyId: company?.id || "",
            vatMatch: state.vatMatch,
          },
        );
      }
    }
  }

  if (!company?.id) {
    return manualCompanyPreflight(
      "company_unresolved",
      "Company non risolta dopo il matching VAT.",
      { vatMatch: state.vatMatch || "unresolved" },
    );
  }

  if (!location?.id) {
    return manualCompanyPreflight(
      "location_unresolved",
      "Company trovata ma sede B2B non risolta.",
      {
        companyId: company.id,
        vatMatch: state.vatMatch || "unresolved",
      },
    );
  }

  state.companyId = company.id;
  state.companyLocationId = location.id;

  // VAT native + fiscal metadata are useful even if a later contact/role step
  // needs manual reconciliation. Failure here is recorded, but never blocks checkout.
  try {
    const existingNativeVat = normalizeVatForCompany(
      location?.taxSettings?.taxRegistrationId,
    );

    if (!existingNativeVat || existingNativeVat === wantedVat) {
      await applyPreCheckoutCompanyTaxSettings(admin, {
        locationId: location.id,
        vatNumber: wantedVat,
        reverseCharge: false,
      });
    } else {
      state.syncRequired = true;
      state.syncReason =
        `VAT sede ${existingNativeVat} diverso dal VAT richiesto ${wantedVat}.`;
      state.warnings.push(state.syncReason);
    }
  } catch (error) {
    state.syncRequired = true;
    state.syncReason =
      state.syncReason ||
      `Scrittura VAT nativo non riuscita: ${error?.message || error}`;
    state.warnings.push(`Tax settings: ${error?.message || error}`);
  }

  try {
    await setCompanyInvoiceMetafields(admin, {
      companyId: company.id,
      locationId: location.id,
      vatNumber: wantedVat,
      pec,
      sdi,
      companyName,
    });
  } catch (error) {
    state.syncRequired = true;
    state.syncReason =
      state.syncReason ||
      `Salvataggio dati fiscali Company non riuscito: ${error?.message || error}`;
    state.warnings.push(`Fiscal metafields: ${error?.message || error}`);
  }

  let contactResult;
  try {
    contactResult = await assignCustomerToPreCheckoutCompany(
      admin,
      company.id,
      customerGid,
    );
  } catch (error) {
    return manualCompanyPreflight(
      "contact_assign_failed",
      `Associazione Customer → Company non riuscita: ${error?.message || error}`,
      {
        ...state,
        companyId: company.id,
        companyLocationId: location.id,
      },
    );
  }

  if (contactResult?.ambiguous) {
    return manualCompanyPreflight(
      "contact_ambiguous",
      contactResult.warning ||
        "Più CompanyContact compatibili trovati; associazione automatica evitata.",
      {
        ...state,
        companyId: company.id,
        companyLocationId: location.id,
      },
    );
  }

  const companyContact = contactResult?.companyContact;

  if (!companyContact?.id) {
    return manualCompanyPreflight(
      "contact_unresolved",
      contactResult?.warning ||
        "Customer già associato a un altro CompanyContact e contatto target non risolvibile automaticamente.",
      {
        ...state,
        companyId: company.id,
        companyLocationId: location.id,
        warnings: [
          ...state.warnings,
          ...(contactResult?.otherCompanyIds || []).map(
            (id) => `Customer already linked to Company ${id}`,
          ),
        ],
      },
    );
  }

  state.companyContactId = companyContact.id;
  state.contactCreated = Boolean(contactResult.created);

  try {
    const roleResult = await assignPreCheckoutOrderingRole(
      admin,
      company,
      companyContact,
      location.id,
    );

    state.orderingRoleAssigned = Boolean(roleResult?.assigned);
    state.purchasePermissionReady =
      Boolean(roleResult?.alreadyAllowed) ||
      Boolean(roleResult?.assigned);
  } catch (error) {
    return manualCompanyPreflight(
      "purchase_permission_failed",
      `Permesso di acquisto sulla sede non confermato: ${error?.message || error}`,
      {
        ...state,
        companyId: company.id,
        companyLocationId: location.id,
        companyContactId: companyContact.id,
      },
    );
  }

  state.requiresB2BContextRefresh =
    state.companyCreated ||
    state.locationCreated ||
    state.contactCreated ||
    state.orderingRoleAssigned;

  state.state = state.syncRequired ? "ready_with_warnings" : "ready";

  console.log("[Invoice Request] resilient B2B preflight complete", {
    customerGid,
    vatNumber: wantedVat,
    ...state,
  });

  return state;
}

async function applyReverseCharge(admin, customerGid) {
  if (!customerGid) {
    return {
      applied: false,
      customerTaxExempt: false,
      customerTaxExemptions: [],
      error: "Missing customer ID",
    };
  }

  const mutation = `#graphql
    mutation ApplyInvoiceReverseCharge($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer {
          id
          taxExempt
          taxExemptions
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    input: {
      id: customerGid,
      taxExempt: true,
      taxExemptions: [EU_REVERSE_CHARGE_EXEMPTION],
    },
  });

  const errors = data?.data?.customerUpdate?.userErrors || [];

  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    console.error("[Invoice Request] customerUpdate tax exemption failed", {
      customerGid,
      errors,
    });
    throw new Error(message);
  }

  const customer = data?.data?.customerUpdate?.customer;
  const customerTaxExempt = Boolean(customer?.taxExempt);
  const customerTaxExemptions = customer?.taxExemptions || [];
  const applied =
    customerTaxExempt === true &&
    customerTaxExemptions.includes(EU_REVERSE_CHARGE_EXEMPTION);

  console.log("[Invoice Request] customer tax exemption result", {
    customerGid,
    customerTaxExempt,
    customerTaxExemptions,
    applied,
  });

  return {
    applied,
    customerTaxExempt,
    customerTaxExemptions,
    error: applied ? "" : "Reverse charge exemption was not confirmed on the customer.",
  };
}

async function createOrUpdateInvoiceRequest({ shop, cartToken, data }) {
  if (cartToken) {
    const existing = await prisma.invoiceRequest.findFirst({
      where: {
        shop,
        cartToken,
        orderId: null,
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return prisma.invoiceRequest.update({
        where: { id: existing.id },
        data,
      });
    }
  }

  return prisma.invoiceRequest.create({
    data: {
      shop,
      ...data,
    },
  });
}

export async function loader() {
  return new Response("Invoice request app proxy is alive", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function action({ request }) {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session?.shop) {
    return responseJson({ ok: false, error: "App proxy unavailable" }, 401);
  }

  const url = new URL(request.url);
  const proxyCustomerId = clean(url.searchParams.get("logged_in_customer_id"));
  const body = await readJson(request);
  const locale = localeFrom(body.locale);
  const i18n = messages(locale);

  const invoiceType = clean(body.invoiceType);
  const cartToken = clean(body.cartToken);
  const checkoutToken = clean(body.checkoutToken);
  const customerId = clean(body.customerId) || proxyCustomerId;
  const customerGid = toCustomerGid(customerId);
  const customerEmail = cleanEmailLike(body.customerEmail);

  const fiscalCode = cleanUpper(body.fiscalCode);
  const pec = cleanEmailLike(body.pec);
  const sdi = cleanUpper(body.sdi);
  const companyName = clean(body.companyName);
  const firstName = clean(body.firstName);
  const lastName = clean(body.lastName);

  const normalized = normalizeVat(body.countryCode, body.vatNumber);
  const countryCode = normalized.countryCode;
  const vatNumber = normalized.vatNumber;
  const fullVatNumber = vatNumber ? `${countryCode}${vatNumber}` : "";

  if (!["private", "company"].includes(invoiceType)) {
    return responseJson({ ok: false, error: i18n.invalidType }, 400);
  }

  if (invoiceType === "company" && (!countryCode || !vatNumber)) {
    return responseJson({ ok: false, error: i18n.requiredVat }, 400);
  }

  let viesChecked = false;
  let viesValid = null;
  let viesRawResponse = null;
  let viesUnavailable = false;
  let reverseCharge = false;
  let taxExemptApplied = false;
  let taxExemptCustomerPrepared = false;
  let mustUseSameEmailAtCheckout = false;
  let requiresLoginForTaxExemption = false;
  let preparedCustomerGid = customerGid;
  let companyPreflight = null;

  const companySyncRequired = () => Boolean(companyPreflight?.syncRequired);
  const companySyncReason = () => clean(companyPreflight?.syncReason);

  try {
    // BUSINESS PRE-CHECKOUT PREPARATION:
    // Create/find the Shopify Customer and make it an authorized B2B buyer BEFORE
    // Shopify creates the order. This is what lets checkout use the Company purchasing context.
    if (invoiceType === "company") {
      try {
        if (!preparedCustomerGid && customerEmail) {
          const customerByEmail = await findOrCreateCustomerByEmail(
            admin,
            customerEmail,
            companyName,
            firstName,
            lastName,
          );

          preparedCustomerGid = customerByEmail?.id || "";
        }

        if (!preparedCustomerGid) {
          companyPreflight = manualCompanyPreflight(
            "customer_unresolved",
            "Cliente Shopify non risolto automaticamente. La richiesta fattura viene comunque registrata per la riconciliazione.",
            { vatMatch: fullVatNumber ? "unresolved" : "" },
          );
        } else {
          companyPreflight = await ensurePreCheckoutInvoiceCompany(admin, {
            customerGid: preparedCustomerGid,
            vatNumber: fullVatNumber,
            companyName,
            pec,
            sdi,
          });
        }
      } catch (error) {
        // B2B enrichment must NEVER be the reason an order cannot proceed.
        // We already know the invoice fiscal data from the form, so keep it and
        // mark the request for reconciliation after the order.
        companyPreflight = manualCompanyPreflight(
          "preflight_unexpected_error",
          `Preparazione B2B rinviata: ${error?.message || error}`,
          {
            companyId: companyPreflight?.companyId || "",
            companyLocationId: companyPreflight?.companyLocationId || "",
          },
        );
      }

      mustUseSameEmailAtCheckout = Boolean(customerEmail);
    }

    const shouldCheckVies =
      invoiceType === "company" &&
      ENABLE_VIES_CHECK &&
      EU_COUNTRIES.has(countryCode) &&
      countryCode !== STORE_COUNTRY_CODE;

    if (shouldCheckVies) {
      viesChecked = true;
      viesRawResponse = await checkVies(countryCode, vatNumber);
      viesValid = viesRawResponse?.valid === true ? true : viesRawResponse?.valid === false ? false : null;
      reverseCharge = viesValid === true;

      if (viesRawResponse?.unavailable) {
        // Business rule: never block checkout for technical VIES failures.
        // The invoice request is saved for manual review, but reverse charge/tax exempt
        // are NOT applied automatically because VIES did not confirm validity.
        viesUnavailable = true;
        viesChecked = false;
        viesValid = null;
        reverseCharge = false;
      }

      if (!viesUnavailable && viesValid !== true) {
        const errorMessage = i18n.invalidVat(fullVatNumber);
        const invoiceRequest = await createOrUpdateInvoiceRequest({
          shop: session.shop,
          cartToken,
          data: {
            cartToken,
            checkoutToken,
            customerId: preparedCustomerGid || customerGid || customerId,
            customerEmail,
            invoiceType,
            countryCode,
            fiscalCode,
            vatNumber: fullVatNumber,
            pec,
            sdi,
            companyName,
            firstName,
            lastName,
            viesChecked,
            viesValid: false,
            viesRawResponse: JSON.stringify(viesRawResponse),
            reverseCharge: false,
            taxExemptApplied: false,
            status: "pending_review",
            errorMessage,
          },
        });

        return responseJson({
          ok: true,
          invoiceRequestId: invoiceRequest.id,
          invoiceType,
          vatNumber: fullVatNumber,
          viesChecked,
          viesValid: false,
          reverseCharge: false,
          taxExemptApplied: false,
          taxExemptCustomerPrepared: false,
          pendingManualReview: true,
          reviewRequired: true,
          viesTechnicalError: false,
          companySyncRequired: companySyncRequired(),
          companySyncReason: companySyncReason(),
          companyPreflightState: companyPreflight?.state || "",
          vatMatch: companyPreflight?.vatMatch || "",
          companyContactId: companyPreflight?.companyContactId || "",
          locationCreated: Boolean(companyPreflight?.locationCreated),
          purchasePermissionReady: Boolean(companyPreflight?.purchasePermissionReady),
          companyWarnings: companyPreflight?.warnings || [],
          customerEmail,
          customerId: preparedCustomerGid || customerGid || customerId || "",
          companyPrepared: Boolean(companyPreflight?.companyId),
          companyId: companyPreflight?.companyId || "",
          companyLocationId: companyPreflight?.companyLocationId || "",
          companyContactId: companyPreflight?.companyContactId || "",
          companyCreated: Boolean(companyPreflight?.companyCreated),
          locationCreated: Boolean(companyPreflight?.locationCreated),
          contactCreated: Boolean(companyPreflight?.contactCreated),
          purchasePermissionReady: Boolean(companyPreflight?.purchasePermissionReady),
          orderingRoleAssigned: Boolean(companyPreflight?.orderingRoleAssigned),
          requiresB2BContextRefresh: Boolean(companyPreflight?.requiresB2BContextRefresh),
          message: errorMessage,
        });
      }

      if (reverseCharge && preparedCustomerGid) {
        try {
          const taxExemptResult = await applyReverseCharge(admin, preparedCustomerGid);
          taxExemptApplied = Boolean(taxExemptResult.applied);
          taxExemptCustomerPrepared = taxExemptApplied;
        } catch (error) {
          taxExemptApplied = false;
          taxExemptCustomerPrepared = false;

          companyPreflight = companyPreflight || emptyCompanyPreflight();
          companyPreflight.syncRequired = true;
          companyPreflight.syncReason =
            companyPreflight.syncReason ||
            `Reverse charge da riconciliare: ${error?.message || error}`;
          companyPreflight.warnings = [
            ...(companyPreflight.warnings || []),
            `Reverse charge customer update: ${error?.message || error}`,
          ];

          console.warn("[Invoice Request] reverse charge deferred; checkout remains allowed", {
            customerGid: preparedCustomerGid,
            error: error?.message || String(error),
          });
        }

        mustUseSameEmailAtCheckout =
          Boolean(customerEmail) || mustUseSameEmailAtCheckout;
      } else if (reverseCharge && !preparedCustomerGid) {
        requiresLoginForTaxExemption = true;

        companyPreflight = companyPreflight || emptyCompanyPreflight();
        companyPreflight.syncRequired = true;
        companyPreflight.syncReason =
          companyPreflight.syncReason ||
          "Reverse charge da riconciliare perché il Customer Shopify non è disponibile.";
      }
    }

    if (preparedCustomerGid) {
      try {
        await setCustomerMetafields(admin, preparedCustomerGid, {
          invoice_type: invoiceType,
          fiscal_code: fiscalCode,
          vat_number: fullVatNumber,
          invoice_country_code: countryCode,
          pec,
          sdi,
          company_name: companyName,
          vies_checked: String(viesChecked),
          vies_valid: viesValid === null ? "" : String(viesValid),
          reverse_charge: String(reverseCharge),
        });
      } catch (error) {
        console.warn("[Invoice Request] customer fiscal metafields deferred", {
          customerGid: preparedCustomerGid,
          error: error?.message || String(error),
        });

        if (invoiceType === "company") {
          companyPreflight = companyPreflight || emptyCompanyPreflight();
          companyPreflight.syncRequired = true;
          companyPreflight.syncReason =
            companyPreflight.syncReason ||
            `Metafield cliente da riconciliare: ${error?.message || error}`;
          companyPreflight.warnings = [
            ...(companyPreflight.warnings || []),
            `Customer metafields: ${error?.message || error}`,
          ];
        }
      }
    }

    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: preparedCustomerGid || customerGid || customerId,
        customerEmail,
        invoiceType,
        countryCode,
        fiscalCode,
        vatNumber: fullVatNumber,
        pec,
        sdi,
        companyName,
        firstName,
        lastName,
        viesChecked,
        viesValid,
        viesRawResponse: viesRawResponse ? JSON.stringify(viesRawResponse) : null,
        reverseCharge,
        taxExemptApplied,
        status:
          viesUnavailable || companySyncRequired()
            ? "pending_review"
            : invoiceType === "private"
              ? "registered"
              : "validated",
        errorMessage: [
          viesUnavailable
            ? `Errore tecnico VIES: ${viesRawResponse?.errorCode || "VIES_UNAVAILABLE"}${viesRawResponse?.errorMessage ? ` - ${viesRawResponse.errorMessage}` : ""}`
            : "",
          companySyncReason(),
          reverseCharge && !taxExemptApplied && !taxExemptCustomerPrepared
            ? "VIES valido, ma reverse charge non confermato sul cliente Shopify."
            : "",
        ].filter(Boolean).join(" | ") || null,
      },
    });

    return responseJson({
      ok: true,
      invoiceRequestId: invoiceRequest.id,
      invoiceType,
      vatNumber: fullVatNumber,
      viesChecked,
      viesValid,
      reverseCharge,
      taxExemptApplied,
      viesUnavailable,
      viesTechnicalError: viesUnavailable,
      pendingManualReview: viesUnavailable || companySyncRequired(),
      taxExemptCustomerPrepared,
      reviewRequired: viesUnavailable || companySyncRequired(),
      companySyncRequired: companySyncRequired(),
      companySyncReason: companySyncReason(),
      companyPreflightState: companyPreflight?.state || "",
      vatMatch: companyPreflight?.vatMatch || "",
      companyContactId: companyPreflight?.companyContactId || "",
      locationCreated: Boolean(companyPreflight?.locationCreated),
      purchasePermissionReady: Boolean(companyPreflight?.purchasePermissionReady),
      companyWarnings: companyPreflight?.warnings || [],
      viesErrorCode: viesRawResponse?.errorCode || "",
      mustUseSameEmailAtCheckout,
      requiresLoginForTaxExemption,
      customerEmail,
      customerId: preparedCustomerGid || customerGid || customerId || "",
      companyPrepared: Boolean(companyPreflight?.companyId),
      companyId: companyPreflight?.companyId || "",
      companyLocationId: companyPreflight?.companyLocationId || "",
      companyContactId: companyPreflight?.companyContactId || "",
      companyCreated: Boolean(companyPreflight?.companyCreated),
      locationCreated: Boolean(companyPreflight?.locationCreated),
      contactCreated: Boolean(companyPreflight?.contactCreated),
      purchasePermissionReady: Boolean(companyPreflight?.purchasePermissionReady),
      orderingRoleAssigned: Boolean(companyPreflight?.orderingRoleAssigned),
      requiresB2BContextRefresh: Boolean(companyPreflight?.requiresB2BContextRefresh),
      message: reverseCharge
        ? viesUnavailable
          ? i18n.viesUnavailable()
          : customerGid && taxExemptApplied
            ? i18n.loggedTaxExemptApplied
            : taxExemptCustomerPrepared
              ? i18n.taxExemptPrepared
              : i18n.reverseChargeSaved
        : undefined,
    });
  } catch (error) {
    console.error("[Invoice Request] validate failed", {
      message: error?.message,
      invoiceType,
      countryCode,
      vatNumber: fullVatNumber,
      customerId: preparedCustomerGid || customerGid || customerId,
      proxyCustomerId,
      reverseCharge,
      taxExemptApplied,
      viesUnavailable,
      viesChecked,
      viesValid,
      viesRawResponse,
    });

    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: preparedCustomerGid || customerGid || customerId,
        customerEmail,
        invoiceType,
        countryCode,
        fiscalCode,
        vatNumber: fullVatNumber,
        pec,
        sdi,
        companyName,
        firstName,
        lastName,
        viesChecked,
        viesValid,
        viesRawResponse: viesRawResponse ? JSON.stringify(viesRawResponse) : null,
        reverseCharge,
        taxExemptApplied,
        status: "failed",
        errorMessage: error?.message || "Errore validazione fattura.",
      },
    });

    return responseJson(
      {
        ok: false,
        invoiceRequestId: invoiceRequest.id,
        error: error?.message || "Errore validazione fattura.",
      },
      500,
    );
  }
}
