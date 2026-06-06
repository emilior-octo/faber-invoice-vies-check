import { data as json, useFetcher, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";

const DISCOUNT_VALUES = [30, 20, 15, 10, 5, 3, 2];

const COLLECTIONS = [
  { handle: "ricambi", label: "Ricambi", type: "spare_parts" },
  { handle: "pro-deluxe-3-0", label: "Pro Deluxe 3.0", type: "standard" },
  { handle: "pro-inox-3-0", label: "Pro Inox 3.0", type: "standard" },
  { handle: "pro-essential-3-0", label: "Pro Essential 3.0", type: "standard" },
  { handle: "slot-plast-2", label: "Slot Plast 2.0", type: "standard" },
  { handle: "slot-inox-2", label: "Slot Inox 2.0", type: "standard" },
  { handle: "pro-deluxe-2-0", label: "Pro Deluxe 2.0", type: "standard" },
  { handle: "mini-agenta", label: "Mini Agenta", type: "standard" },
  { handle: "agenta", label: "Agenta", type: "standard" },
];

const DISCOUNT_PRESETS = [
  { label: "20% + 15% + 10%", effectiveDiscount: "38,80%", discounts: [20, 15, 10] },
  { label: "20% + 15%", effectiveDiscount: "32,00%", discounts: [20, 15] },
  { label: "20%", effectiveDiscount: "20,00%", discounts: [20] },
  { label: "20% + 10%", effectiveDiscount: "28,00%", discounts: [20, 10] },
  { label: "20% + 5%", effectiveDiscount: "24,00%", discounts: [20, 5] },
  { label: "20% + 15% + 5% + 3%", effectiveDiscount: "34,02%", discounts: [20, 15, 5, 3] },
  { label: "20% + 10% + 5%", effectiveDiscount: "31,60%", discounts: [20, 10, 5] },
  { label: "15% + 10% + 5% + 3% + 2%", effectiveDiscount: "31,44%", discounts: [15, 10, 5, 3, 2] },
  { label: "15% + 10% + 5% + 3%", effectiveDiscount: "29,02%", discounts: [15, 10, 5, 3] },
  { label: "15% + 10% + 5%", effectiveDiscount: "27,33%", discounts: [15, 10, 5] },
  { label: "15% + 10%", effectiveDiscount: "23,50%", discounts: [15, 10] },
  { label: "15%", effectiveDiscount: "15,00%", discounts: [15] },
  { label: "10% + 5% + 3% + 2%", effectiveDiscount: "18,72%", discounts: [10, 5, 3, 2] },
  { label: "10%", effectiveDiscount: "10,00%", discounts: [10] },
  { label: "5%", effectiveDiscount: "5,00%", discounts: [5] },
  { label: "3%", effectiveDiscount: "3,00%", discounts: [3] },
  { label: "2%", effectiveDiscount: "2,00%", discounts: [2] },
];

const RICAMBI_PRESETS = [
  { label: "10%", effectiveDiscount: "10,00%", discounts: [10] },
  { label: "20%", effectiveDiscount: "20,00%", discounts: [20] },
  { label: "30%", effectiveDiscount: "30,00%", discounts: [30] },
];

function buildPresetTag(collectionHandle, discounts) {
  return `b2b:${collectionHandle}:preset_${discounts.join("_")}:yes`;
}

function buildLegacyDiscountTag(collectionHandle, discountValue) {
  return `b2b:${collectionHandle}:discount_${discountValue}%:yes`;
}

function isManagedPresetTag(tag) {
  if (typeof tag !== "string") return false;
  return /^b2b:[^:]+:preset_[0-9_]+:yes$/.test(tag);
}

function isManagedLegacyDiscountTag(tag) {
  if (typeof tag !== "string") return false;

  return COLLECTIONS.some((collection) =>
    DISCOUNT_VALUES.some(
      (value) => tag === buildLegacyDiscountTag(collection.handle, value)
    )
  );
}

function isManagedB2BTag(tag) {
  return isManagedPresetTag(tag) || isManagedLegacyDiscountTag(tag);
}

function isManagedCollectionTag(tag, collectionHandle) {
  if (typeof tag !== "string") return false;

  if (tag.startsWith(`b2b:${collectionHandle}:preset_`)) {
    return true;
  }

  return DISCOUNT_VALUES.some(
    (value) => tag === buildLegacyDiscountTag(collectionHandle, value)
  );
}

function getPresetsForCollection(collectionHandle) {
  const collection = COLLECTIONS.find((item) => item.handle === collectionHandle);
  return collection?.type === "spare_parts" ? RICAMBI_PRESETS : DISCOUNT_PRESETS;
}

function getPresetTags(collectionHandle, presetIndex) {
  const presets = getPresetsForCollection(collectionHandle);
  const preset = presets[Number(presetIndex)];

  if (!preset) return [];

  return [buildPresetTag(collectionHandle, preset.discounts)];
}

function getPresetByTag(tag) {
  if (!isManagedPresetTag(tag)) return null;

  const parts = tag.split(":");
  const collectionHandle = parts[1];
  const presetPart = parts[2] || "";
  const presetKey = presetPart.replace("preset_", "");
  const discounts = presetKey
    .split("_")
    .map((value) => Number(value))
    .filter(Boolean);

  const preset = getPresetsForCollection(collectionHandle).find(
    (item) => item.discounts.join("_") === discounts.join("_")
  );

  return {
    collectionHandle,
    discounts,
    preset,
  };
}

function formatB2BTag(tag) {
  const parts = tag.split(":");
  const collectionHandle = parts[1];
  const collection = COLLECTIONS.find((item) => item.handle === collectionHandle);

  if (isManagedPresetTag(tag)) {
    const parsed = getPresetByTag(tag);
    const label = parsed?.preset?.label || `${parsed?.discounts?.join("% + ")}%`;

    return `${collection?.label || collectionHandle}: ${label}`;
  }

  const discountPart = parts[2] || "";
  const discount = discountPart.replace("discount_", "");

  return `${collection?.label || collectionHandle}: ${discount}`;
}

async function findCustomers(admin, query) {
  const response = await admin.graphql(
    `#graphql
      query SearchCustomers($query: String!) {
        customers(first: 10, query: $query) {
          nodes {
            id
            displayName
            email
            tags
            defaultAddress {
              company
            }
          }
        }
      }
    `,
    { variables: { query } }
  );

  const data = await response.json();
  return data?.data?.customers?.nodes || [];
}

async function getCustomer(admin, customerId) {
  const response = await admin.graphql(
    `#graphql
      query GetCustomer($id: ID!) {
        customer(id: $id) {
          id
          displayName
          email
          tags
          defaultAddress {
            company
          }
        }
      }
    `,
    { variables: { id: customerId } }
  );

  const data = await response.json();
  return data?.data?.customer || null;
}

async function addCustomerTags(admin, customerId, tags) {
  if (!tags.length) return [];

  const response = await admin.graphql(
    `#graphql
      mutation CustomerTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `,
    { variables: { id: customerId, tags } }
  );

  const data = await response.json();
  const errors = data?.data?.tagsAdd?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" "));
  }

  return tags;
}

