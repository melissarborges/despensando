const STORAGE_KEY = "grocery-value-tracker-v1";
const XML_DATABASE_URL = "./products.xml";
const PRODUCT_APIS = [
  {
    name: "Open Food Facts",
    url: (barcode) => `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(barcode)}.json`,
  },
  {
    name: "Open Products Facts",
    url: (barcode) => `https://world.openproductsfacts.org/api/v3/product/${encodeURIComponent(barcode)}.json`,
  },
];

const state = loadState();
let stream = null;
let scannerTimer = null;
let money = createMoneyFormatter();
let activeRecordsTab = "history";
let xmlProductsCache = null;
const page = GroceryPageObject();
const els = page.elements;

page.setInitialValues(state.currency);

els.scanBtn.addEventListener("click", startScanner);
els.stopScanBtn.addEventListener("click", stopScanner);
els.barcodePhotoInput.addEventListener("change", scanBarcodePhoto);
els.lookupBtn.addEventListener("click", () => selectBarcode(els.barcodeInput.value.trim()));
els.form.addEventListener("submit", saveItem);
els.finishShoppingBtn.addEventListener("click", finishShopping);
els.historyFilter.addEventListener("change", render);
els.historyTab.addEventListener("click", () => switchRecordsTab("history"));
els.comparisonTab.addEventListener("click", () => switchRecordsTab("comparison"));
els.clearDataBtn.addEventListener("click", clearData);
els.exportBtn.addEventListener("click", exportData);
els.importFile.addEventListener("change", importData);
els.pricingMode.addEventListener("change", page.syncPriceFields);
els.quantity.addEventListener("input", page.syncPriceFields);
els.unitPrice.addEventListener("input", page.syncPriceFields);
els.weight.addEventListener("input", page.syncPriceFields);
els.weightPrice.addEventListener("input", page.syncPriceFields);
els.barcodeInput.addEventListener("input", updateLowestPrice);
els.productName.addEventListener("input", updateLowestPrice);
els.budgetInput.addEventListener("input", updateBudget);
els.currencySelect.addEventListener("change", () => {
  state.currency = els.currencySelect.value;
  money = createMoneyFormatter();
  persist();
  render();
});

render();

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return { current: [], shops: [], products: {}, currency: defaultCurrency(), budget: 0 };
  }

  try {
    const parsed = JSON.parse(saved);
    return { current: [], shops: [], products: {}, currency: defaultCurrency(), budget: 0, ...parsed };
  } catch {
    return { current: [], shops: [], products: {}, currency: defaultCurrency(), budget: 0 };
  }
}

function defaultCurrency() {
  return "BRL";
}

function createMoneyFormatter() {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: state.currency || defaultCurrency(),
  });
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function startScanner() {
  if (!("BarcodeDetector" in window)) {
    page.setLookupStatus("Este navegador não suporta leitura automática. Digite o código manualmente.", "warning");
    els.barcodeInput.focus();
    return;
  }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    page.setLookupStatus("A câmera ao vivo precisa de HTTPS. No celular, use Foto do código ou digite o código.", "warning");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    page.setCameraActive(true);

    const detector = new BarcodeDetector({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    });

    scannerTimer = window.setInterval(async () => {
      const codes = await detector.detect(els.video);
      if (codes.length) {
        selectBarcode(codes[0].rawValue);
        stopScanner();
      }
    }, 650);
  } catch (error) {
    page.setLookupStatus("A câmera não foi liberada. Use Foto do código ou digite o código manualmente.", "warning");
    stopScanner();
  }
}

async function scanBarcodePhoto(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  if (!("BarcodeDetector" in window)) {
    page.setLookupStatus("Este navegador não suporta leitura automática por foto. Digite o código manualmente.", "warning");
    event.target.value = "";
    return;
  }

  page.setLookupLoading(true);
  page.setLookupStatus("Lendo código de barras pela foto...");

  try {
    const imageSource = await imageSourceFromFile(file);
    const detector = new BarcodeDetector({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    });
    const codes = await detector.detect(imageSource);
    imageSource.close?.();

    if (!codes.length) {
      page.setLookupStatus("Não encontrei código na foto. Tente aproximar e iluminar melhor.", "warning");
      return;
    }

    await selectBarcode(codes[0].rawValue);
  } catch {
    page.setLookupStatus("Não foi possível ler a foto. Digite o código manualmente.", "warning");
  } finally {
    page.setLookupLoading(false);
    event.target.value = "";
  }
}

