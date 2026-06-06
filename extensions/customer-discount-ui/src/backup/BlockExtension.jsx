import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

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
  { label: "20% + 15% + 10%", discounts: [20, 15, 10] },
  { label: "20% + 15%", discounts: [20, 15] },
  { label: "20%", discounts: [20] },
  { label: "20% + 10%", discounts: [20, 10] },
  { label: "20% + 5%", discounts: [20, 5] },
  { label: "20% + 15% + 5% + 3%", discounts: [20, 15, 5, 3] },
  { label: "20% + 10% + 5%", discounts: [20, 10, 5] },
  { label: "15% + 10% + 5% + 3% + 2%", discounts: [15, 10, 5, 3, 2] },
  { label: "15% + 10% + 5% + 3%", discounts: [15, 10, 5, 3] },
  { label: "15% + 10% + 5%", discounts: [15, 10, 5] },
  { label: "15% + 10%", discounts: [15, 10] },
  { label: "15%", discounts: [15] },
  { label: "10% + 5% + 3% + 2%", discounts: [10, 5, 3, 2] },
  { label: "10%", discounts: [10] },
  { label: "5%", discounts: [5] },
  { label: "3%", discounts: [3] },
  { label: "2%", discounts: [2] },
];

const RICAMBI_PRESETS = [
  { label: "10%", discounts: [10] },
  { label: "20%", discounts: [20] },
  { label: "30%", discounts: [30] },
];

export default async () => {
  render(<CustomerDiscountBlock />, document.body);
};