async function removeCustomerTags(admin, customerId, tags) {
  if (!tags.length) return [];

  const response = await admin.graphql(
    `#graphql
      mutation CustomerTagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `,
    { variables: { id: customerId, tags } }
  );

  const data = await response.json();
  const errors = data?.data?.tagsRemove?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" "));
  }

  return tags;
}

export async function loader({ request }) {
  await authenticate.admin(request);

  return json({
    collections: COLLECTIONS,
    presets: DISCOUNT_PRESETS,
    ricambiPresets: RICAMBI_PRESETS,
  });
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "search") {
      const search = String(formData.get("search") || "").trim();

      if (!search) {
        return json({
          ok: false,
          error: "Inserisci nome, email o azienda cliente.",
          customers: [],
        });
      }

      const customers = await findCustomers(admin, search);

      return json({
        ok: true,
        customers,
      });
    }

    if (intent === "loadCustomer") {
      const customerId = String(formData.get("customerId") || "");

      if (!customerId) {
        return json({
          ok: false,
          error: "Cliente non valido.",
        });
      }

      const customer = await getCustomer(admin, customerId);

      if (!customer) {
        return json({
          ok: false,
          error: "Cliente non trovato.",
        });
      }

      return json({
        ok: true,
        selectedCustomer: customer,
      });
    }

    if (intent === "applyDiscount") {
      const customerId = String(formData.get("customerId") || "");
      const collectionHandle = String(formData.get("collectionHandle") || "");
      const presetIndex = String(formData.get("presetIndex") || "");

      if (!customerId || !collectionHandle || presetIndex === "") {
        return json({
          ok: false,
          error: "Dati mancanti per applicare lo sconto.",
        });
      }

      const customer = await getCustomer(admin, customerId);

      if (!customer) {
        return json({
          ok: false,
          error: "Cliente non trovato.",
        });
      }

      const currentTags = Array.isArray(customer.tags) ? customer.tags : [];
      const tagsToRemove = currentTags.filter((tag) =>
        isManagedCollectionTag(tag, collectionHandle)
      );
      const tagsToAdd = getPresetTags(collectionHandle, presetIndex);

      await removeCustomerTags(admin, customerId, tagsToRemove);
      await addCustomerTags(admin, customerId, tagsToAdd);

      const updatedCustomer = await getCustomer(admin, customerId);

      return json({
        ok: true,
        selectedCustomer: updatedCustomer,
        message: "Sconto B2B applicato correttamente.",
      });
    }

    if (intent === "removeCollectionDiscount") {
      const customerId = String(formData.get("customerId") || "");
      const collectionHandle = String(formData.get("collectionHandle") || "");

      if (!customerId || !collectionHandle) {
        return json({
          ok: false,
          error: "Dati mancanti per rimuovere lo sconto.",
        });
      }

      const customer = await getCustomer(admin, customerId);

      if (!customer) {
        return json({
          ok: false,
          error: "Cliente non trovato.",
        });
      }

      const currentTags = Array.isArray(customer.tags) ? customer.tags : [];
      const tagsToRemove = currentTags.filter((tag) =>
        isManagedCollectionTag(tag, collectionHandle)
      );

      await removeCustomerTags(admin, customerId, tagsToRemove);

      const updatedCustomer = await getCustomer(admin, customerId);

      return json({
        ok: true,
        selectedCustomer: updatedCustomer,
        message: "Sconto B2B rimosso per questa gamma.",
      });
    }

    return json({
      ok: false,
      error: "Azione non riconosciuta.",
    });
  } catch (error) {
    return json({
      ok: false,
      error: error?.message || "Errore imprevisto.",
    });
  }
}

