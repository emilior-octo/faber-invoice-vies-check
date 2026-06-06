import {
  reactExtension,
  BlockStack,
  Box,
  Checkbox,
  TextField,
  Button,
  Text,
  InlineStack,
} from "@shopify/ui-extensions-react/admin";
import {useEffect, useMemo, useState} from "react";

export default reactExtension("admin.customer-details.block.render", () => (
  <DiscountPanel />
));

function DiscountPanel({data}) {
  const customer = data?.selected?.[0] || data?.customer || null;

  const existingTags = useMemo(() => {
    const raw = customer?.tags || [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      return raw.split(",").map((t) => t.trim()).filter(Boolean);
    }
    return [];
  }, [customer]);

  const [cluster3, setCluster3] = useState(false);
  const [cluster5, setCluster5] = useState(false);
  const [dist3, setDist3] = useState(false);
  const [bonifico2, setBonifico2] = useState(false);

  const [ricambi10, setRicambi10] = useState(false);
  const [ricambi20, setRicambi20] = useState(false);
  const [ricambi30, setRicambi30] = useState(false);

  const [customDiscount, setCustomDiscount] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const has = (tag) => existingTags.includes(tag);

    setCluster3(has("discount_3%:yes"));
    setCluster5(has("discount_5%:yes"));
    setDist3(has("discount_3%_distributori:yes"));
    setBonifico2(has("discount_2%_bonifico_anticipato:yes"));

    setRicambi10(has("discount_ricambi_10%:yes"));
    setRicambi20(has("discount_ricambi_20%:yes"));
    setRicambi30(has("discount_ricambi_30%:yes"));

    const customTag = existingTags.find((t) => t.startsWith("discount_custom_"));
    if (customTag) {
      setCustomDiscount(customTag.replace("discount_custom_", "").replaceAll("_", "."));
    } else {
      setCustomDiscount("");
    }
  }, [existingTags]);

  function normalizeCustomDiscount(value) {
    const cleaned = String(value).trim().replace(",", ".");
    if (!cleaned) return "";
    const num = Number(cleaned);
    if (Number.isNaN(num) || num <= 0) return "";
    return String(num).replace(".", "_");
  }

  function setRicambiOnly(value) {
    setRicambi10(value === "10");
    setRicambi20(value === "20");
    setRicambi30(value === "30");
  }

  async function save() {
    if (!customer?.id) {
      setMessage("Cliente non trovato");
      return;
    }

    setSaving(true);
    setMessage("");

    const tagsToAdd = [];

    if (cluster3) tagsToAdd.push("discount_3%:yes");
    if (cluster5) tagsToAdd.push("discount_5%:yes");
    if (dist3) tagsToAdd.push("discount_3%_distributori:yes");
    if (bonifico2) tagsToAdd.push("discount_2%_bonifico_anticipato:yes");

    if (ricambi10) tagsToAdd.push("discount_ricambi_10%:yes");
    if (ricambi20) tagsToAdd.push("discount_ricambi_20%:yes");
    if (ricambi30) tagsToAdd.push("discount_ricambi_30%:yes");

    const normalizedCustom = normalizeCustomDiscount(customDiscount);
    if (normalizedCustom) {
      tagsToAdd.push(`discount_custom_${normalizedCustom}`);
    }

    try {
      const res = await fetch("/api/save-discounts", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          customerId: customer.id,
          tagsToAdd,
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Save failed");
      }

      setMessage("Salvato");
    } catch (e) {
      setMessage(`Errore: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <BlockStack gap="400">
      <Text fontWeight="bold">Customer Discounts</Text>

      <Box>
        <Text fontWeight="bold">Cluster</Text>
      </Box>

      <Checkbox checked={cluster3} onChange={setCluster3}>3%</Checkbox>
      <Checkbox checked={cluster5} onChange={setCluster5}>5%</Checkbox>
      <Checkbox checked={dist3} onChange={setDist3}>3% distributori</Checkbox>
      <Checkbox checked={bonifico2} onChange={setBonifico2}>2% bonifico anticipato</Checkbox>

      <Box>
        <Text fontWeight="bold">Ricambi</Text>
      </Box>

      <Checkbox checked={ricambi10} onChange={() => setRicambiOnly(ricambi10 ? "" : "10")}>10%</Checkbox>
      <Checkbox checked={ricambi20} onChange={() => setRicambiOnly(ricambi20 ? "" : "20")}>20%</Checkbox>
      <Checkbox checked={ricambi30} onChange={() => setRicambiOnly(ricambi30 ? "" : "30")}>30%</Checkbox>

      <TextField
        label="Sconto personalizzato %"
        value={customDiscount}
        onChange={setCustomDiscount}
      />

      <InlineStack gap="300">
        <Button onPress={save} loading={saving}>Save</Button>
        {message ? <Text>{message}</Text> : null}
      </InlineStack>
    </BlockStack>
  );
}