function CustomerDiscountBlock() {
  const selectedCustomerId = shopify?.data?.selected?.[0]?.id || null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [customer, setCustomer] = useState(null);
  const [originalDiscounts, setOriginalDiscounts] = useState([]);
  const [originalCustomerTags, setOriginalCustomerTags] = useState([]);
  const [collectionHandle, setCollectionHandle] = useState(COLLECTIONS[0].handle);
  const [presetIndex, setPresetIndex] = useState("0");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const currentCollection = COLLECTIONS.find(
    (item) => item.handle === collectionHandle
  );

  const visiblePresets =
    currentCollection?.type === "spare_parts" ? RICAMBI_PRESETS : DISCOUNT_PRESETS;

  const selectedPreset = visiblePresets[Number(presetIndex)];

  const currentCollectionDiscounts = useMemo(() => {
    return originalDiscounts.filter((discount) =>
      isManagedCollectionDiscount(discount, collectionHandle)
    );
  }, [originalDiscounts, collectionHandle]);

  const currentB2BDiscounts = useMemo(() => {
    return originalDiscounts.filter(isManagedB2BDiscount);
  }, [originalDiscounts]);

  useEffect(() => {
    loadCustomer();
  }, [selectedCustomerId]);

  async function loadCustomer() {
    setLoading(true);
    setError("");
    setSuccess("");

    try {
      if (!selectedCustomerId) throw new Error("Customer ID not found.");

      const response = await shopify.query(
        `query CustomerDiscountPanel($id: ID!) {
          customer(id: $id) {
            id
            displayName
            email
            tags
            discountMetafield: metafield(namespace: "custom", key: "discount") {
              id
              namespace
              key
              type
              value
            }
          }
        }`,
        { variables: { id: selectedCustomerId } }
      );

      const loadedCustomer = response?.data?.customer;
      if (!loadedCustomer) throw new Error("Customer not found.");

      setCustomer(loadedCustomer);

      const discounts = parseDiscountMetafieldValue(
        loadedCustomer.discountMetafield?.value
      );

      setOriginalDiscounts(discounts);
      setOriginalCustomerTags(
        Array.isArray(loadedCustomer.tags) ? loadedCustomer.tags : []
      );
    } catch (err) {
      setError(err?.message || "Unable to load customer discounts.");
    } finally {
      setLoading(false);
    }
  }

  async function saveCollectionPreset() {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const discountToAdd = buildPresetDiscount(
        collectionHandle,
        selectedPreset.discounts
      );

      const nextDiscounts = [
        ...originalDiscounts.filter(
          (discount) => !isManagedCollectionDiscount(discount, collectionHandle)
        ),
        discountToAdd,
      ];

      const cleanDiscounts = cleanB2BDiscounts(nextDiscounts);

      const nextCustomerTags = [
        ...originalCustomerTags.filter(
          (tag) => !isManagedCollectionDiscount(tag, collectionHandle)
        ),
        discountToAdd,
      ];

      const updatedDiscounts = await updateCustomerDiscountMetafield(
        selectedCustomerId,
        cleanDiscounts
      );

      const updatedTags = await updateCustomerTags(
        selectedCustomerId,
        nextCustomerTags
      );

      setOriginalDiscounts(updatedDiscounts);
      setOriginalCustomerTags(updatedTags);
      setSuccess("Sconto B2B salvato su metafield e tag.");
    } catch (err) {
      setError(err?.message || "Unable to save customer discounts.");
    } finally {
      setSaving(false);
    }
  }

  async function removeCollectionPreset() {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const nextDiscounts = originalDiscounts.filter(
        (discount) => !isManagedCollectionDiscount(discount, collectionHandle)
      );

      const nextCustomerTags = originalCustomerTags.filter(
        (tag) => !isManagedCollectionDiscount(tag, collectionHandle)
      );

      const updatedDiscounts = await updateCustomerDiscountMetafield(
        selectedCustomerId,
        nextDiscounts
      );

      const updatedTags = await updateCustomerTags(
        selectedCustomerId,
        nextCustomerTags
      );

      setOriginalDiscounts(updatedDiscounts);
      setOriginalCustomerTags(updatedTags);
      setSuccess("Sconto B2B rimosso da metafield e tag.");
    } catch (err) {
      setError(err?.message || "Unable to remove customer discounts.");
    } finally {
      setSaving(false);
    }
  }

  async function updateCustomerDiscountMetafield(customerId, discounts) {
    const cleanDiscounts = cleanB2BDiscounts(discounts);

    const response = await shopify.query(
      `mutation SaveCustomerDiscountMetafield($metafields: [MetafieldsSetInput!]!) {
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
        variables: {
          metafields: [
            {
              ownerId: customerId,
              namespace: "custom",
              key: "discount",
              type: "list.single_line_text_field",
              value: JSON.stringify(cleanDiscounts),
            },
          ],
        },
      }
    );

    const userErrors = response?.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(userErrors.map((item) => item.message).join(" "));
    }

    const savedValue =
      response?.data?.metafieldsSet?.metafields?.[0]?.value || "[]";

    return parseDiscountMetafieldValue(savedValue);
  }

  async function updateCustomerTags(customerId, tags) {
    const cleanTags = Array.from(
      new Set(
        tags
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      )
    );

    const response = await shopify.query(
      `mutation UpdateCustomerDiscountTags($input: CustomerInput!) {
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
        variables: {
          input: {
            id: customerId,
            tags: cleanTags,
          },
        },
      }
    );

    const userErrors = response?.data?.customerUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(userErrors.map((item) => item.message).join(" "));
    }

    return response?.data?.customerUpdate?.customer?.tags || cleanTags;
  }

  function handleCollectionChange(event) {
    setCollectionHandle(event.currentTarget.value);
    setPresetIndex("0");
    setSuccess("");
  }

  return (
    <s-admin-block title="B2B Discounts">
      <s-stack gap="small">
        {loading ? (
          <s-text>Loading...</s-text>
        ) : (
          <>
            {customer && (
              <s-stack gap="none">
                <s-text>{customer.displayName || "Customer"}</s-text>
                {customer.email && <s-text>{customer.email}</s-text>}
              </s-stack>
            )}

            {error && (
              <s-banner tone="critical">
                <s-text>{error}</s-text>
              </s-banner>
            )}

            {success && (
              <s-banner tone="success">
                <s-text>{success}</s-text>
              </s-banner>
            )}

            <s-select
              label="Gamma"
              value={collectionHandle}
              onChange={handleCollectionChange}
            >
              {COLLECTIONS.map((collection) => (
                <s-option key={collection.handle} value={collection.handle}>
                  {collection.label}
                </s-option>
              ))}
            </s-select>

            <s-select
              label="Sconto"
              value={presetIndex}
              onChange={(event) => {
                setPresetIndex(event.currentTarget.value);
                setSuccess("");
              }}
            >
              {visiblePresets.map((preset, index) => (
                <s-option key={`${preset.label}-${index}`} value={String(index)}>
                  {preset.label}
                </s-option>
              ))}
            </s-select>

            {currentCollectionDiscounts.length > 0 && (
              <s-stack gap="none">
                <s-text>Attuale su gamma:</s-text>
                {currentCollectionDiscounts.map((discount) => (
                  <s-text key={discount}>{formatB2BDiscount(discount)}</s-text>
                ))}
              </s-stack>
            )}

            <s-stack direction="inline" gap="small">
              <s-button
                variant="primary"
                disabled={saving || !selectedPreset}
                onClick={saveCollectionPreset}
              >
                {saving ? "Saving..." : "Salva"}
              </s-button>

              <s-button
                disabled={saving || currentCollectionDiscounts.length === 0}
                onClick={removeCollectionPreset}
              >
                Rimuovi
              </s-button>
            </s-stack>

            {currentB2BDiscounts.length > 0 && (
              <s-stack gap="none">
                <s-text>Sconti attivi:</s-text>
                {currentB2BDiscounts.map((discount) => (
                  <s-text key={discount}>• {formatB2BDiscount(discount)}</s-text>
                ))}
              </s-stack>
            )}
          </>
        )}
      </s-stack>
    </s-admin-block>
  );
}