export default function B2BCustomerDiscountsPage() {
  const { collections, presets, ricambiPresets } = useLoaderData();
  const fetcher = useFetcher();

  const [selectedCustomer, setSelectedCustomer] = useState(null);

  function submitB2BAction(payload) {
    const formData = new FormData();

    Object.entries(payload).forEach(([key, value]) => {
      formData.append(key, String(value ?? ""));
    });

    fetcher.submit(formData, {
      method: "post",
      action: "/app/b2b-discounts",
    });
  }

  const customers = fetcher.data?.customers || [];
  const serverCustomer = fetcher.data?.selectedCustomer;

  useEffect(() => {
    if (serverCustomer) {
      setSelectedCustomer(serverCustomer);
    }
  }, [serverCustomer]);

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>B2B Customer Discounts</h1>

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>Cerca cliente</h2>

        <form
          style={styles.searchRow}
          onSubmit={(event) => {
            event.preventDefault();

            const formData = new FormData(event.currentTarget);

            submitB2BAction({
              intent: "search",
              search: String(formData.get("search") || ""),
            });
          }}
        >
          <input
            name="search"
            type="text"
            placeholder="Nome, email o azienda"
            style={styles.input}
          />

          <button type="submit" style={styles.primaryButton}>
            Cerca
          </button>
        </form>

        {fetcher.data?.error && (
          <div style={styles.error}>{fetcher.data.error}</div>
        )}

        {customers.length > 0 && (
          <div style={styles.results}>
            {customers.map((customer) => (
              <div key={customer.id}>
                <button
                  type="button"
                  style={styles.customerButton}
                  onClick={() =>
                    submitB2BAction({
                      intent: "loadCustomer",
                      customerId: customer.id,
                    })
                  }
                >
                  <strong>{customer.displayName || "Cliente"}</strong>
                  <span>{customer.email || "Email non disponibile"}</span>
                  {customer.defaultAddress?.company && (
                    <span>{customer.defaultAddress.company}</span>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedCustomer && (
        <DiscountEditor
          customer={selectedCustomer}
          collections={collections}
          presets={presets}
          ricambiPresets={ricambiPresets}
          fetcher={fetcher}
          submitB2BAction={submitB2BAction}
        />
      )}
    </div>
  );
}

function DiscountEditor({
  customer,
  collections,
  presets,
  ricambiPresets,
  fetcher,
  submitB2BAction,
}) {
  const [selectedCollection, setSelectedCollection] = useState(
    collections[0]?.handle || ""
  );
  const [selectedPresetIndex, setSelectedPresetIndex] = useState("0");

  const currentCollection = collections.find(
    (item) => item.handle === selectedCollection
  );

  const visiblePresets =
    currentCollection?.type === "spare_parts" ? ricambiPresets : presets;

  const selectedPreset = visiblePresets[Number(selectedPresetIndex)];

  const previewTag = selectedPreset?.discounts?.length
    ? buildPresetTag(selectedCollection, selectedPreset.discounts)
    : "";

  const currentB2BTags = Array.isArray(customer.tags)
    ? customer.tags.filter(isManagedB2BTag)
    : [];

  const currentCollectionTags = Array.isArray(customer.tags)
    ? customer.tags.filter((tag) => isManagedCollectionTag(tag, selectedCollection))
    : [];

  function handleCollectionChange(event) {
    setSelectedCollection(event.currentTarget.value);
    setSelectedPresetIndex("0");
  }

  return (
    <section style={styles.card}>
      <h2 style={styles.sectionTitle}>Cliente selezionato</h2>

      <div style={styles.customerBox}>
        <strong>{customer.displayName || "Cliente"}</strong>
        <span>{customer.email || "Email non disponibile"}</span>
        {customer.defaultAddress?.company && (
          <span>{customer.defaultAddress.company}</span>
        )}
      </div>

      <div style={styles.grid}>
        <label style={styles.label}>
          Gamma prodotto
          <select
            name="collectionHandle"
            value={selectedCollection}
            onChange={handleCollectionChange}
            style={styles.select}
          >
            {collections.map((collection) => (
              <option key={collection.handle} value={collection.handle}>
                {collection.label}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.label}>
          Sconto da applicare
          <select
            name="presetIndex"
            value={selectedPresetIndex}
            onChange={(event) => setSelectedPresetIndex(event.currentTarget.value)}
            style={styles.select}
          >
            {visiblePresets.map((preset, index) => (
              <option key={`${preset.label}-${index}`} value={index}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={styles.previewBox}>
        <strong>Selezione pronta</strong>
        <span>
          {currentCollection?.label || selectedCollection}:{" "}
          {selectedPreset ? selectedPreset.label : "Nessuno sconto"}
        </span>

        {previewTag && <code style={styles.code}>{previewTag}</code>}
      </div>

      {currentCollectionTags.length > 0 && (
        <div style={styles.previewBox}>
          <strong>Attualmente su questa gamma</strong>
          <div style={styles.pills}>
            {currentCollectionTags.map((tag) => (
              <span key={tag} style={styles.pill}>
                {formatB2BTag(tag)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={styles.actions}>
        <button
          type="button"
          style={styles.primaryButton}
          onClick={() => {
            const ok = window.confirm(
              `Vuoi applicare ${currentCollection?.label}: ${selectedPreset?.label}?`
            );

            if (!ok) return;

            submitB2BAction({
              intent: "applyDiscount",
              customerId: customer.id,
              collectionHandle: selectedCollection,
              presetIndex: selectedPresetIndex,
            });
          }}
        >
          Applica sconto
        </button>

        <button
          type="button"
          style={styles.secondaryButton}
          onClick={() => {
            const ok = window.confirm(
              `Vuoi rimuovere lo sconto B2B da ${currentCollection?.label}?`
            );

            if (!ok) return;

            submitB2BAction({
              intent: "removeCollectionDiscount",
              customerId: customer.id,
              collectionHandle: selectedCollection,
            });
          }}
        >
          Rimuovi sconto gamma
        </button>
      </div>

      {fetcher.data?.message && (
        <div style={styles.success}>{fetcher.data.message}</div>
      )}

      {currentB2BTags.length > 0 && (
        <div style={styles.currentBox}>
          <h3 style={styles.smallTitle}>Sconti B2B attualmente selezionati</h3>
          <div style={styles.pills}>
            {currentB2BTags.map((tag) => (
              <span key={tag} style={styles.pill}>
                {formatB2BTag(tag)}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const styles = {
  page: {
    maxWidth: 980,
    margin: "0 auto",
    padding: 24,
    fontFamily: "Arial, sans-serif",
  },
  title: { marginBottom: 20 },
  card: {
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 20,
    marginTop: 0,
    marginBottom: 16,
  },
  smallTitle: {
    fontSize: 16,
    marginTop: 0,
    marginBottom: 10,
  },
  searchRow: {
    display: "flex",
    gap: 10,
  },
  input: {
    flex: 1,
    padding: 10,
    border: "1px solid #bbb",
    borderRadius: 8,
  },
  select: {
    width: "100%",
    padding: 10,
    border: "1px solid #bbb",
    borderRadius: 8,
    marginTop: 6,
  },
  label: {
    display: "block",
    fontWeight: 700,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    marginTop: 18,
  },
  primaryButton: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #111",
    background: "#111",
    color: "#fff",
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #bbb",
    background: "#f7f7f7",
    color: "#111",
    cursor: "pointer",
  },
  results: {
    display: "grid",
    gap: 10,
    marginTop: 16,
  },
  customerButton: {
    width: "100%",
    textAlign: "left",
    padding: 12,
    border: "1px solid #ddd",
    borderRadius: 10,
    background: "#fafafa",
    display: "grid",
    gap: 4,
    cursor: "pointer",
  },
  customerBox: {
    display: "grid",
    gap: 4,
    padding: 12,
    background: "#fafafa",
    borderRadius: 10,
    border: "1px solid #eee",
  },
  previewBox: {
    display: "grid",
    gap: 8,
    padding: 12,
    background: "#fafafa",
    borderRadius: 10,
    border: "1px solid #eee",
    marginTop: 16,
  },
  currentBox: { marginTop: 20 },
  pills: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  pill: {
    padding: "5px 9px",
    border: "1px solid #ccc",
    borderRadius: 999,
    fontSize: 12,
    background: "#fff",
  },
  code: {
    display: "inline-block",
    padding: "8px 10px",
    borderRadius: 8,
    background: "#f2f2f2",
    fontSize: 12,
    wordBreak: "break-all",
  },
  actions: {
    display: "flex",
    gap: 10,
    marginTop: 18,
  },
  error: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    background: "#ffecec",
    color: "#8a0000",
  },
  success: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    background: "#eaffea",
    color: "#106b10",
  },
};