async function imageSourceFromFile(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image could not be loaded."));
    };
    image.src = url;
  });
}

function stopScanner() {
  if (scannerTimer) {
    window.clearInterval(scannerTimer);
    scannerTimer = null;
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  els.video.srcObject = null;
  page.setCameraActive(false);
}

async function selectBarcode(barcode) {
  if (!barcode) {
    els.barcodeInput.focus();
    return;
  }

  els.barcodeInput.value = barcode;
  const knownProduct = state.products[barcode];
  if (knownProduct) {
    page.setKnownProduct(knownProduct);
    page.setLookupStatus("Product loaded from your saved products.", "success");
    updateLowestPrice();
    return;
  }

  await recognizeProduct(barcode);
}

async function recognizeProduct(barcode) {
  page.setLookupLoading(true);
  page.setLookupStatus("Looking up product by barcode...");

  try {
    const localProduct = await findProductInXmlDatabase(barcode);
    const recognized = localProduct || await fetchProductByBarcode(barcode);

    if (!recognized) {
      page.setLookupStatus("Product not found. You can type the product name manually.", "warning");
      page.setKnownProduct(null);
      return;
    }

    page.setRecognizedProduct(recognized);
    state.products[barcode] = {
      name: recognized.name,
      brand: recognized.brand || "",
      unit: els.unit.value,
      lastStore: "",
      source: recognized.source,
    };
    persist();
    page.setLookupStatus(`Product recognized with ${recognized.source}.`, "success");
    updateLowestPrice();
  } catch {
    page.setLookupStatus("Could not reach the product API. You can type the product name manually.", "warning");
  } finally {
    page.setLookupLoading(false);
  }
}

async function findProductInXmlDatabase(barcode) {
  const products = await loadXmlProducts();
  return products.find((product) => product.barcode === barcode) || null;
}

async function loadXmlProducts() {
  if (xmlProductsCache) {
    return xmlProductsCache;
  }

  const response = await fetch(XML_DATABASE_URL, { cache: "no-cache" });
  if (!response.ok) {
    xmlProductsCache = [];
    return xmlProductsCache;
  }

  const xmlText = await response.text();
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) {
    xmlProductsCache = [];
    return xmlProductsCache;
  }

  xmlProductsCache = [...xml.querySelectorAll("product")].map((product) => ({
    barcode: xmlTextContent(product, "barcode"),
    name: xmlTextContent(product, "name"),
    brand: xmlTextContent(product, "brand"),
    unit: xmlTextContent(product, "unit") || "unit",
    quantity: xmlTextContent(product, "quantity"),
    pricingMode: xmlTextContent(product, "pricingMode") || "unit",
    price: parseXmlPrice(xmlTextContent(product, "price")),
    source: "banco XML local",
  })).filter((product) => product.barcode && product.name);

  return xmlProductsCache;
}

function xmlTextContent(node, selector) {
  return node.querySelector(selector)?.textContent.trim() || "";
}

function parseXmlPrice(value) {
  return Number(String(value).replace(",", ".")) || 0;
}