function cleanB2BDiscounts(discounts) {
  return Array.from(
    new Set(
      discounts
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(isManagedB2BDiscount)
    )
  );
}

function parseDiscountMetafieldValue(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) return [];

    return cleanB2BDiscounts(parsed);
  } catch {
    return [];
  }
}

function buildPresetDiscount(collectionHandle, discounts) {
  return `b2b:${collectionHandle}:preset_${discounts.join("_")}:yes`;
}

function buildLegacyDiscount(collectionHandle, discountValue) {
  return `b2b:${collectionHandle}:discount_${discountValue}%:yes`;
}

function isManagedPresetDiscount(discount) {
  return (
    typeof discount === "string" &&
    /^b2b:[^:]+:preset_[0-9_]+:yes$/.test(discount)
  );
}

function isManagedLegacyDiscount(discount) {
  if (typeof discount !== "string") return false;

  return COLLECTIONS.some((collection) =>
    DISCOUNT_VALUES.some(
      (value) => discount === buildLegacyDiscount(collection.handle, value)
    )
  );
}

function isManagedB2BDiscount(discount) {
  return isManagedPresetDiscount(discount) || isManagedLegacyDiscount(discount);
}

function isManagedCollectionDiscount(discount, collectionHandle) {
  if (typeof discount !== "string") return false;

  if (discount.startsWith(`b2b:${collectionHandle}:preset_`)) return true;

  return DISCOUNT_VALUES.some(
    (value) => discount === buildLegacyDiscount(collectionHandle, value)
  );
}

function getPresetsForCollection(collectionHandle) {
  const collection = COLLECTIONS.find((item) => item.handle === collectionHandle);

  return collection?.type === "spare_parts" ? RICAMBI_PRESETS : DISCOUNT_PRESETS;
}

function getPresetByDiscount(discount) {
  if (!isManagedPresetDiscount(discount)) return null;

  const parts = discount.split(":");
  const collectionHandle = parts[1];
  const presetKey = String(parts[2] || "").replace("preset_", "");

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

function formatB2BDiscount(discount) {
  const parts = discount.split(":");
  const collectionHandle = parts[1];
  const collection = COLLECTIONS.find((item) => item.handle === collectionHandle);

  if (isManagedPresetDiscount(discount)) {
    const parsed = getPresetByDiscount(discount);
    const label = parsed?.preset?.label || `${parsed?.discounts?.join("% + ")}%`;

    return `${collection?.label || collectionHandle}: ${label}`;
  }

  const discountPart = parts[2] || "";
  const discountValue = discountPart.replace("discount_", "");

  return `${collection?.label || collectionHandle}: ${discountValue}`;
}