async function fetchProductByBarcode(barcode) {
  for (const api of PRODUCT_APIS) {
    const response = await fetch(api.url(barcode), {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      continue;
    }

    const data = await response.json();
    const product = normalizeApiProduct(data.product);
    if (product) {
      return { ...product, source: api.name };
    }
  }

  return null;
}

function normalizeApiProduct(product) {
  if (!product) {
    return null;
  }

  const name = [
    product.product_name_pt,
    product.product_name_br,
    product.product_name,
    product.product_name_en,
    product.generic_name,
    product.abbreviated_product_name,
  ].find(Boolean);

  if (!name) {
    return null;
  }

  return {
    name,
    brand: product.brands,
    quantity: product.quantity,
  };
}

function saveItem(event) {
  event.preventDefault();

  const item = page.readItemForm();
  const barcode = item.barcode;

  if (!isValidItem(item)) {
    return;
  }

  const existingIndex = state.current.findIndex((entry) => entry.id === item.id);
  if (existingIndex >= 0) {
    state.current[existingIndex] = item;
  } else {
    state.current.push(item);
  }

  if (barcode) {
    state.products[barcode] = {
      name: item.name,
      brand: item.brand,
      unit: item.unit,
      lastStore: item.store,
    };
  }

  page.resetItemForm();
  updateLowestPrice();
  persist();
  render();
}

function isValidItem(item) {
  if (!item.name || !item.price) {
    return false;
  }

  if (item.pricingMode === "weight") {
    return item.weight > 0 && item.weightPrice > 0;
  }

  return item.quantity > 0 && item.unitPrice > 0;
}

function finishShopping() {
  if (!state.current.length) {
    return;
  }

  const dates = state.current.map((item) => item.date).sort();
  state.shops.unshift({
    id: crypto.randomUUID(),
    date: dates[dates.length - 1] || new Date().toISOString().slice(0, 10),
    items: state.current,
    total: sum(state.current, "price"),
  });
  state.current = [];
  persist();
  render();
}

function clearData() {
  if (!confirm("Clear all products, price history and current shopping?")) {
    return;
  }
  state.current = [];
  state.shops = [];
  state.products = {};
  persist();
  render();
}

function exportData() {
  const file = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `grocery-values-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importData(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  try {
    const imported = JSON.parse(await file.text());
    state.current = Array.isArray(imported.current) ? imported.current : [];
    state.shops = Array.isArray(imported.shops) ? imported.shops : [];
    state.products = imported.products || {};
    state.currency = imported.currency || defaultCurrency();
    els.currencySelect.value = state.currency;
    money = createMoneyFormatter();
    persist();
    render();
  } catch {
    alert("That file could not be imported.");
  } finally {
    event.target.value = "";
  }
}

function render() {
  renderSummary();
  renderCurrentList();
  renderHistoryFilter();
  renderHistory();
  renderComparisons();
  renderRecordsTabs();
}

function switchRecordsTab(tab) {
  activeRecordsTab = tab;
  renderRecordsTabs();
}

function renderRecordsTabs() {
  const isHistoryActive = activeRecordsTab === "history";
  els.historyTab.classList.toggle("is-active", isHistoryActive);
  els.comparisonTab.classList.toggle("is-active", !isHistoryActive);
  els.historyTab.setAttribute("aria-selected", String(isHistoryActive));
  els.comparisonTab.setAttribute("aria-selected", String(!isHistoryActive));
  els.historyPanel.hidden = !isHistoryActive;
  els.comparisonPanel.hidden = isHistoryActive;
}

function renderSummary() {
  const currentTotal = sum(state.current, "price");
  const previous = state.shops[0];
  const budget = Number(state.budget) || 0;
  const isOverBudget = budget > 0 && currentTotal > budget;

  els.currentTotal.textContent = money.format(currentTotal);
  els.itemCount.textContent = state.current.length;
  els.budgetInput.value = budget || "";
  els.budgetStatus.textContent = budget
    ? budgetStatusText(currentTotal, budget)
    : "Sem orçamento";
  els.budgetCard.classList.toggle("is-over-budget", isOverBudget);
  els.currentTotal.classList.toggle("is-over-budget", isOverBudget);

  if (!previous || !state.current.length) {
    els.comparisonTotal.textContent = previous ? "Adicione itens" : "Sem histórico";
    els.comparisonTotal.className = "";
    return;
  }

  const delta = currentTotal - previous.total;
  els.comparisonTotal.textContent = formatDelta(delta);
  els.comparisonTotal.className = delta > 0 ? "trend-up" : "trend-down";
}

function updateBudget() {
  state.budget = Number(els.budgetInput.value) || 0;
  persist();
  renderSummary();
}

function updateLowestPrice() {
  const reference = page.readItemForm();
  if (!reference.barcode && !reference.name) {
    els.lowestPriceValue.textContent = "Sem histórico";
    els.lowestPriceCard.classList.remove("has-price", "is-higher", "is-lowest");
    return;
  }

  const lowest = findLowestPrice(reference);
  const current = Number(reference.price) || 0;

  if (!lowest) {
    els.lowestPriceValue.textContent = "Sem histórico";
    els.lowestPriceCard.classList.remove("has-price", "is-higher", "is-lowest");
    return;
  }

  els.lowestPriceValue.textContent = `${money.format(lowest.price)} em ${formatDate(lowest.date)}`;
  els.lowestPriceCard.classList.add("has-price");
  els.lowestPriceCard.classList.toggle("is-higher", current > lowest.price);
  els.lowestPriceCard.classList.toggle("is-lowest", current > 0 && current <= lowest.price);
}

function findLowestPrice(reference) {
  const matches = allItems()
    .filter((item) => isSameProduct(item, reference))
    .filter((item) => Number(item.price) > 0);

  if (!matches.length) {
    return null;
  }

  return matches.reduce((lowest, item) => (Number(item.price) < Number(lowest.price) ? item : lowest));
}

function isSameProduct(item, reference) {
  if (reference.barcode && item.barcode) {
    return item.barcode === reference.barcode;
  }

  return (
    reference.name &&
    item.name &&
    item.name.trim().toLowerCase() === reference.name.trim().toLowerCase()
  );
}

function budgetStatusText(currentTotal, budget) {
  if (currentTotal > budget) {
    return `${money.format(currentTotal - budget)} acima do orçamento`;
  }

  return `${money.format(budget - currentTotal)} disponível`;
}

function renderCurrentList() {
  els.currentList.innerHTML = state.current
    .map((item) => {
      const previous = findPreviousItem(item);
      const delta = previous ? unitPrice(item) - unitPrice(previous) : null;
      return `
        <article class="item-row">
          <div>
            <div class="item-title">
              ${escapeHtml(item.name)}
              ${item.barcode ? `<span class="badge">${escapeHtml(item.barcode)}</span>` : ""}
            </div>
            <div class="meta">
              ${item.brand ? `<span>${escapeHtml(item.brand)}</span>` : ""}
              ${item.store ? `<span>${escapeHtml(item.store)}</span>` : ""}
              <span>${pricingSummary(item)}</span>
              <span>${formatDate(item.date)}</span>
              ${delta === null ? "<span>No past price</span>" : `<span class="${delta > 0 ? "trend-up" : "trend-down"}">${formatDelta(delta)}/${escapeHtml(item.unit)} vs last</span>`}
            </div>
          </div>
          <div>
            <div class="price">${money.format(item.price)}</div>
            <div class="row-actions">
              <button type="button" title="Edit item" aria-label="Edit ${escapeHtml(item.name)}" onclick="editItem('${item.id}')">✎</button>
              <button type="button" title="Remove item" aria-label="Remove ${escapeHtml(item.name)}" onclick="removeItem('${item.id}')">×</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderHistoryFilter() {
  const selected = els.historyFilter.value;
  const products = [...new Set(allItems().map((item) => item.name))].sort();
  els.historyFilter.innerHTML = `<option value="">All products</option>${products
    .map((product) => `<option value="${escapeHtml(product)}">${escapeHtml(product)}</option>`)
    .join("")}`;
  els.historyFilter.value = products.includes(selected) ? selected : "";
}

function renderHistory() {
  const selected = els.historyFilter.value;
  const items = allItems()
    .filter((item) => !selected || item.name === selected)
    .sort((a, b) => b.date.localeCompare(a.date));

  els.historyList.innerHTML = items
    .map(
      (item) => `
      <article class="history-row">
        <div>
          <div class="history-title">${escapeHtml(item.name)}</div>
          <div class="meta">
            ${item.brand ? `<span>${escapeHtml(item.brand)}</span>` : ""}
            ${item.store ? `<span>${escapeHtml(item.store)}</span>` : ""}
            <span>${pricingSummary(item)}</span>
            <span>${formatDate(item.date)}</span>
          </div>
        </div>
        <div class="price">${money.format(item.price)}</div>
      </article>
    `,
    )
    .join("");
}

function renderComparisons() {
  els.comparisonList.innerHTML = state.shops
    .map((shop, index) => {
      const previous = state.shops[index + 1];
      const delta = previous ? shop.total - previous.total : null;
      return `
        <article class="comparison-row">
          <div>
            <div class="history-title">Shopping on ${formatDate(shop.date)}</div>
            <div class="meta">
              <span>${shop.items.length} items</span>
              ${delta === null ? "<span>First saved shop</span>" : `<span class="${delta > 0 ? "trend-up" : "trend-down"}">${formatDelta(delta)} vs previous</span>`}
            </div>
          </div>
          <div class="price">${money.format(shop.total)}</div>
        </article>
      `;
    })
    .join("");
}

function editItem(id) {
  const item = state.current.find((entry) => entry.id === id);
  if (!item) {
    return;
  }
  page.fillItemForm(item);
  updateLowestPrice();
}

function removeItem(id) {
  state.current = state.current.filter((item) => item.id !== id);
  persist();
  render();
}

function findPreviousItem(item) {
  return allItems().find((entry) => {
    if (item.barcode && entry.barcode) {
      return entry.barcode === item.barcode;
    }
    return entry.name.toLowerCase() === item.name.toLowerCase();
  });
}

function allItems() {
  return state.shops.flatMap((shop) => shop.items);
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
}

function unitPrice(item) {
  if (item.pricingMode === "weight" && item.weight) {
    return Number(item.weightPrice || 0);
  }

  const quantity = Number(item.quantity) || 1;
  return Number(item.price || 0) / quantity;
}

function pricingSummary(item) {
  const unit = escapeHtml(item.unit);

  if (item.pricingMode === "weight") {
    return `${formatNumber(item.weight)} ${unit} x ${money.format(Number(item.weightPrice || 0))}/${unit}`;
  }

  return `${formatNumber(item.quantity)} x ${money.format(unitPrice(item))}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(Number(value || 0));
}

function formatDelta(value) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${money.format(value)}`;
}

function formatDate(date) {
  if (!date) {
    return "";
  }
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(new Date(`${date}T00:00:00`));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.editItem = editItem;
window.removeItem = removeItem;

function GroceryPageObject() {
  const elements = {
    video: document.querySelector("#cameraPreview"),
    placeholder: document.querySelector("#scannerPlaceholder"),
    scanBtn: document.querySelector("#scanBtn"),
    stopScanBtn: document.querySelector("#stopScanBtn"),
    barcodePhotoInput: document.querySelector("#barcodePhotoInput"),
    barcodeInput: document.querySelector("#barcodeInput"),
    lookupBtn: document.querySelector("#lookupBtn"),
    lookupStatus: document.querySelector("#lookupStatus"),
    form: document.querySelector("#itemForm"),
    editingId: document.querySelector("#editingId"),
    productName: document.querySelector("#productName"),
    brandName: document.querySelector("#brandName"),
    storeName: document.querySelector("#storeName"),
    quantity: document.querySelector("#quantity"),
    pricingMode: document.querySelector("#pricingMode"),
    unit: document.querySelector("#unit"),
    unitPrice: document.querySelector("#unitPrice"),
    weight: document.querySelector("#weight"),
    weightPrice: document.querySelector("#weightPrice"),
    price: document.querySelector("#price"),
    lowestPriceCard: document.querySelector("#lowestPriceCard"),
    lowestPriceValue: document.querySelector("#lowestPriceValue"),
    purchaseDate: document.querySelector("#purchaseDate"),
    currentTotal: document.querySelector("#currentTotal"),
    budgetInput: document.querySelector("#budgetInput"),
    budgetCard: document.querySelector("#budgetCard"),
    budgetStatus: document.querySelector("#budgetStatus"),
    itemCount: document.querySelector("#itemCount"),
    comparisonTotal: document.querySelector("#comparisonTotal"),
    currentList: document.querySelector("#currentList"),
    finishShoppingBtn: document.querySelector("#finishShoppingBtn"),
    historyFilter: document.querySelector("#historyFilter"),
    historyTab: document.querySelector("#historyTab"),
    comparisonTab: document.querySelector("#comparisonTab"),
    historyPanel: document.querySelector("#historyPanel"),
    comparisonPanel: document.querySelector("#comparisonPanel"),
    historyList: document.querySelector("#historyList"),
    comparisonList: document.querySelector("#comparisonList"),
    clearDataBtn: document.querySelector("#clearDataBtn"),
    exportBtn: document.querySelector("#exportBtn"),
    importFile: document.querySelector("#importFile"),
    currencySelect: document.querySelector("#currencySelect"),
  };

  function setInitialValues(currency) {
    elements.purchaseDate.valueAsDate = new Date();
    elements.currencySelect.value = currency;
    elements.stopScanBtn.disabled = true;
    syncPriceFields();
    setCameraActive(false);
  }

  function readItemForm() {
    const pricingMode = elements.pricingMode.value;
    const quantity = Number(elements.quantity.value);
    const unitPrice = Number(elements.unitPrice.value);
    const weight = Number(elements.weight.value);
    const weightPrice = Number(elements.weightPrice.value);

    return {
      id: elements.editingId.value || crypto.randomUUID(),
      barcode: elements.barcodeInput.value.trim(),
      name: elements.productName.value.trim(),
      brand: elements.brandName.value.trim(),
      store: elements.storeName.value.trim(),
      quantity,
      pricingMode,
      unit: elements.unit.value,
      unitPrice,
      weight,
      weightPrice,
      price: calculateTotal(),
      date: elements.purchaseDate.value || new Date().toISOString().slice(0, 10),
    };
  }

  function resetItemForm() {
    elements.form.reset();
    elements.editingId.value = "";
    elements.purchaseDate.valueAsDate = new Date();
    elements.quantity.value = "1";
    elements.pricingMode.value = "unit";
    syncPriceFields();
  }

  function fillItemForm(item) {
    elements.editingId.value = item.id;
    elements.barcodeInput.value = item.barcode || "";
    elements.productName.value = item.name;
    elements.brandName.value = item.brand || "";
    elements.storeName.value = item.store || "";
    elements.quantity.value = item.quantity || "1";
    elements.pricingMode.value = item.pricingMode || "unit";
    elements.unit.value = item.unit;
    elements.unitPrice.value = item.unitPrice || legacyUnitPrice(item) || "";
    elements.weight.value = item.weight || "";
    elements.weightPrice.value = item.weightPrice || "";
    elements.price.value = item.price || calculateTotal();
    elements.purchaseDate.value = item.date || "";
    syncPriceFields();
    elements.productName.focus();
  }

  function setCameraActive(isActive) {
    elements.video.closest(".scanner").classList.toggle("is-active", isActive);
    elements.placeholder.style.display = isActive ? "none" : "grid";
    elements.scanBtn.disabled = isActive;
    elements.stopScanBtn.disabled = !isActive;
  }

  function setKnownProduct(knownProduct) {
    if (knownProduct) {
      elements.productName.value = knownProduct.name;
      elements.brandName.value = knownProduct.brand || "";
      elements.unit.value = knownProduct.unit;
      elements.storeName.value = knownProduct.lastStore || "";
    } else {
      elements.productName.value = "";
      elements.brandName.value = "";
    }
    elements.productName.focus();
  }

  function setRecognizedProduct(product) {
    elements.productName.value = product.name;
    elements.brandName.value = product.brand || "";
    elements.unit.value = product.unit || elements.unit.value;
    elements.pricingMode.value = product.pricingMode || "unit";

    if (product.price) {
      if (elements.pricingMode.value === "weight") {
        elements.weightPrice.value = product.price;
      } else {
        elements.unitPrice.value = product.price;
      }
    }

    if (product.quantity) {
      elements.unit.value = inferUnit(product.quantity);
    }

    syncPriceFields();
    elements.productName.focus();
  }

  function setLookupLoading(isLoading) {
    elements.lookupBtn.disabled = isLoading;
    elements.barcodeInput.disabled = isLoading;
  }

  function setLookupStatus(message, tone = "") {
    elements.lookupStatus.textContent = message;
    elements.lookupStatus.dataset.tone = tone;
  }

  function calculateTotal() {
    const pricingMode = elements.pricingMode.value;
    const quantity = Number(elements.quantity.value) || 0;
    const unitPrice = Number(elements.unitPrice.value) || 0;
    const weight = Number(elements.weight.value) || 0;
    const weightPrice = Number(elements.weightPrice.value) || 0;

    if (pricingMode === "weight") {
      return roundCurrency(weight * weightPrice);
    }

    return roundCurrency(quantity * unitPrice);
  }

  function syncPriceFields() {
    const isWeightPricing = elements.pricingMode.value === "weight";
    if (isWeightPricing && ["unit", "pack"].includes(elements.unit.value)) {
      elements.unit.value = "kg";
    }
    document.querySelectorAll(".weight-field").forEach((field) => {
      field.hidden = !isWeightPricing;
    });
    elements.quantity.closest("label").hidden = isWeightPricing;
    elements.unitPrice.closest("label").hidden = isWeightPricing;
    elements.quantity.required = !isWeightPricing;
    elements.unitPrice.required = !isWeightPricing;
    elements.weight.required = isWeightPricing;
    elements.weightPrice.required = isWeightPricing;
    elements.price.value = calculateTotal().toFixed(2);
    if (typeof updateLowestPrice === "function") {
      updateLowestPrice();
    }
  }

  function roundCurrency(value) {
    return Math.round(value * 100) / 100;
  }

  function legacyUnitPrice(item) {
    const quantity = Number(item.quantity) || 1;
    return Number(item.price || 0) / quantity;
  }

  function inferUnit(quantity) {
    const normalized = quantity.toLowerCase();
    if (normalized.includes("kg")) return "kg";
    if (normalized.includes("g")) return "g";
    if (normalized.includes("ml")) return "ml";
    if (normalized.includes("l")) return "l";
    return elements.unit.value;
  }

  return {
    elements,
    calculateTotal,
    fillItemForm,
    readItemForm,
    resetItemForm,
    setCameraActive,
    setInitialValues,
    setKnownProduct,
    setLookupLoading,
    setLookupStatus,
    setRecognizedProduct,
    syncPriceFields,
  };
}
