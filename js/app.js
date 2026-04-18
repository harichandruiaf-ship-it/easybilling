import { initializeApp } from "firebase/app";
import { firebaseConfig } from "../firebase-config.js";
import {
  initAuthServices,
  onUserChanged,
  signUpUser,
  signInUser,
  signOutUser,
  sendPasswordResetToEmail,
  loadUserSettings,
  saveUserSettings,
} from "./auth.js";
import {
  saveInvoice,
  updateInvoice,
  deleteInvoice,
  deleteInvoiceDocumentOnly,
  listInvoicesForUser,
  listDeletedInvoicesForUser,
  getInvoiceById,
  getDeletedInvoiceArchiveById,
  invoiceViewModelFromDeletedArchive,
  formatInvoiceDate,
  formatInvoiceDateTime,
  computeInvoicePaymentAmounts,
  round2,
  enumerateIndiaFYLabels,
  isInvoiceFullyPaidByAmounts,
} from "./invoices.js";
import {
  recordCustomerPayment,
  listMoneyTransactionsForCustomer,
  listOpenInvoicesForPaymentSelect,
  mergeOpeningRowIntoPaymentSelect,
  revokeCustomerPayment,
  findLatestActiveStandalonePayment,
  todayIsoDate,
} from "./payments.js";
import { paginateSlice, mountPaginationBar } from "./pagination.js";
import { initInvoiceForm, isValidGstinOptional, isValidPanOptional } from "./invoice-form.js";
import {
  renderInvoiceDocument,
  printInvoice,
  prepareInvoiceStampImagesForPdf,
  applyCachedStampPngToStampImages,
} from "./invoice-pdf.js";
import { shouldForceLoginView, canAccessInvoice } from "./auth-guard.js";
import {
  listCustomers,
  addCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerById,
} from "./customers.js";
import { APP_VERSION } from "./app-version.js";
import { withLoading, showLoading, hideLoading } from "./loading.js";
import { showToast, showValidationToast } from "./toast.js";
import {
  mountDashboard,
  closeDashboardDetail,
  closeDashboardQuickOrderModal,
  invalidateDashboardCachesForDevReset,
} from "./dashboard.js";
import { setupDevAccountResetUI } from "./dev-account-reset.js";
import {
  getQuickOrderById,
  listOpenQuickOrders,
  addQuickOrder,
  updateQuickOrder,
  deleteQuickOrder,
  markQuickOrderDone,
} from "./quick-orders.js";

const app = initializeApp(firebaseConfig);
const { auth, db } = initAuthServices(app);

/** Lazy-loaded so a bad/failed `reports.js` fetch does not block the whole app. */
let reportsModule = null;
async function loadReportsModule() {
  if (!reportsModule) {
    try {
      reportsModule = await import("./reports.js");
    } catch (ex) {
      console.error("[loadReportsModule]", ex);
      throw new Error(
        ex?.message?.includes("Failed to fetch") || ex?.name === "TypeError"
          ? "Could not load Reports (check network or refresh)."
          : ex?.message || "Could not load Reports."
      );
    }
  }
  return reportsModule;
}

/** Shown in the browser tab; keep in sync with visible screen names. */
const APP_NAME = "Easy Billing";

const bootEl = document.getElementById("boot-loading");
const navMain = document.getElementById("nav-main");

const views = {
  login: document.getElementById("view-login"),
  dashboard: document.getElementById("view-dashboard"),
  reports: document.getElementById("view-reports"),
  quickOrders: document.getElementById("view-quick-orders"),
  settings: document.getElementById("view-settings"),
  create: document.getElementById("view-create"),
  customers: document.getElementById("view-customers"),
  history: document.getElementById("view-history"),
  invoice: document.getElementById("view-invoice"),
};

/** Full invoice rows for history filtering (cleared when leaving / reload). */
let historyCache = null;
let historyPageIndex = 0;
const HISTORY_PAGE_SIZE = 25;

let customersListPageIndex = 0;
let customersListSearchKey = "";
const CUSTOMERS_PAGE_SIZE = 25;

let qoListPageIndex = 0;
const QO_PAGE_SIZE = 15;
/** Open quick orders for the Quick orders page (paginated client-side). */
let quickOrdersOpenCache = [];

let custInvModalRows = [];
let custInvModalPageIndex = 0;
const CUST_INV_MODAL_PAGE_SIZE = 12;

let payTxModalList = [];
let payTxModalPageIndex = 0;
const PAY_TX_PAGE_SIZE = 12;
let historyFiltersWired = false;
let historyFilterDebounce = null;
let historySortWired = false;
/** @type {"date"|"amount"|"number"|"customer"|"status"} */
let historySortBy = "date";
/** @type {"asc"|"desc"} */
let historySortDir = "desc";

let customersSortWired = false;
/** @type {"name"|"outstanding"} */
let customersSortBy = "name";
/** @type {"asc"|"desc"} */
let customersSortDir = "asc";

function rowInvoiceDate(row) {
  const v = row.date;
  if (v) {
    if (typeof v.toDate === "function") return v.toDate();
    if (v instanceof Date) return v;
  }
  if (row.isDeleted && row.deletedAt) {
    const d = row.deletedAt;
    if (typeof d.toDate === "function") return d.toDate();
  }
  return null;
}

function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function parseLocalYmd(s) {
  if (!s || typeof s !== "string") return null;
  const p = s.split("-").map(Number);
  if (p.length !== 3 || p.some((n) => Number.isNaN(n))) return null;
  return new Date(p[0], p[1] - 1, p[2]);
}

/** Local calendar yyyy-mm-dd for filenames (avoid UTC shift from toISOString). */
function formatLocalYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Human-readable payment method for ledger / recent transactions. */
function paymentMethodLabel(code) {
  const m = {
    credit_sale: "Credit sale",
    cash: "Cash",
    upi: "UPI",
    bank_transfer: "Bank transfer",
    cheque: "Cheque",
    card: "Card",
    other: "Other",
  };
  const k = String(code ?? "").trim();
  return m[k] || (k ? k.replace(/_/g, " ") : "");
}

function historyDateRange(criteria) {
  const preset = criteria.preset || "all";
  const now = new Date();
  const endToday = endOfLocalDay(now);
  if (preset === "all") return null;
  if (preset === "custom") {
    let a = parseLocalYmd(criteria.dateFrom);
    let b = parseLocalYmd(criteria.dateTo);
    if (!a || !b) return null;
    if (a.getTime() > b.getTime()) {
      const t = a;
      a = b;
      b = t;
    }
    return { start: startOfLocalDay(a), end: endOfLocalDay(b) };
  }
  if (preset === "today") return { start: startOfLocalDay(now), end: endToday };
  if (preset === "7d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 7);
    return { start: startOfLocalDay(s), end: endToday };
  }
  if (preset === "30d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 30);
    return { start: startOfLocalDay(s), end: endToday };
  }
  if (preset === "90d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 90);
    return { start: startOfLocalDay(s), end: endToday };
  }
  if (preset === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: startOfLocalDay(s), end: endToday };
  }
  return null;
}

function normLower(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function normTaxId(s) {
  return String(s ?? "")
    .replace(/\s/g, "")
    .toUpperCase();
}

function includesLoose(hay, needle) {
  if (!needle) return true;
  return normLower(hay).includes(normLower(needle));
}

function includesTaxId(hay, needle) {
  if (!needle) return true;
  return normTaxId(hay).includes(normTaxId(needle));
}

/** Multi-word AND: every token must appear as substring in the normalized blob. */
function matchesSearchTokens(blob, raw) {
  const q = normLower(raw).trim();
  if (!q) return true;
  const b = normLower(blob);
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((t) => b.includes(t));
}

function customerSearchBlob(row) {
  return [
    row.name,
    row.phone,
    row.address,
    row.gstin,
    row.buyerPan,
    row.placeOfSupply,
    row.buyerContact,
    row.buyerEmail,
    row.stateName,
    row.stateCode,
    row.consigneeName,
    row.consigneeAddress,
    row.consigneeGstin,
  ].join(" ");
}

function historyQuickSearchBlob(row) {
  return [
    row.invoiceNumber,
    row.accountPeriodLabel,
    row.customerName,
    row.consigneeName,
    row.referenceNo,
    row.buyerGstin,
    row.buyerPan,
    row.placeOfSupply,
    row.buyerAddress,
    row.destination,
    row.deliveryNote,
    row.paymentStatus,
    row.paymentMethod,
    row.hsnSearchBlob,
    row.sellerGstin,
    row.sellerPan,
    row.itemsSummary || "",
    row.originalInvoiceId || "",
    row.isDeleted ? "deleted removed" : "",
  ].join(" ");
}

function filterHistoryRows(rows, c) {
  const range = historyDateRange(c);
  return rows.filter((row) => {
    const d = rowInvoiceDate(row);
    if (range) {
      if (!d) return false;
      if (d.getTime() < range.start.getTime() || d.getTime() > range.end.getTime()) return false;
    }
    if (!matchesSearchTokens(historyQuickSearchBlob(row), c.quickSearch || "")) return false;
    if (c.customer) {
      const target = normLower(c.customer);
      const buyer = normLower(row.customerName || "");
      const consignee = normLower(row.consigneeName || "");
      if (buyer !== target && consignee !== target) return false;
    }
    const min = c.amountMin;
    const max = c.amountMax;
    if (min !== "" && min != null && Number.isFinite(Number(min)) && row.total < Number(min)) return false;
    if (max !== "" && max != null && Number.isFinite(Number(max)) && row.total > Number(max)) return false;
    if (c.paymentStatus) {
      if (c.paymentStatus === "__deleted__") {
        if (!row.isDeleted) return false;
      } else {
        if (row.isDeleted) return false;
        if (String(row.paymentStatus || "") !== c.paymentStatus) return false;
      }
    }
    if (c.paymentMethod && String(row.paymentMethod || "") !== c.paymentMethod) return false;
    const ap = (c.accountPeriod || "").trim();
    if (ap && String(row.accountPeriodLabel || "").trim() !== ap) return false;
    if (c.mode === "advanced") {
      if (!includesLoose(row.invoiceNumber, c.invoiceNo)) return false;
      if (!includesTaxId(row.buyerGstin, c.buyerGstin)) return false;
      if (!includesTaxId(row.buyerPan, c.buyerPan)) return false;
      if (!includesTaxId(row.sellerGstin, c.sellerGstin)) return false;
      if (!includesTaxId(row.sellerPan, c.sellerPan)) return false;
      if (!includesLoose(row.placeOfSupply, c.place)) return false;
      const locBlob = [row.buyerAddress, row.destination].join(" ");
      if (!includesLoose(locBlob, c.location)) return false;
      const transportBlob = [row.dispatchedThrough, row.motorVehicleNo, row.ewayBillNo, row.billOfLadingNo].join(" ");
      if (!includesLoose(transportBlob, c.transport)) return false;
      if (!includesLoose(row.referenceNo, c.reference)) return false;
      if (!includesLoose(row.hsnSearchBlob, c.hsn)) return false;
      if (!includesLoose(row.deliveryNote, c.deliveryNote)) return false;
    }
    return true;
  });
}

function readHistoryCriteria() {
  const v = (id) => document.getElementById(id)?.value?.trim() ?? "";
  return {
    mode: document.getElementById("hist-filter-mode")?.value || "normal",
    preset: document.getElementById("hist-date-preset")?.value || "all",
    dateFrom: document.getElementById("hist-date-from")?.value || "",
    dateTo: document.getElementById("hist-date-to")?.value || "",
    invoiceNo: v("hist-invoice-no"),
    customer: document.getElementById("hist-customer")?.value || "",
    buyerGstin: v("hist-buyer-gstin"),
    buyerPan: v("hist-buyer-pan"),
    sellerGstin: v("hist-seller-gstin"),
    sellerPan: v("hist-seller-pan"),
    place: v("hist-place"),
    location: v("hist-location"),
    transport: v("hist-transport"),
    reference: v("hist-reference"),
    hsn: v("hist-hsn"),
    deliveryNote: v("hist-delivery-note"),
    amountMin: document.getElementById("hist-amount-min")?.value ?? "",
    amountMax: document.getElementById("hist-amount-max")?.value ?? "",
    paymentStatus: document.getElementById("hist-payment-status")?.value || "",
    paymentMethod: document.getElementById("hist-payment-method")?.value || "",
    accountPeriod: document.getElementById("hist-account-period")?.value || "",
    quickSearch: v("hist-search"),
  };
}

function clearHistoryFiltersForm() {
  const mode = document.getElementById("hist-filter-mode");
  if (mode) mode.value = "normal";
  const preset = document.getElementById("hist-date-preset");
  if (preset) preset.value = "all";
  const ids = [
    "hist-date-from",
    "hist-date-to",
    "hist-invoice-no",
    "hist-customer",
    "hist-buyer-gstin",
    "hist-buyer-pan",
    "hist-seller-gstin",
    "hist-seller-pan",
    "hist-place",
    "hist-location",
    "hist-transport",
    "hist-reference",
    "hist-hsn",
    "hist-delivery-note",
    "hist-amount-min",
    "hist-amount-max",
    "hist-payment-status",
    "hist-payment-method",
    "hist-account-period",
    "hist-search",
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const customer = document.getElementById("hist-customer");
  if (customer) customer.value = "";
  toggleHistoryAdvancedVisibility();
  toggleHistoryCustomDateVisibility();
}

function toggleHistoryCustomDateVisibility() {
  const preset = document.getElementById("hist-date-preset")?.value;
  const show = preset === "custom";
  document.getElementById("hist-date-from-wrap")?.classList.toggle("hidden", !show);
  document.getElementById("hist-date-to-wrap")?.classList.toggle("hidden", !show);
}

function toggleHistoryAdvancedVisibility() {
  const mode = document.getElementById("hist-filter-mode")?.value || "normal";
  const adv = document.getElementById("history-advanced-fields");
  adv?.classList.toggle("hidden", mode !== "advanced");
}

function populateHistoryAccountPeriodSelect() {
  const sel = document.getElementById("hist-account-period");
  if (!sel) return;
  const prev = sel.value;
  const labels = enumerateIndiaFYLabels(12);
  sel.innerHTML = `<option value="">All account periods</option>${labels
    .map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`)
    .join("")}`;
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function populateHistoryCustomerOptions(customers = [], rows = []) {
  const sel = document.getElementById("hist-customer");
  if (!sel) return;
  const names = new Set();
  customers.forEach((c) => {
    const n = String(c?.name || "").trim();
    if (n) names.add(n);
  });
  rows.forEach((r) => {
    const a = String(r.customerName || "").trim();
    const b = String(r.consigneeName || "").trim();
    if (a) names.add(a);
    if (b) names.add(b);
  });
  const sorted = Array.from(names).sort((a, b) => a.localeCompare(b, "en-IN"));
  const prev = sel.value;
  sel.innerHTML = `<option value="">All customers</option>${sorted
    .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
    .join("")}`;
  if (prev && sorted.includes(prev)) sel.value = prev;
}

function scheduleHistoryFilterApply() {
  if (!historyCache) return;
  clearTimeout(historyFilterDebounce);
  historyFilterDebounce = setTimeout(() => {
    historyFilterDebounce = null;
    applyHistoryFilters();
  }, 280);
}

function applyHistoryFiltersNow() {
  if (!historyCache) return;
  clearTimeout(historyFilterDebounce);
  historyFilterDebounce = null;
  applyHistoryFilters();
}

function wireHistoryFilters() {
  if (historyFiltersWired) return;
  historyFiltersWired = true;
  const form = document.getElementById("form-history-filters");
  const btnClear = document.getElementById("btn-history-clear");

  form?.addEventListener("change", (e) => {
    const t = e.target;
    if (t?.id === "hist-date-preset") toggleHistoryCustomDateVisibility();
    if (t?.id === "hist-filter-mode") toggleHistoryAdvancedVisibility();
    applyHistoryFiltersNow();
  });

  form?.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !form.contains(t)) return;
    if (t.id === "hist-date-preset" || t.id === "hist-filter-mode") return;
    scheduleHistoryFilterApply();
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    applyHistoryFiltersNow();
  });
  btnClear?.addEventListener("click", () => {
    clearHistoryFiltersForm();
    applyHistoryFiltersNow();
  });
  toggleHistoryAdvancedVisibility();
  toggleHistoryCustomDateVisibility();
}

/** True when invoice is fully settled: status paid and/or amounts match allocation logic (warn before edit). */
function isInvoiceStatusPaid(inv) {
  const st = String(inv?.paymentStatus || "").trim().toLowerCase();
  if (st === "paid") return true;
  return isInvoiceFullyPaidByAmounts(inv);
}

const PAID_INVOICE_EDIT_WARNING =
  "This invoice is marked as paid. Please do not change line items, amounts, or payment details on a paid invoice — doing so can create conflicts with recorded payments and customer balances.\n\nClick OK to open the editor anyway, or Cancel to return to the invoice view.";

function historyPaymentStatusBadge(status, row) {
  if (row?.isDeleted) {
    return { label: "Deleted", mod: "history-inv-status--deleted" };
  }
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") {
    return { label: "Paid", mod: "history-inv-status--paid" };
  }
  if (s === "partial") {
    return { label: "Partial", mod: "history-inv-status--partial" };
  }
  if (s === "unpaid") {
    return { label: "Unpaid", mod: "history-inv-status--unpaid" };
  }
  if (s === "opening") {
    return { label: "Opening", mod: "history-inv-status--opening" };
  }
  return { label: "Unknown", mod: "history-inv-status--unknown" };
}

function historyRowDateMillis(row) {
  const d = rowInvoiceDate(row);
  return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
}

/** Lower value sorts before higher in ascending status order. */
function historyStatusSortKey(row) {
  if (row?.isDeleted) return 0;
  const s = String(row?.paymentStatus || "").trim().toLowerCase();
  if (s === "unpaid") return 1;
  if (s === "partial") return 2;
  if (s === "paid") return 3;
  if (s === "opening") return 4;
  return 5;
}

function compareHistoryRows(a, b) {
  const mul = historySortDir === "asc" ? 1 : -1;
  let cmp = 0;
  switch (historySortBy) {
    case "amount":
      cmp = round2(Number(a.total) || 0) - round2(Number(b.total) || 0);
      break;
    case "number": {
      const na = String(a.invoiceNumber || "").trim();
      const nb = String(b.invoiceNumber || "").trim();
      cmp = na.localeCompare(nb, undefined, { numeric: true, sensitivity: "base" });
      break;
    }
    case "customer":
      cmp = normLower(a.customerName).localeCompare(normLower(b.customerName), undefined, { sensitivity: "base" });
      break;
    case "status": {
      cmp = historyStatusSortKey(a) - historyStatusSortKey(b);
      if (cmp === 0) {
        cmp = normLower(a.paymentStatus).localeCompare(normLower(b.paymentStatus), undefined, { sensitivity: "base" });
      }
      break;
    }
    case "date":
    default:
      cmp = historyRowDateMillis(a) - historyRowDateMillis(b);
      break;
  }
  if (cmp !== 0) return mul * cmp;
  return historyRowDateMillis(b) - historyRowDateMillis(a);
}

function sortHistoryFilteredRows(rows) {
  const out = [...rows];
  out.sort(compareHistoryRows);
  return out;
}

function historySortDirLabel() {
  const asc = historySortDir === "asc";
  switch (historySortBy) {
    case "date":
      return asc ? "Oldest first" : "Newest first";
    case "amount":
      return asc ? "Amount low → high" : "Amount high → low";
    case "number":
      return asc ? "Invoice no. A → Z" : "Invoice no. Z → A";
    case "customer":
      return asc ? "Customer A → Z" : "Customer Z → A";
    case "status":
      return asc ? "Unpaid → paid" : "Paid → unpaid";
    default:
      return asc ? "Ascending" : "Descending";
  }
}

function syncHistorySortUi() {
  const sel = document.getElementById("hist-sort-by");
  const label = document.getElementById("hist-sort-dir-label");
  if (sel) sel.value = historySortBy;
  if (label) label.textContent = historySortDirLabel();
}

function wireHistorySortControls() {
  if (historySortWired) return;
  historySortWired = true;
  const sel = document.getElementById("hist-sort-by");
  const btn = document.getElementById("hist-sort-dir");
  sel?.addEventListener("change", () => {
    historySortBy = sel.value || "date";
    historyPageIndex = 0;
    syncHistorySortUi();
    renderHistoryPage();
  });
  btn?.addEventListener("click", () => {
    historySortDir = historySortDir === "asc" ? "desc" : "asc";
    historyPageIndex = 0;
    syncHistorySortUi();
    renderHistoryPage();
  });
  syncHistorySortUi();
}

function compareCustomerRows(a, b) {
  const mul = customersSortDir === "asc" ? 1 : -1;
  if (customersSortBy === "outstanding") {
    const da = round2(Number(a.outstandingBalance) || 0);
    const db = round2(Number(b.outstandingBalance) || 0);
    if (da !== db) return mul * (da - db);
  }
  const na = normLower(a.name);
  const nb = normLower(b.name);
  return mul * na.localeCompare(nb, undefined, { sensitivity: "base" });
}

function sortCustomerRows(rows) {
  const out = [...rows];
  out.sort(compareCustomerRows);
  return out;
}

function customersSortDirLabel() {
  if (customersSortBy === "outstanding") {
    return customersSortDir === "asc" ? "Outstanding low → high" : "Outstanding high → low";
  }
  return customersSortDir === "asc" ? "Name A → Z" : "Name Z → A";
}

function syncCustomersSortUi() {
  const sel = document.getElementById("customers-sort-by");
  const label = document.getElementById("customers-sort-dir-label");
  if (sel) sel.value = customersSortBy;
  if (label) label.textContent = customersSortDirLabel();
}

function wireCustomersSortControls() {
  if (customersSortWired) return;
  customersSortWired = true;
  const sel = document.getElementById("customers-sort-by");
  const btn = document.getElementById("customers-sort-dir");
  sel?.addEventListener("change", () => {
    customersSortBy = sel.value === "outstanding" ? "outstanding" : "name";
    customersSortDir = customersSortBy === "outstanding" ? "desc" : "asc";
    customersListPageIndex = 0;
    syncCustomersSortUi();
    renderCustomersListFromCache();
  });
  btn?.addEventListener("click", () => {
    customersSortDir = customersSortDir === "asc" ? "desc" : "asc";
    customersListPageIndex = 0;
    syncCustomersSortUi();
    renderCustomersListFromCache();
  });
  syncCustomersSortUi();
}

function renderHistoryPage() {
  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  const countEl = document.getElementById("history-count");
  const pagEl = document.getElementById("history-pagination");
  if (!listEl || !emptyEl) return;
  listEl.innerHTML = "";
  const cacheTotal = historyCache?.length ?? 0;
  if (!historyCache) return;
  const filtered = filterHistoryRows(historyCache, readHistoryCriteria());
  const sorted = sortHistoryFilteredRows(filtered);
  const pag = paginateSlice(sorted, historyPageIndex, HISTORY_PAGE_SIZE);
  historyPageIndex = pag.pageIndex;

  if (!sorted.length) {
    emptyEl.hidden = false;
    emptyEl.innerHTML = cacheTotal
      ? 'No invoices match your filters. Use <strong>Clear all</strong> above or adjust search and filters.'
      : 'No invoices yet. <a href="#/create" class="text-link">Create your first invoice</a>.';
    if (countEl) {
      countEl.hidden = true;
      countEl.textContent = "";
    }
    if (pagEl) {
      pagEl.innerHTML = "";
      pagEl.hidden = true;
    }
    return;
  }
  emptyEl.hidden = true;
  if (countEl) {
    countEl.hidden = false;
    if (sorted.length === cacheTotal) {
      countEl.textContent = `${cacheTotal} invoice${cacheTotal === 1 ? "" : "s"}`;
    } else {
      countEl.textContent = `${sorted.length} of ${cacheTotal} invoice${cacheTotal === 1 ? "" : "s"} match filters`;
    }
  }

  for (const row of pag.slice) {
    const li = document.createElement("li");
    if (row.isDeleted) {
      const a = document.createElement("a");
      a.href = `#/invoice-deleted/${encodeURIComponent(row.id)}`;
      a.className = "history-inv-card history-inv-card--deleted";
      const dateStr = formatInvoiceDate(row.date);
      const delStr = row.deletedAt ? formatInvoiceDateTime(row.deletedAt) : "—";
      const badge = historyPaymentStatusBadge(row.paymentStatus, row);
      const tot = Number(row.total);
      const totStr = Number.isFinite(tot) ? tot.toFixed(2) : "0.00";
      const gstin = (row.buyerGstin || "").trim();
      const sumLine = (row.itemsSummary || "").trim();
      const extra = [
        gstin ? `GSTIN ${gstin}` : "",
        sumLine ? sumLine : "",
      ]
        .filter(Boolean)
        .join(" · ");
      a.innerHTML = `<span class="history-inv-status ${badge.mod}" aria-label="Status: ${escapeHtml(badge.label)}">${escapeHtml(
        badge.label
      )}</span><span class="history-inv-main"><strong>${escapeHtml(row.invoiceNumber)}</strong> — ${escapeHtml(
        row.customerName
      )}${
        row.consigneeName && String(row.consigneeName).trim() && row.consigneeName !== row.customerName
          ? ` <span class="muted">(${escapeHtml(row.consigneeName)})</span>`
          : ""
      }</span><div class="meta"><span>Invoice date ${escapeHtml(dateStr)}</span><span>₹ ${totStr}</span></div><div class="history-inv-deleted-meta muted small">Deleted ${escapeHtml(
        delStr
      )}${extra ? ` · ${escapeHtml(extra)}` : ""}</div>`;
      li.appendChild(a);
    } else {
      const a = document.createElement("a");
      a.href = `#/invoice/${row.id}`;
      a.classList.add("history-inv-card");
      const dateStr = formatInvoiceDate(row.date);
      const badge = historyPaymentStatusBadge(row.paymentStatus, row);
      const tot = Number(row.total);
      const totStr = Number.isFinite(tot) ? tot.toFixed(2) : "0.00";
      a.innerHTML = `<span class="history-inv-status ${badge.mod}" aria-label="Payment status: ${escapeHtml(badge.label)}">${escapeHtml(badge.label)}</span><span class="history-inv-main"><strong>${escapeHtml(row.invoiceNumber)}</strong> — ${escapeHtml(row.customerName)}</span><div class="meta"><span>${escapeHtml(dateStr)}</span><span>₹ ${totStr}</span></div>`;
      li.appendChild(a);
    }
    listEl.appendChild(li);
  }

  mountPaginationBar(pagEl, {
    pageIndex: pag.pageIndex,
    pageSize: HISTORY_PAGE_SIZE,
    total: sorted.length,
    onPageChange: (i) => {
      historyPageIndex = i;
      renderHistoryPage();
    },
  });
}

function applyHistoryFilters() {
  if (!historyCache) return;
  historyPageIndex = 0;
  renderHistoryPage();
}

let currentUser = null;
let authModeSignIn = true;
let invoiceFormApi = null;

/** Form payload waiting for user to confirm in preview modal */
let pendingInvoicePayload = null;

/** When set, create flow updates this invoice instead of saving a new one */
let editingInvoiceId = null;
/** Snapshot of the invoice being edited (for preview balance math) */
let editingInvoiceSnapshot = null;

/** Set when user already confirmed PAID_INVOICE_EDIT_WARNING on the invoice view Edit link (avoid duplicate prompt in route). */
let suppressPaidInvoiceEditWarning = false;

/** Customers page: Firestore id being edited in the modal */
let editingCustomerId = null;

/** Customers page: record-payment modal target id */
let paymentCustomerId = null;

/** Full customer list for the Customers tab (client-side search). */
let customersPageCache = null;
let customersSearchWired = false;
let customersSearchDebounce = null;

/** Filled when the Customers page loads; used by the “Show invoices” modal. */
let customerInvoicesByCustomerIdCache = new Map();

/** Invoice number (or fallback) for breadcrumb on invoice view. */
let invoiceBreadcrumbLabel = null;

/** Breadcrumb state on invoice route: loading → ready | error. */
let invoiceBreadcrumbState = null;

function hideAllViews() {
  Object.values(views).forEach((el) => {
    if (el) el.hidden = true;
  });
}

function showView(name) {
  hideAllViews();
  const v = views[name];
  if (v) {
    v.hidden = false;
  } else {
    console.warn("[showView] Missing view container:", name);
    if (views.dashboard) views.dashboard.hidden = false;
  }
  document.body.classList.toggle("login-screen-active", name === "login");
}

function parseHash() {
  const raw = (window.location.hash || "#/").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const route = (parts[0] || "dashboard").toLowerCase();
  const id = parts[1] || null;
  const params = new URLSearchParams(queryPart || "");
  const customerId = params.get("customer") || null;
  const editId = (params.get("edit") || "").trim() || null;
  const quickOrderId = (params.get("quickOrder") || "").trim() || null;
  return { route, id, customerId, editId, quickOrderId };
}

function setCreatePageEditMode(isEdit, invoiceNumberHint) {
  const h1Text = document.getElementById("create-page-title-text");
  const h1 = document.getElementById("create-page-title");
  const title = isEdit ? "Edit GST invoice" : "New GST invoice";
  if (h1Text) h1Text.textContent = title;
  else if (h1) h1.textContent = title;
  const hint = document.getElementById("create-page-hint");
  if (hint) {
    hint.hidden = !isEdit;
    hint.textContent = isEdit
      ? `Editing ${invoiceNumberHint || "invoice"}. Invoice number and date are unchanged.`
      : "";
  }
  const btn = document.getElementById("btn-save-invoice");
  if (btn) btn.textContent = isEdit ? "Preview changes" : "Preview invoice";
  const ph = document.getElementById("invoice-preview-hint");
  if (ph) {
    ph.textContent = isEdit
      ? "Check changes. Saving updates the invoice and adjusts customer outstanding balance."
      : "Check all details. Invoice number and official date are assigned when you generate the invoice.";
  }
  const btnGen = document.getElementById("btn-invoice-generate");
  if (btnGen) btnGen.textContent = isEdit ? "Save changes" : "Generate invoice";
}

async function route() {
  const { route: r, id, customerId, editId, quickOrderId } = parseHash();
  if (r !== "invoice" && r !== "invoice-deleted") {
    invoiceBreadcrumbLabel = null;
    invoiceBreadcrumbState = null;
  }

  try {
    closeDashboardQuickOrderModal();
    if (r !== "reports" && reportsModule) {
      try {
        reportsModule.teardownReports();
      } catch (_) {
        /* ignore teardown if DOM/charts already gone */
      }
    }
    if (r !== "dashboard") {
      closeDashboardDetail();
    }

    if (r !== "create") {
      closeInvoicePreviewModal();
      pendingInvoicePayload = null;
      editingInvoiceId = null;
      editingInvoiceSnapshot = null;
    }

    if (r !== "customers") {
      closeCustomerEditModal();
      closeCustomerPaymentModal();
      closeCustomerInvoicesModal();
    }

    if (shouldForceLoginView(currentUser)) {
      navMain?.classList.add("hidden");
      showView("login");
      return;
    }

    navMain?.classList.remove("hidden");

    if (r === "login") {
      window.location.hash = "#/dashboard";
      return;
    }

    if (r === "settings") {
      showView("settings");
      await runRouteStep("settings", () => withLoading(() => fillSettingsForm(), "Loading settings…"));
      return;
    }

    if (r === "customers") {
      showView("customers");
      await runRouteStep("customers", () => withLoading(() => renderCustomersPage(), "Loading customers…"));
      return;
    }

    if (r === "quick-orders") {
      showView("quickOrders");
      await runRouteStep("quick-orders", () => withLoading(() => renderQuickOrdersPage(), "Loading…"));
      return;
    }

    if (r === "create") {
      showView("create");
      if (invoiceFormApi && currentUser) {
        await runRouteStep("create", () =>
          withLoading(async () => {
            hideCreateQuickOrderBanner();
            const s = await loadUserSettings(currentUser.uid);
            invoiceFormApi.setTaxRates(s.cgstPercent, s.sgstPercent);
            const list = await listCustomers(db, currentUser.uid);
            invoiceFormApi.setCustomerOptions(list);

            if (editId) {
              const inv = await getInvoiceById(db, editId);
              if (!inv || inv.userId !== currentUser.uid) {
                showToast("Invoice not found.", { type: "error" });
                editingInvoiceId = null;
                editingInvoiceSnapshot = null;
                window.location.hash = "#/history";
                return;
              }
              if (isInvoiceStatusPaid(inv)) {
                if (suppressPaidInvoiceEditWarning) {
                  suppressPaidInvoiceEditWarning = false;
                } else if (!window.confirm(PAID_INVOICE_EDIT_WARNING)) {
                  window.location.hash = `#/invoice/${encodeURIComponent(editId)}`;
                  return;
                }
              }
              editingInvoiceId = editId;
              editingInvoiceSnapshot = inv;
              const oldNet = round2(Number(inv.total) || 0) - round2(Number(inv.amountPaidOnInvoice) || 0);
              let openingBefore = null;
              if (inv.customerId) {
                try {
                  const c = await getCustomerById(db, inv.customerId);
                  const b = round2(Number(c?.outstandingBalance) || 0);
                  openingBefore = round2(b - oldNet);
                } catch (_) {
                  /* ignore customer read for opening balance */
                }
              }
              invoiceFormApi.populateFromInvoice(inv, { openingBeforeInvoice: openingBefore });
              setCreatePageEditMode(true, inv.invoiceNumber);
              hideCreateQuickOrderBanner();
            } else {
              editingInvoiceId = null;
              editingInvoiceSnapshot = null;
              setCreatePageEditMode(false);
              let loadedFromQuickOrder = false;
              let quickOrderDoc = null;
              if (quickOrderId) {
                try {
                  const qo = await getQuickOrderById(db, quickOrderId);
                  if (
                    qo &&
                    qo.userId === currentUser.uid &&
                    (qo.status || "open") === "open" &&
                    typeof invoiceFormApi.applyQuickOrderDraft === "function"
                  ) {
                    invoiceFormApi.applyQuickOrderDraft(qo);
                    loadedFromQuickOrder = true;
                    quickOrderDoc = qo;
                    const matched = findCustomerMatchingQuickOrder(list, qo);
                    if (matched?.id) {
                      try {
                        await invoiceFormApi.selectCustomerById(matched.id);
                      } catch (_) {
                        /* keep draft buyer fields */
                      }
                      showToast(
                        `Linked to saved customer "${matched.name || "customer"}". Review lines and rates, then preview.`
                      );
                    } else {
                      showToast(
                        "New customer — add address in the popup and save to register them; then preview the invoice."
                      );
                      requestAnimationFrame(() => openCustomerAddModalFromQuickOrder(qo));
                    }
                  }
                } catch (_) {
                  /* fall through to blank form */
                }
                if (quickOrderId && !loadedFromQuickOrder) {
                  showToast("Quick order not found or already completed.", { type: "error" });
                }
              }
              if (!loadedFromQuickOrder) {
                invoiceFormApi.resetForm();
                try {
                  if (customerId && list.some((c) => c.id === customerId)) {
                    await invoiceFormApi.selectCustomerById(customerId);
                  }
                } catch (_) {
                  /* ignore customer load failure */
                }
                invoiceFormApi.ensureOneRow();
                invoiceFormApi.recalcTotals();
              }
              if (loadedFromQuickOrder && quickOrderDoc) {
                showCreateQuickOrderBanner(quickOrderDoc);
              }
            }
          }, "Loading…")
        );
      }
      return;
    }

    if (r === "history") {
      showView("history");
      await runRouteStep("history", () => withLoading(() => renderHistory(), "Loading invoices…"));
      return;
    }

    if (r === "reports") {
      showView("reports");
      if (currentUser) {
        await runRouteStep("reports", () =>
          withLoading(async () => {
            const rm = await loadReportsModule();
            await rm.mountReports(db, currentUser.uid);
          }, "Loading reports…")
        );
      }
      return;
    }

    if (r === "invoice" && id) {
      invoiceBreadcrumbState = "loading";
      invoiceBreadcrumbLabel = null;
      showView("invoice");
      syncAppChrome();
      await runRouteStep("invoice", () => withLoading(() => renderInvoicePage(id), "Loading invoice…"));
      return;
    }

    if (r === "invoice-deleted" && id) {
      invoiceBreadcrumbState = "loading";
      invoiceBreadcrumbLabel = null;
      showView("invoice");
      syncAppChrome();
      await runRouteStep("invoice-deleted", () =>
        withLoading(() => renderDeletedInvoicePage(id), "Loading archived invoice…")
      );
      return;
    }

    showView("dashboard");
    if (currentUser) {
      await runRouteStep("dashboard", () => withLoading(() => mountDashboard(db, currentUser.uid), "Loading dashboard…"));
    }
  } catch (ex) {
    showToast(formatAppError(ex, "Navigation failed."), { type: "error" });
    console.error("[route]", ex);
  } finally {
    const { route: rDone, id: idDone } = parseHash();
    if (
      (rDone === "invoice" || rDone === "invoice-deleted") &&
      idDone &&
      invoiceBreadcrumbState === "loading"
    ) {
      invoiceBreadcrumbState = "error";
    }
    syncAppChrome();
    requestAnimationFrame(() => focusVisiblePageHeading());
  }
}

function isConfigPlaceholder() {
  return (
    !firebaseConfig.apiKey ||
    firebaseConfig.apiKey === "YOUR_API_KEY" ||
    firebaseConfig.projectId === "YOUR_PROJECT_ID"
  );
}

const AUTH_REMEMBER_EMAIL_KEY = "easybilling_remember_email";

function setupLoginHeroCarousel() {
  const section = document.getElementById("view-login");
  const slides = section?.querySelectorAll(".login-hero-slide");
  const dots = section?.querySelectorAll(".login-hero-dot");
  const subEl = document.getElementById("login-hero-sub");
  if (!section || !slides?.length || !dots?.length) return;

  const n = slides.length;
  let i = 0;

  const go = (index) => {
    i = ((index % n) + n) % n;
    slides.forEach((el, j) => el.classList.toggle("is-active", j === i));
    dots.forEach((el, j) => {
      const on = j === i;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      el.tabIndex = on ? 0 : -1;
    });
    const line = slides[i]?.dataset?.heroLine;
    if (subEl && line) subEl.textContent = line;
  };

  dots.forEach((dot, j) => {
    dot.addEventListener("click", () => go(j));
  });

  const reduceMotion =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion) {
    setInterval(() => {
      if (section.hidden) return;
      go(i + 1);
    }, 4500);
  }

  go(0);
}

function setupAuthForm() {
  const form = document.getElementById("form-auth");
  const err = document.getElementById("auth-error");
  const btnToggle = document.getElementById("btn-auth-toggle");
  const btnSubmit = document.getElementById("btn-auth-submit");
  const passwordInput = document.getElementById("auth-password");
  const btnPasswordToggle = document.getElementById("btn-auth-password-toggle");
  const authModeLead = document.getElementById("auth-mode-lead");
  const loginTitleText = document.getElementById("login-page-title-text");
  const emailInput = document.getElementById("auth-email");
  const rememberCb = document.getElementById("auth-remember");
  const forgotBtn = document.getElementById("auth-forgot-password");
  const signupNameWrap = document.getElementById("auth-signup-name-wrap");
  const signupTailWrap = document.getElementById("auth-signup-tail-wrap");
  const signupFullname = document.getElementById("auth-signup-fullname");
  const passwordConfirmInput = document.getElementById("auth-password-confirm");
  const btnPasswordConfirmToggle = document.getElementById("btn-auth-password-confirm-toggle");
  const forgotWrap = document.querySelector("#form-auth .login-forgot-wrap");
  const loginAuxMuted = document.getElementById("login-aux-muted");
  if (!form || !btnToggle || !btnSubmit) return;

  function clearSignupFields() {
    if (signupFullname) signupFullname.value = "";
    if (passwordConfirmInput) passwordConfirmInput.value = "";
  }

  function syncAuthModeUi() {
    const signup = !authModeSignIn;
    btnSubmit.textContent = authModeSignIn ? "Sign in" : "Create account";
    if (authModeLead) {
      authModeLead.textContent = authModeSignIn
        ? "Don't have an account?"
        : "Already have an account?";
    }
    btnToggle.textContent = authModeSignIn ? "Create an account" : "Sign in";
    if (loginTitleText) loginTitleText.textContent = authModeSignIn ? "Sign in" : "Create account";
    signupNameWrap?.classList.toggle("hidden", authModeSignIn);
    signupNameWrap?.setAttribute("aria-hidden", authModeSignIn ? "true" : "false");
    signupTailWrap?.classList.toggle("hidden", authModeSignIn);
    signupTailWrap?.setAttribute("aria-hidden", authModeSignIn ? "true" : "false");
    signupFullname?.toggleAttribute("required", signup);
    passwordConfirmInput?.toggleAttribute("required", signup);
    if (passwordInput) {
      passwordInput.autocomplete = signup ? "new-password" : "current-password";
    }
    forgotWrap?.classList.toggle("hidden", signup);
    if (loginAuxMuted) {
      loginAuxMuted.textContent = signup
        ? "Then add your business profile in Settings."
        : "It takes less than a minute.";
    }
    updateDocumentTitle();
  }

  syncAuthModeUi();

  try {
    const saved = localStorage.getItem(AUTH_REMEMBER_EMAIL_KEY);
    if (saved && emailInput) {
      emailInput.value = saved;
      if (rememberCb) rememberCb.checked = true;
    }
  } catch (_) {
    /* ignore */
  }

  if (passwordInput && btnPasswordToggle) {
    const eye = btnPasswordToggle.querySelector(".icon-password-eye");
    const eyeOff = btnPasswordToggle.querySelector(".icon-password-eye-off");
    const syncPasswordToggleUi = () => {
      const visible = passwordInput.type === "text";
      btnPasswordToggle.setAttribute("aria-pressed", visible ? "true" : "false");
      btnPasswordToggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
      if (eye && eyeOff) {
        eye.classList.toggle("hidden", visible);
        eyeOff.classList.toggle("hidden", !visible);
      }
    };
    btnPasswordToggle.addEventListener("click", () => {
      passwordInput.type = passwordInput.type === "password" ? "text" : "password";
      syncPasswordToggleUi();
    });
    syncPasswordToggleUi();
  }

  if (passwordConfirmInput && btnPasswordConfirmToggle) {
    const eyeC = btnPasswordConfirmToggle.querySelector(".icon-password-eye-confirm");
    const eyeOffC = btnPasswordConfirmToggle.querySelector(".icon-password-eye-off-confirm");
    const syncConfirmToggleUi = () => {
      const visible = passwordConfirmInput.type === "text";
      btnPasswordConfirmToggle.setAttribute("aria-pressed", visible ? "true" : "false");
      btnPasswordConfirmToggle.setAttribute("aria-label", visible ? "Hide confirm password" : "Show confirm password");
      if (eyeC && eyeOffC) {
        eyeC.classList.toggle("hidden", visible);
        eyeOffC.classList.toggle("hidden", !visible);
      }
    };
    btnPasswordConfirmToggle.addEventListener("click", () => {
      passwordConfirmInput.type = passwordConfirmInput.type === "password" ? "text" : "password";
      syncConfirmToggleUi();
    });
    syncConfirmToggleUi();
  }

  btnToggle.addEventListener("click", () => {
    authModeSignIn = !authModeSignIn;
    if (authModeSignIn) clearSignupFields();
    err.textContent = "";
    syncAuthModeUi();
  });

  forgotBtn?.addEventListener("click", async () => {
    const email = emailInput?.value.trim() ?? "";
    err.textContent = "";
    if (!email) {
      showValidationToast("Enter your email address first.", { errEl: err });
      return;
    }
    if (isConfigPlaceholder()) {
      showValidationToast("Configure firebase-config.js with your Firebase keys first.", { errEl: err });
      return;
    }
    try {
      await sendPasswordResetToEmail(email);
      showToast("Check your inbox for a password reset link.");
    } catch (ex) {
      showValidationToast(ex.message || "Could not send reset email.", { errEl: err });
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (isConfigPlaceholder()) {
      showValidationToast("Configure firebase-config.js with your Firebase keys first.", { errEl: err });
      return;
    }
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (authModeSignIn) {
      if (!email) {
        showValidationToast("Enter your email address.", { errEl: err });
        return;
      }
      if (!emailOk) {
        showValidationToast("Enter a valid email address.", { errEl: err });
        return;
      }
      if (!password) {
        showValidationToast("Enter your password.", { errEl: err });
        return;
      }
    } else {
      const fullName = signupFullname?.value.trim() ?? "";
      if (!fullName) {
        showValidationToast("Enter your full name.", { errEl: err });
        return;
      }
      if (!email) {
        showValidationToast("Enter your email address.", { errEl: err });
        return;
      }
      if (!emailOk) {
        showValidationToast("Enter a valid email address.", { errEl: err });
        return;
      }
      if (!password) {
        showValidationToast("Enter a password.", { errEl: err });
        return;
      }
      if (password.length < 6) {
        showValidationToast("Password must be at least 6 characters.", { errEl: err });
        return;
      }
      const confirm = passwordConfirmInput?.value ?? "";
      if (!confirm) {
        showValidationToast("Re-enter your password to confirm.", { errEl: err });
        return;
      }
      if (confirm.length < 6) {
        showValidationToast("Confirm password must be at least 6 characters.", { errEl: err });
        return;
      }
      if (password !== confirm) {
        showValidationToast("Password and confirm password must match.", { errEl: err });
        return;
      }
    }

    try {
      if (authModeSignIn) {
        await signInUser(email, password);
        showToast("Signed in successfully.");
      } else {
        await signUpUser(email, password, {
          fullName: signupFullname?.value.trim() ?? "",
          sellerEmail: email,
        });
        showToast("Account created successfully.");
      }
      try {
        if (rememberCb?.checked) {
          localStorage.setItem(AUTH_REMEMBER_EMAIL_KEY, email);
        } else {
          localStorage.removeItem(AUTH_REMEMBER_EMAIL_KEY);
        }
      } catch (_) {
        /* ignore */
      }
      window.location.hash = "#/dashboard";
    } catch (ex) {
      showValidationToast(ex.message || "Authentication failed.", { errEl: err });
    }
  });
}

async function fillSettingsForm() {
  if (!currentUser) return;
  let s;
  try {
    s = await loadUserSettings(currentUser.uid);
  } catch (ex) {
    const errEl = document.getElementById("settings-error");
    const msg = formatAppError(ex, "Could not load settings.");
    showValidationToast(msg, { errEl });
    return;
  }
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v ?? "";
  };
  setVal("set-name", s.sellerName);
  setVal("set-address", s.sellerAddress);
  setVal("set-phone", s.sellerPhone);
  setVal("set-gstin", s.sellerGstin);
  setVal("set-email", s.sellerEmail);
  setVal("set-state-name", s.sellerStateName);
  setVal("set-state-code", s.sellerStateCode);
  setVal("set-pan", s.sellerPan);
  setVal("set-udyam", s.sellerUdyam);
  setVal("set-contact-extra", s.sellerContactExtra);
  setVal("set-cgst-pct", String(s.cgstPercent ?? 2.5));
  setVal("set-sgst-pct", String(s.sgstPercent ?? 2.5));
  setVal("set-acc-holder", s.accountHolderName);
  setVal("set-bank-name", s.bankName);
  setVal("set-bank-branch", s.bankBranch);
  setVal("set-bank-account", s.bankAccount);
  setVal("set-bank-ifsc", s.bankIfsc);
  setVal("set-jurisdiction", s.jurisdictionFooter);
  setVal("set-terms", s.invoiceTerms);
  const errOk = document.getElementById("settings-error");
  const okOk = document.getElementById("settings-success");
  if (errOk) errOk.textContent = "";
  if (okOk) okOk.textContent = "";
}

/**
 * Full reload with cache bypass: clears Cache Storage + unregisters service workers, then navigates
 * with a one-time query param so the HTML document is re-fetched (works on mobile and desktop).
 */
async function hardRefreshApp() {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (_) {
    /* ignore */
  }
  const next = new URL(window.location.href);
  next.searchParams.set("_hr", String(Date.now()));
  window.location.replace(next.toString());
}

function setupSettingsHardRefresh() {
  const verEl = document.getElementById("settings-app-version-value");
  if (verEl) verEl.textContent = APP_VERSION;
  document.getElementById("btn-settings-hard-refresh")?.addEventListener("click", () => {
    showToast("Refreshing app…", { type: "info" });
    void hardRefreshApp();
  });
}

function setupSettingsForm() {
  const form = document.getElementById("form-settings");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("settings-error");
    const okEl = document.getElementById("settings-success");
    if (errEl) errEl.textContent = "";
    if (okEl) okEl.textContent = "";
    if (!currentUser) return;

    const sellerName = document.getElementById("set-name").value.trim();
    const sellerAddress = document.getElementById("set-address").value.trim();
    const sellerPhone = document.getElementById("set-phone").value.trim();
    const sellerGstin = document.getElementById("set-gstin").value.trim().toUpperCase();
    const cgst = parseFloat(document.getElementById("set-cgst-pct").value);
    const sgst = parseFloat(document.getElementById("set-sgst-pct").value);

    if (!sellerName || !sellerAddress || !sellerPhone) {
      showValidationToast("Fill business name, address, and phone.", { errEl });
      return;
    }
    if (Number.isNaN(cgst) || cgst < 0 || cgst > 100 || Number.isNaN(sgst) || sgst < 0 || sgst > 100) {
      showValidationToast("CGST and SGST must be between 0 and 100.", { errEl });
      return;
    }

    try {
      await withLoading(
        () =>
          saveUserSettings(currentUser.uid, {
        sellerName,
        sellerSubtitle: "",
        sellerAddress,
        sellerPhone,
        sellerGstin,
        sellerEmail: document.getElementById("set-email").value.trim(),
        sellerStateName: document.getElementById("set-state-name").value.trim(),
        sellerStateCode: document.getElementById("set-state-code").value.trim(),
        sellerPan: document.getElementById("set-pan").value.trim().toUpperCase(),
        sellerUdyam: document.getElementById("set-udyam").value.trim(),
        sellerContactExtra: document.getElementById("set-contact-extra").value.trim(),
        cgstPercent: cgst,
        sgstPercent: sgst,
        accountHolderName: document.getElementById("set-acc-holder").value.trim(),
        bankName: document.getElementById("set-bank-name").value.trim(),
        bankBranch: document.getElementById("set-bank-branch").value.trim(),
        bankAccount: document.getElementById("set-bank-account").value.trim(),
        bankIfsc: document.getElementById("set-bank-ifsc").value.trim(),
        invoiceTerms: document.getElementById("set-terms").value.trim(),
        jurisdictionFooter: document.getElementById("set-jurisdiction").value.trim(),
          }),
        "Saving…"
      );
      okEl.textContent = "";
      showToast("Settings saved successfully.");
    } catch (ex) {
      showValidationToast(firestorePermissionHint(ex) || ex.message || "Could not save.", { errEl });
    }
  });
}

function firestorePermissionHint(ex) {
  const code = ex && ex.code;
  const msg = (ex && ex.message) || "";
  if (code === "permission-denied" || msg.includes("insufficient permissions")) {
    const pid = firebaseConfig.projectId || "your-project";
    const rulesUrl = `https://console.firebase.google.com/project/${pid}/firestore/rules`;
    return `Permission denied — Firestore rules are missing or not published for project “${pid}”. Open Rules, paste all of firestore.rules, click Publish: ${rulesUrl}`;
  }
  return "";
}

/** User-facing message for any thrown error (routing, Firestore, PDF, etc.). */
function formatAppError(ex, fallback) {
  return firestorePermissionHint(ex) || (ex && ex.message) || fallback || "Something went wrong.";
}

/**
 * Wraps route handlers so one failure does not leave an unhandled rejection.
 * @param {string} context
 * @param {() => Promise<void>} fn
 */
async function runRouteStep(context, fn) {
  try {
    await fn();
  } catch (ex) {
    const msg = formatAppError(ex, "Could not load this page.");
    showToast(msg, { type: "error" });
    console.error(`[${context}]`, ex);
  }
}

/** Local calendar date from yyyy-mm-dd (preview “Dated” matches invoice date field). */
function previewInvoiceDateFromPayload(p) {
  const iso = p && p.invoiceDateIso;
  const m = typeof iso === "string" && iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date();
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(y, mo, day);
  if (d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day) return d;
  return new Date();
}

function mergeSellerIntoInvoicePayload(payload, seller) {
  return {
    ...payload,
    sellerName: seller.sellerName,
    sellerSubtitle: "",
    sellerAddress: seller.sellerAddress,
    sellerPhone: seller.sellerPhone,
    sellerGstin: seller.sellerGstin || "",
    sellerEmail: seller.sellerEmail || "",
    sellerStateName: seller.sellerStateName || "",
    sellerStateCode: seller.sellerStateCode || "",
    sellerPan: seller.sellerPan || "",
    sellerUdyam: seller.sellerUdyam || "",
    sellerContactExtra: seller.sellerContactExtra || "",
    bankName: seller.bankName || "",
    bankBranch: seller.bankBranch || "",
    accountHolderName: seller.accountHolderName || "",
    bankAccount: seller.bankAccount || "",
    bankIfsc: seller.bankIfsc || "",
    invoiceTerms: seller.invoiceTerms || "",
    jurisdictionFooter: seller.jurisdictionFooter || "",
  };
}

function customerPayloadFromInvoice(p) {
  return {
    name: p.customerName,
    address: p.buyerAddress,
    phone: p.buyerPhone,
    gstin: p.buyerGstin,
    stateName: p.buyerStateName,
    stateCode: p.buyerStateCode,
    buyerPan: p.buyerPan || "",
    placeOfSupply: p.placeOfSupply || "",
    buyerContact: p.buyerContact || "",
    buyerEmail: p.buyerEmail || "",
    consigneeAddress: p.consigneeSameAsBuyer ? "" : p.consigneeAddress,
    consigneeName: p.consigneeSameAsBuyer ? "" : p.consigneeName || "",
    consigneeGstin: p.consigneeSameAsBuyer ? "" : p.consigneeGstin || "",
    consigneeStateName: p.consigneeSameAsBuyer ? "" : p.consigneeStateName || "",
    consigneeStateCode: p.consigneeSameAsBuyer ? "" : p.consigneeStateCode || "",
    consigneePhone: p.consigneeSameAsBuyer ? "" : p.consigneePhone || "",
    consigneeEmail: p.consigneeSameAsBuyer ? "" : p.consigneeEmail || "",
    consigneeSameAsBuyer: p.consigneeSameAsBuyer,
  };
}

function closeInvoicePreviewModal() {
  const modal = document.getElementById("invoice-preview-modal");
  const scroll = document.getElementById("invoice-preview-scroll");
  const previewErr = document.getElementById("invoice-preview-error");
  if (previewErr) previewErr.textContent = "";
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
  if (scroll) scroll.innerHTML = "";
}

function setupInvoicePreviewModal() {
  const modal = document.getElementById("invoice-preview-modal");
  const backdrop = document.getElementById("invoice-preview-backdrop");
  const btnBack = document.getElementById("btn-invoice-preview-back");
  const btnGen = document.getElementById("btn-invoice-generate");
  if (!modal || !btnBack || !btnGen) return;

  btnBack.addEventListener("click", () => {
    closeInvoicePreviewModal();
    pendingInvoicePayload = null;
  });
  if (backdrop) {
    backdrop.addEventListener("click", () => {
      closeInvoicePreviewModal();
      pendingInvoicePayload = null;
    });
  }

  btnGen.addEventListener("click", async () => {
    const previewErr = document.getElementById("invoice-preview-error");
    const errEl = document.getElementById("invoice-form-error");
    if (previewErr) previewErr.textContent = "";
    if (errEl) errEl.textContent = "";

    if (!pendingInvoicePayload || !currentUser) {
      showToast("Preview expired. Close and use Preview invoice again.", { type: "error" });
      return;
    }
    const payload = pendingInvoicePayload;

    btnGen.disabled = true;
    try {
      await withLoading(async () => {
        let customerId = (payload.selectedCustomerId || "").trim();
        if (!customerId) {
          customerId = await addCustomer(db, currentUser.uid, customerPayloadFromInvoice(payload));
        } else {
          await updateCustomer(db, customerId, customerPayloadFromInvoice(payload));
        }

        const seller = await loadUserSettings(currentUser.uid);
        if (!seller.sellerName || !seller.sellerAddress || !seller.sellerPhone) {
          throw new Error("SELLER_INCOMPLETE");
        }

        const full = mergeSellerIntoInvoicePayload(payload, seller);
        full.customerId = customerId;
        delete full.selectedCustomerId;

        const isEdit = Boolean(editingInvoiceId);
        if (isEdit) {
          const savedId = editingInvoiceId;
          const { invoiceNumber } = await updateInvoice(db, currentUser.uid, savedId, full);
          pendingInvoicePayload = null;
          closeInvoicePreviewModal();
          editingInvoiceId = null;
          editingInvoiceSnapshot = null;
          invoiceFormApi.resetForm();
          setCreatePageEditMode(false);
          if (currentUser) {
            try {
              const list = await listCustomers(db, currentUser.uid);
              invoiceFormApi.setCustomerOptions(list);
            } catch (_) {}
            const s = await loadUserSettings(currentUser.uid);
            invoiceFormApi.setTaxRates(s.cgstPercent, s.sgstPercent);
          }
          showToast(`Invoice ${invoiceNumber} updated.`);
          window.location.hash = `#/invoice/${savedId}`;
        } else {
          const { id, invoiceNumber } = await saveInvoice(db, currentUser.uid, full);
          pendingInvoicePayload = null;
          closeInvoicePreviewModal();

          invoiceFormApi.resetForm();
          if (currentUser) {
            try {
              const list = await listCustomers(db, currentUser.uid);
              invoiceFormApi.setCustomerOptions(list);
            } catch (_) {}
            const s = await loadUserSettings(currentUser.uid);
            invoiceFormApi.setTaxRates(s.cgstPercent, s.sgstPercent);
          }
          showToast(`Invoice ${invoiceNumber} saved successfully.`);
          window.location.hash = `#/invoice/${id}`;
        }
      }, editingInvoiceId ? "Saving changes…" : "Saving invoice…");
    } catch (ex) {
      const msg =
        ex.message === "SELLER_INCOMPLETE"
          ? "Complete Business settings before creating an invoice."
          : firestorePermissionHint(ex) || ex.message || "Could not save invoice.";
      const detail =
        ex.code === "failed-precondition"
          ? `${msg} If this mentions an index, open the link in the browser console to create it.`
          : msg;
      if (ex.message === "SELLER_INCOMPLETE") {
        window.location.hash = "#/settings";
      }
      showValidationToast(detail, { errEl: previewErr, errEl2: errEl });
    } finally {
      btnGen.disabled = false;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || modal.classList.contains("hidden")) return;
    closeInvoicePreviewModal();
    pendingInvoicePayload = null;
  });
}

function setupInvoiceForm() {
  document.getElementById("btn-create-qo-hide-banner")?.addEventListener("click", hideCreateQuickOrderBanner);

  invoiceFormApi = initInvoiceForm({
    isEditingInvoice: () => Boolean(editingInvoiceId),
    loadCustomer: (id) => getCustomerById(db, id),
    onPreview: async (payload) => {
      const errEl = document.getElementById("invoice-form-error");
      if (errEl) errEl.textContent = "";
      pendingInvoicePayload = null;
      if (!currentUser) return;

      try {
        const seller = await withLoading(
          () => loadUserSettings(currentUser.uid),
          "Loading…"
        );
        if (!seller.sellerName || !seller.sellerAddress || !seller.sellerPhone) {
          showValidationToast("Complete Business settings before creating a GST invoice.", { errEl });
          window.location.hash = "#/settings";
          return;
        }

        const merged = mergeSellerIntoInvoicePayload(payload, seller);

        let prevSnap = 0;
        if (editingInvoiceId && editingInvoiceSnapshot) {
          const oldInv = editingInvoiceSnapshot;
          const oldCustId = (oldInv.customerId || "").trim();
          const newCustId = (payload.selectedCustomerId || "").trim();
          const oldTotal = round2(Number(oldInv.total) || 0);
          const oldPaid = round2(Number(oldInv.amountPaidOnInvoice) || 0);
          const oldNet = round2(oldTotal - oldPaid);
          if (newCustId) {
            const c = await getCustomerById(db, newCustId);
            const b = round2(Number(c?.outstandingBalance) || 0);
            if (oldCustId === newCustId) {
              prevSnap = round2(b - oldNet);
            } else {
              prevSnap = b;
            }
          }
        } else if (payload.selectedCustomerId) {
          const c = await getCustomerById(db, payload.selectedCustomerId);
          prevSnap = round2(Number(c?.outstandingBalance) || 0);
        }

        const { amountPaidOnInvoice, normalizedStatus } = computeInvoicePaymentAmounts(
          payload.total,
          payload.paymentStatus,
          payload.amountPaidOnInvoice,
          prevSnap
        );
        const currSnap = round2(prevSnap + Number(payload.total) - amountPaidOnInvoice);

        const inv = {
          ...merged,
          date: editingInvoiceSnapshot ? editingInvoiceSnapshot.date : previewInvoiceDateFromPayload(merged),
          invoiceNumber: editingInvoiceSnapshot ? editingInvoiceSnapshot.invoiceNumber || "" : "",
          paymentStatus: normalizedStatus,
          paymentMethod: payload.paymentMethod || "credit_sale",
          amountPaidOnInvoice,
          previousBalanceSnapshot: prevSnap,
          currentBalanceSnapshot: currSnap,
          previousBalance: prevSnap,
          currentBalance: currSnap,
        };
        delete inv.selectedCustomerId;

        const scroll = document.getElementById("invoice-preview-scroll");
        const previewErr = document.getElementById("invoice-preview-error");
        if (previewErr) previewErr.textContent = "";
        if (!scroll) return;
        scroll.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "invoice-print-outer";
        wrap.appendChild(renderInvoiceDocument(inv));
        scroll.appendChild(wrap);

        const modal = document.getElementById("invoice-preview-modal");
        if (!modal) return;
        modal.classList.remove("hidden");
        modal.setAttribute("aria-hidden", "false");
        pendingInvoicePayload = payload;
      } catch (ex) {
        pendingInvoicePayload = null;
        const msg = firestorePermissionHint(ex) || ex.message || "Could not build preview.";
        showValidationToast(msg, { errEl });
      }
    },
  });
  invoiceFormApi.ensureOneRow();
}

function toggleEditConsigneeFields() {
  const same = document.getElementById("edit-cust-consignee-same")?.checked;
  const extra = document.getElementById("edit-cust-consignee-extra");
  if (!extra) return;
  const fields = extra.querySelectorAll("input, textarea");
  if (same) {
    extra.classList.add("hidden");
    fields.forEach((el) => {
      el.disabled = true;
    });
  } else {
    extra.classList.remove("hidden");
    fields.forEach((el) => {
      el.disabled = false;
    });
  }
}

function closeCustomerEditModal() {
  const modal = document.getElementById("customer-edit-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
  editingCustomerId = null;
  const form = document.getElementById("form-edit-customer");
  if (form) form.reset();
  const errEl = document.getElementById("edit-customer-error");
  if (errEl) errEl.textContent = "";
  const titleText = document.getElementById("customer-edit-title-text");
  if (titleText) titleText.textContent = "Edit customer";
  const saveBtn = document.getElementById("btn-edit-customer-save");
  if (saveBtn) saveBtn.textContent = "Save changes";
  document.getElementById("edit-cust-opening-wrap")?.classList.add("hidden");
  const op = document.getElementById("edit-cust-opening");
  if (op) op.value = "";
  toggleEditConsigneeFields();
}

function normCustomerNameKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normPhoneDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

/**
 * Match quick order to an existing saved customer (name first, then phone).
 * @param {Array<{ id: string, name?: string, phone?: string }>} list
 * @param {{ customerName?: string, customerPhone?: string }} qo
 */
function findCustomerMatchingQuickOrder(list, qo) {
  if (!list?.length || !qo) return null;
  const qName = normCustomerNameKey(qo.customerName);
  const qPhone = normPhoneDigits(qo.customerPhone);
  if (!qName && qPhone.length < 8) return null;
  if (qName) {
    for (const c of list) {
      if (normCustomerNameKey(c.name) === qName) return c;
    }
  }
  if (qPhone.length >= 8) {
    for (const c of list) {
      if (normPhoneDigits(c.phone) === qPhone) return c;
    }
  }
  return null;
}

/**
 * Open Add customer with fields prefilled from a quick order (new / unknown buyer).
 * @param {{ customerName?: string, customerPhone?: string, memo?: string }} qo
 */
function openCustomerAddModalFromQuickOrder(qo) {
  if (!currentUser || !qo) return;
  openCustomerAddModal();
  const name = (qo.customerName || "").trim();
  const phone = (qo.customerPhone || "").trim();
  const memo = (qo.memo || "").trim();
  if (name) document.getElementById("edit-cust-name").value = name;
  if (phone) document.getElementById("edit-cust-phone").value = phone;
  if (memo) {
    const contact = document.getElementById("edit-cust-contact");
    if (contact && !contact.value.trim()) contact.value = memo.slice(0, 200);
  }
}

function openCustomerAddModal() {
  if (!currentUser) return;
  const errEl = document.getElementById("edit-customer-error");
  if (errEl) errEl.textContent = "";
  editingCustomerId = null;
  const form = document.getElementById("form-edit-customer");
  if (form) form.reset();
  document.getElementById("edit-cust-consignee-same").checked = true;
  toggleEditConsigneeFields();
  const op = document.getElementById("edit-cust-opening");
  if (op) op.value = "";
  document.getElementById("edit-cust-opening-wrap")?.classList.remove("hidden");
  const titleText = document.getElementById("customer-edit-title-text");
  if (titleText) titleText.textContent = "Add customer";
  const saveBtn = document.getElementById("btn-edit-customer-save");
  if (saveBtn) saveBtn.textContent = "Add customer";
  const modal = document.getElementById("customer-edit-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("edit-cust-name")?.focus();
}

async function openCustomerEditModal(customerId) {
  if (!currentUser || !customerId) return;
  const errEl = document.getElementById("edit-customer-error");
  if (errEl) errEl.textContent = "";

  let c;
  try {
    c = await withLoading(() => getCustomerById(db, customerId), "Loading…");
  } catch (ex) {
    showToast(formatAppError(ex, "Could not load customer."), { type: "error" });
    return;
  }
  if (!c) {
    showToast("Customer not found.", { type: "error" });
    return;
  }
  if (c.userId && c.userId !== currentUser.uid) {
    showToast("You cannot edit this customer.", { type: "error" });
    return;
  }

  editingCustomerId = customerId;
  document.getElementById("edit-cust-name").value = c.name || "";
  document.getElementById("edit-cust-address").value = c.address || "";
  document.getElementById("edit-cust-phone").value = c.phone || "";
  document.getElementById("edit-cust-gstin").value = c.gstin || "";
  document.getElementById("edit-cust-state").value = c.stateName || "";
  document.getElementById("edit-cust-state-code").value = c.stateCode || "";
  document.getElementById("edit-cust-pan").value = c.buyerPan || "";
  document.getElementById("edit-cust-place").value = c.placeOfSupply || "";
  document.getElementById("edit-cust-contact").value = c.buyerContact || "";
  document.getElementById("edit-cust-email").value = c.buyerEmail || "";

  const same = c.consigneeSameAsBuyer !== false;
  document.getElementById("edit-cust-consignee-same").checked = same;
  toggleEditConsigneeFields();
  if (!same) {
    document.getElementById("edit-cust-consignee-name").value = c.consigneeName || "";
    document.getElementById("edit-cust-consignee-address").value = c.consigneeAddress || "";
    document.getElementById("edit-cust-consignee-state").value = c.consigneeStateName || "";
    document.getElementById("edit-cust-consignee-state-code").value = c.consigneeStateCode || "";
    document.getElementById("edit-cust-consignee-gstin").value = c.consigneeGstin || "";
    document.getElementById("edit-cust-consignee-phone").value = c.consigneePhone || "";
    document.getElementById("edit-cust-consignee-email").value = c.consigneeEmail || "";
  }

  document.getElementById("edit-cust-opening-wrap")?.classList.add("hidden");
  const titleText = document.getElementById("customer-edit-title-text");
  if (titleText) titleText.textContent = "Edit customer";
  const saveBtn = document.getElementById("btn-edit-customer-save");
  if (saveBtn) saveBtn.textContent = "Save changes";

  const modal = document.getElementById("customer-edit-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("edit-cust-name")?.focus();
}

function closeCustomerPaymentModal() {
  paymentCustomerId = null;
  payTxModalList = [];
  payTxModalPageIndex = 0;
  const modal = document.getElementById("customer-payment-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
  const form = document.getElementById("form-customer-payment");
  if (form) form.reset();
  const errEl = document.getElementById("customer-payment-error");
  if (errEl) errEl.textContent = "";
  const editHint = document.getElementById("customer-payment-edit-hint");
  if (editHint) {
    editHint.textContent = "";
    editHint.classList.add("hidden");
  }
  const saveBtn = document.getElementById("btn-customer-payment-save");
  if (saveBtn) saveBtn.textContent = "Save payment";
  const ul = document.getElementById("pay-tx-list");
  if (ul) ul.innerHTML = "";
  const payPag = document.getElementById("pay-tx-pagination");
  if (payPag) {
    payPag.innerHTML = "";
    payPag.hidden = true;
  }
}

/**
 * Renders tick boxes for open invoices (order = allocation priority for selected items).
 * @param {HTMLElement | null} container
 * @param {Array<{ id: string, label: string, owed?: number }>} invRows
 * @param {Set<string> | string[] | null} preselectedIds
 */
function renderPaymentInvoiceChecklist(container, invRows, preselectedIds) {
  if (!container) return;
  container.innerHTML = "";
  const selected =
    preselectedIds instanceof Set
      ? preselectedIds
      : new Set((preselectedIds || []).map((x) => String(x)));

  if (!invRows.length) {
    const p = document.createElement("p");
    p.className = "muted small pay-invoice-checklist-empty";
    p.textContent = "No unpaid or partial invoices for this customer.";
    container.appendChild(p);
    return;
  }

  for (const r of invRows) {
    const row = document.createElement("label");
    row.className =
      r.kind === "opening" ? "pay-inv-picker-row pay-inv-picker-row--opening" : "pay-inv-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = r.id;
    cb.className = "pay-inv-picker-cb pay-invoice-cb";
    cb.dataset.owed = String(round2(Number(r.owed) || 0));
    cb.checked = selected.has(r.id);

    const owed = round2(Number(r.owed) || 0);
    const invNum =
      r.kind === "opening"
        ? "Opening / non-invoice outstanding"
        : String(r.invoiceNumber || "").trim() || String(r.id).slice(0, 10);
    const { label: stLabel, mod: stMod } = historyPaymentStatusBadge(r.paymentStatus);

    const numEl = document.createElement("span");
    numEl.className = "pay-inv-picker__num";
    numEl.textContent = invNum;
    numEl.title = invNum;

    const badge = document.createElement("span");
    badge.className = `history-inv-status pay-inv-picker-badge ${stMod}`;
    badge.textContent = stLabel;

    const amtEl = document.createElement("span");
    amtEl.className = "pay-inv-picker__amt";
    amtEl.textContent = `₹ ${owed.toFixed(2)}`;

    row.appendChild(cb);
    row.appendChild(numEl);
    row.appendChild(badge);
    row.appendChild(amtEl);
    container.appendChild(row);
  }
}

/** Checked invoice ids in DOM list order (matches oldest-first from server). */
function getPaymentSelectedInvoiceIds() {
  const container = document.getElementById("pay-invoice-checkboxes");
  if (!container) return [];
  const ids = [];
  container.querySelectorAll("input.pay-invoice-cb").forEach((cb) => {
    if (cb.checked) ids.push(cb.value);
  });
  return ids;
}

/** Sum of outstanding (owed) for currently checked invoices — used for validation. */
function getPaymentSelectedInvoicesOwedTotal() {
  const container = document.getElementById("pay-invoice-checkboxes");
  if (!container) return 0;
  let sum = 0;
  container.querySelectorAll("input.pay-invoice-cb:checked").forEach((cb) => {
    sum += round2(Number(cb.dataset.owed) || 0);
  });
  return round2(sum);
}

/** Opening portion of a standalone payment: stored field, or inferred from amount − sum(invoice applications). */
function standalonePaymentOpeningDisplay(tx) {
  const stored = round2(Number(tx.openingBalanceApplied) || 0);
  if (stored > 0.02) return { amount: stored, inferred: false };
  const amt = round2(Number(tx.amount) || 0);
  const invSum = Array.isArray(tx.allocatedInvoices)
    ? tx.allocatedInvoices.reduce(
        (s, a) => round2(s + round2(Number(a.amountApplied) || 0)),
        0
      )
    : 0;
  const inferred = round2(amt - invSum);
  if (inferred > 0.02) return { amount: inferred, inferred: true };
  return { amount: 0, inferred: false };
}

function renderPayTxModalPage() {
  const ul = document.getElementById("pay-tx-list");
  const pagEl = document.getElementById("pay-tx-pagination");
  if (!ul) return;
  ul.innerHTML = "";
  const txs = payTxModalList;
  const typeShort = (t) => {
    if (t === "INVOICE_TOTAL") return "Invoice total";
    if (t === "PAYMENT_ON_INVOICE") return "Payment (on invoice)";
    if (t === "PAYMENT_STANDALONE") return "Payment in";
    if (t === "INVOICE_ADJUSTMENT") return "Invoice adjustment";
    if (t === "INVOICE_DELETED") return "Invoice deleted";
    return t || "Entry";
  };
  const txAmount = (tx) => {
    if (
      (tx.type === "INVOICE_ADJUSTMENT" || tx.type === "INVOICE_DELETED") &&
      tx.receivableDelta != null
    ) {
      return round2(Number(tx.receivableDelta));
    }
    return round2(Number(tx.amount) || 0);
  };
  const txRowClass = (type) => {
    if (type === "INVOICE_TOTAL") return "pay-tx--invoice";
    if (type === "PAYMENT_ON_INVOICE" || type === "PAYMENT_STANDALONE") return "pay-tx--payment";
    if (type === "INVOICE_ADJUSTMENT") return "pay-tx--adjustment";
    if (type === "INVOICE_DELETED") return "pay-tx--invoice-deleted";
    return "pay-tx--other";
  };
  if (!txs.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No transactions yet.";
    ul.appendChild(li);
    if (pagEl) {
      pagEl.innerHTML = "";
      pagEl.hidden = true;
    }
    return;
  }
  const pag = paginateSlice(txs, payTxModalPageIndex, PAY_TX_PAGE_SIZE);
  payTxModalPageIndex = pag.pageIndex;
  const latestPay = findLatestActiveStandalonePayment(txs);

  for (const tx of pag.slice) {
    const li = document.createElement("li");
    li.className = txRowClass(tx.type);
    if (tx.type === "PAYMENT_STANDALONE" && tx.ledgerStatus === "revoked") {
      li.classList.add("pay-tx--revoked");
    }

    if (tx.type === "PAYMENT_STANDALONE") {
      li.classList.add("pay-tx--standalone");
      const amt = txAmount(tx);
      const receivedLabel = tx.amountReceivedDate ? formatInvoiceDate(tx.amountReceivedDate) : "—";
      const sys = tx.recordedAt || tx.createdAt;
      const sysStr = sys ? formatInvoiceDateTime(sys) : "—";
      const methodLabel = tx.paymentMethod ? paymentMethodLabel(tx.paymentMethod) : "—";
      const noteLabel = String(tx.note ?? "").trim();

      const card = document.createElement("div");
      card.className = "pay-tx-card";

      const titleRow = document.createElement("div");
      titleRow.className = "pay-tx-card__head";
      const title = document.createElement("span");
      title.className = "pay-tx-card__title";
      title.textContent = "Payment received";
      titleRow.appendChild(title);
      if (tx.ledgerStatus === "revoked") {
        const badge = document.createElement("span");
        badge.className = "pay-tx-badge pay-tx-badge--revoked";
        badge.textContent = "Revoked";
        titleRow.appendChild(badge);
      }
      const amtStrong = document.createElement("span");
      amtStrong.className = "pay-tx-card__amount";
      amtStrong.textContent = `₹ ${amt.toFixed(2)}`;
      titleRow.appendChild(amtStrong);
      card.appendChild(titleRow);

      const meta = document.createElement("dl");
      meta.className = "pay-tx-meta";
      const metaRows = [
        ["Received date", receivedLabel],
        ["Method", methodLabel],
        ["Recorded in app", sysStr],
        ["Note", noteLabel],
      ];
      for (const [dt, dd] of metaRows) {
        const dEl = document.createElement("dt");
        dEl.textContent = dt;
        const ddEl = document.createElement("dd");
        ddEl.textContent = dd;
        if (dt === "Note") ddEl.classList.add("pay-tx-meta__note");
        meta.appendChild(dEl);
        meta.appendChild(ddEl);
      }
      card.appendChild(meta);

      const { amount: openingAmt, inferred: openingInferred } = standalonePaymentOpeningDisplay(tx);
      const hasInvAlloc = Array.isArray(tx.allocatedInvoices) && tx.allocatedInvoices.length > 0;

      if (openingAmt > 0.02 || hasInvAlloc) {
        const allocTitle = document.createElement("div");
        allocTitle.className = "pay-tx-alloc-title";
        allocTitle.textContent = "Applied breakdown";
        card.appendChild(allocTitle);

        const table = document.createElement("table");
        table.className = "pay-tx-alloc-table pay-tx-alloc-table--breakdown";
        const thead = document.createElement("thead");
        thead.innerHTML =
          "<tr><th>Applied to</th><th class=\"num\">Amount</th><th>Status</th><th class=\"num\">Detail</th></tr>";
        table.appendChild(thead);
        const tbody = document.createElement("tbody");

        if (openingAmt > 0.02) {
          const trO = document.createElement("tr");
          trO.className = "pay-tx-alloc-row pay-tx-alloc-row--opening";
          const tdLabel = document.createElement("td");
          tdLabel.textContent = "Opening / non-invoice outstanding";
          const tdAp = document.createElement("td");
          tdAp.className = "num";
          tdAp.textContent = `₹${openingAmt.toFixed(2)}`;
          const tdSt = document.createElement("td");
          tdSt.className = "pay-tx-status-cell";
          tdSt.textContent = "—";
          const tdNote = document.createElement("td");
          tdNote.className = "pay-tx-alloc-opening-note";
          tdNote.textContent = openingInferred
            ? "Opening balance reduced (inferred from totals)"
            : "Opening balance reduced";
          trO.appendChild(tdLabel);
          trO.appendChild(tdAp);
          trO.appendChild(tdSt);
          trO.appendChild(tdNote);
          tbody.appendChild(trO);
        }

        if (hasInvAlloc) {
          for (const a of tx.allocatedInvoices) {
            const tr = document.createElement("tr");
            const num = a.invoiceNumber || a.invoiceId || "—";
            const ap = round2(Number(a.amountApplied) || 0);
            const sb = String(a.statusBefore ?? "—");
            const sa = String(a.statusAfter ?? "—");
            const pb = round2(Number(a.paidBefore) || 0);
            const pa = round2(Number(a.paidAfter) || 0);
            const tdInv = document.createElement("td");
            tdInv.textContent = num;
            const tdAp2 = document.createElement("td");
            tdAp2.className = "num";
            tdAp2.textContent = `₹${ap.toFixed(2)}`;
            const tdSt2 = document.createElement("td");
            tdSt2.className = "pay-tx-status-cell";
            tdSt2.textContent = `${sb} → ${sa}`;
            const tdPaid = document.createElement("td");
            tdPaid.className = "num pay-tx-paid-range";
            tdPaid.textContent = `₹${pb.toFixed(2)} → ₹${pa.toFixed(2)}`;
            tr.appendChild(tdInv);
            tr.appendChild(tdAp2);
            tr.appendChild(tdSt2);
            tr.appendChild(tdPaid);
            tbody.appendChild(tr);
          }
        }

        table.appendChild(tbody);
        card.appendChild(table);
      }

      const { amount: openingForRevoke } = standalonePaymentOpeningDisplay(tx);
      if (
        latestPay &&
        tx.id === latestPay.id &&
        tx.ledgerStatus !== "revoked" &&
        paymentCustomerId &&
        (hasInvAlloc || openingForRevoke > 0.02)
      ) {
        const actions = document.createElement("div");
        actions.className = "pay-tx-actions";
        const btnRev = document.createElement("button");
        btnRev.type = "button";
        btnRev.className = "btn btn-secondary btn-small";
        btnRev.textContent = "Revoke";
        btnRev.dataset.payRevoke = tx.id;
        actions.appendChild(btnRev);
        card.appendChild(actions);
      }

      li.appendChild(card);
    } else {
      const amt = txAmount(tx);
      const dt = tx.createdAt ? formatInvoiceDate(tx.createdAt) : "—";
      const invNo = tx.invoiceNumber ? tx.invoiceNumber : "";
      const modePart =
        (tx.type === "PAYMENT_ON_INVOICE" || tx.type === "PAYMENT_STANDALONE") && tx.paymentMethod
          ? paymentMethodLabel(tx.paymentMethod)
          : "";

      li.classList.add("pay-tx-line--compact");
      const row = document.createElement("div");
      row.className = "pay-tx-line";
      const dateEl = document.createElement("span");
      dateEl.className = "pay-tx-line__date";
      dateEl.textContent = dt;
      const typeEl = document.createElement("span");
      typeEl.className = "pay-tx-line__type";
      typeEl.textContent =
        tx.type === "INVOICE_DELETED"
          ? `Invoice deleted${invNo ? ` · ${invNo}` : ""}`
          : typeShort(tx.type);
      row.appendChild(dateEl);
      row.appendChild(typeEl);
      if (modePart) {
        const mEl = document.createElement("span");
        mEl.className = "pay-tx-line__method";
        mEl.textContent = modePart;
        row.appendChild(mEl);
      }
      if (invNo && tx.type !== "INVOICE_DELETED") {
        const refEl = document.createElement("span");
        refEl.className = "pay-tx-line__ref";
        refEl.textContent = invNo;
        row.appendChild(refEl);
      }
      const amtEl = document.createElement("span");
      amtEl.className = "pay-tx-line__amt";
      amtEl.textContent = `₹ ${amt.toFixed(2)}`;
      row.appendChild(amtEl);
      li.appendChild(row);
      if (tx.type === "INVOICE_DELETED") {
        const sub = document.createElement("div");
        sub.className = "pay-tx-line-sub pay-tx-line-sub--deleted muted small";
        const tot = tx.total != null ? round2(Number(tx.total)) : null;
        const net = tx.netReceivableRemoved != null ? round2(Number(tx.netReceivableRemoved)) : null;
        sub.textContent = [
          tot != null ? `Total was ₹${tot.toFixed(2)}` : "",
          net != null ? `Net on invoice ₹${net.toFixed(2)} (removed from balance)` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        li.appendChild(sub);
      }
    }

    ul.appendChild(li);
  }
  mountPaginationBar(pagEl, {
    pageIndex: pag.pageIndex,
    pageSize: PAY_TX_PAGE_SIZE,
    total: txs.length,
    onPageChange: (i) => {
      payTxModalPageIndex = i;
      renderPayTxModalPage();
    },
  });
}

async function openCustomerPaymentModal(customerId) {
  if (!currentUser || !customerId) return;
  const errEl = document.getElementById("customer-payment-error");
  if (errEl) errEl.textContent = "";

  let c;
  try {
    c = await withLoading(() => getCustomerById(db, customerId), "Loading…");
  } catch (ex) {
    showToast(formatAppError(ex, "Could not load customer."), { type: "error" });
    return;
  }
  if (!c) {
    showToast("Customer not found.", { type: "error" });
    return;
  }
  paymentCustomerId = customerId;

  const forEl = document.getElementById("customer-payment-for");
  if (forEl) forEl.textContent = c.name ? `Customer: ${c.name}` : "";
  const outEl = document.getElementById("customer-payment-outstanding");
  if (outEl) outEl.textContent = `₹ ${round2(Number(c.outstandingBalance) || 0).toFixed(2)}`;

  const form = document.getElementById("form-customer-payment");
  if (form) form.reset();

  const editHint = document.getElementById("customer-payment-edit-hint");
  if (editHint) {
    editHint.textContent = "";
    editHint.classList.add("hidden");
  }
  const saveBtn = document.getElementById("btn-customer-payment-save");
  if (saveBtn) saveBtn.textContent = "Save payment";

  payTxModalPageIndex = 0;
  try {
    payTxModalList = await listMoneyTransactionsForCustomer(db, currentUser.uid, customerId, 100);
    renderPayTxModalPage();
  } catch (_) {
    payTxModalList = [];
    const ul = document.getElementById("pay-tx-list");
    if (ul) {
      ul.innerHTML = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Could not load transactions.";
      ul.appendChild(li);
    }
    const payPag = document.getElementById("pay-tx-pagination");
    if (payPag) {
      payPag.innerHTML = "";
      payPag.hidden = true;
    }
  }

  const checklistEl = document.getElementById("pay-invoice-checkboxes");
  let invRows = [];
  try {
    invRows = await listOpenInvoicesForPaymentSelect(db, currentUser.uid, customerId);
  } catch (_) {
    invRows = [];
  }
  invRows = mergeOpeningRowIntoPaymentSelect(c, invRows);

  const dateInp = document.getElementById("pay-received-date");
  if (dateInp) {
    dateInp.value = todayIsoDate();
  }

  renderPaymentInvoiceChecklist(checklistEl, invRows, null);
  const payTxDetails = document.getElementById("pay-tx-details");
  if (payTxDetails && invRows.some((r) => r.kind === "opening")) {
    payTxDetails.open = true;
  }

  const modal = document.getElementById("customer-payment-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }
  document.getElementById("pay-amount")?.focus();
}

function setupCustomerPaymentModal() {
  const form = document.getElementById("form-customer-payment");
  const btnCancel = document.getElementById("btn-customer-payment-cancel");
  const backdrop = document.getElementById("customer-payment-backdrop");
  const txListEl = document.getElementById("pay-tx-list");
  if (!form || !btnCancel) return;

  btnCancel.addEventListener("click", () => closeCustomerPaymentModal());
  backdrop?.addEventListener("click", () => closeCustomerPaymentModal());

  txListEl?.addEventListener("click", async (e) => {
    const revokeBtn = e.target.closest("[data-pay-revoke]");
    if (!revokeBtn) return;
    if (!paymentCustomerId || !currentUser) return;
    const txId = revokeBtn.dataset?.payRevoke;
    if (!txId) return;

    if (!window.confirm("Revoke this payment? Invoice balances and outstanding will be restored.")) return;
    try {
      await withLoading(
        () =>
          revokeCustomerPayment(db, currentUser.uid, {
            customerId: paymentCustomerId,
            transactionId: txId,
          }),
        "Revoking…"
      );
      showToast("Payment revoked.");
      payTxModalList = await listMoneyTransactionsForCustomer(db, currentUser.uid, paymentCustomerId, 100);
      payTxModalPageIndex = 0;
      renderPayTxModalPage();
      const c = await getCustomerById(db, paymentCustomerId);
      const outEl = document.getElementById("customer-payment-outstanding");
      if (outEl && c) outEl.textContent = `₹ ${round2(Number(c.outstandingBalance) || 0).toFixed(2)}`;
      await renderCustomersPage();
    } catch (ex) {
      showToast(firestorePermissionHint(ex) || ex.message || "Could not revoke.", { type: "error" });
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("customer-payment-error");
    if (errEl) errEl.textContent = "";
    if (!paymentCustomerId || !currentUser) return;

    const raw = parseFloat(document.getElementById("pay-amount")?.value);
    if (!Number.isFinite(raw) || raw <= 0) {
      showValidationToast("Enter a valid amount.", { errEl });
      return;
    }
    const amt = round2(raw);
    const method = document.getElementById("pay-method")?.value || "other";
    const note = document.getElementById("pay-note")?.value?.trim() || "";
    const amountReceivedDateIso = document.getElementById("pay-received-date")?.value?.trim() || todayIsoDate();
    const selectedInvoiceIds = getPaymentSelectedInvoiceIds();
    const uniqueSelected = [...new Set(selectedInvoiceIds.map((x) => String(x || "").trim()).filter(Boolean))];

    if (uniqueSelected.length > 1) {
      const sumOwedSelected = getPaymentSelectedInvoicesOwedTotal();
      if (amt < sumOwedSelected - 1e-6) {
        showValidationToast(
          "The amount received is less than the total outstanding on the rows you ticked (including opening balance if selected). Untick one or more items, or enter a higher amount.",
          { errEl }
        );
        return;
      }
    }

    try {
      await withLoading(
        () =>
          recordCustomerPayment(db, currentUser.uid, {
            customerId: paymentCustomerId,
            amount: amt,
            paymentMethod: method,
            note,
            amountReceivedDateIso,
            selectedInvoiceIds,
          }),
        "Saving payment…"
      );
      showToast("Payment recorded.");
      closeCustomerPaymentModal();
      await renderCustomersPage();
    } catch (ex) {
      showValidationToast(firestorePermissionHint(ex) || ex.message || "Could not save payment.", { errEl });
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = document.getElementById("customer-payment-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    closeCustomerPaymentModal();
  });
}

function setupCustomerEditModal() {
  const form = document.getElementById("form-edit-customer");
  const btnCancel = document.getElementById("btn-edit-customer-cancel");
  const backdrop = document.getElementById("customer-edit-backdrop");
  const sameCb = document.getElementById("edit-cust-consignee-same");
  if (!form || !btnCancel) return;

  sameCb?.addEventListener("change", toggleEditConsigneeFields);

  btnCancel.addEventListener("click", () => {
    closeCustomerEditModal();
  });
  backdrop?.addEventListener("click", () => {
    closeCustomerEditModal();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("edit-customer-error");
    if (errEl) errEl.textContent = "";
    if (!currentUser) return;

    const name = document.getElementById("edit-cust-name").value.trim();
    const address = document.getElementById("edit-cust-address").value.trim();
    const phone = document.getElementById("edit-cust-phone").value.trim();
    const gstin = document.getElementById("edit-cust-gstin").value.trim().toUpperCase();
    const buyerPan = document.getElementById("edit-cust-pan").value.trim().toUpperCase();
    const consigneeGstin = document.getElementById("edit-cust-consignee-gstin").value.trim().toUpperCase();
    const consigneeSame = document.getElementById("edit-cust-consignee-same").checked;

    if (!name) {
      showValidationToast("Enter buyer name.", { errEl });
      return;
    }
    if (!address) {
      showValidationToast("Enter address.", { errEl });
      return;
    }
    if (!phone) {
      showValidationToast("Enter phone number.", { errEl });
      return;
    }
    if (!isValidGstinOptional(gstin)) {
      showValidationToast("Invalid GSTIN format (optional field).", { errEl });
      return;
    }
    if (!isValidPanOptional(buyerPan)) {
      showValidationToast("Invalid PAN format (optional field).", { errEl });
      return;
    }
    if (!consigneeSame) {
      if (!document.getElementById("edit-cust-consignee-name").value.trim()) {
        showValidationToast("Enter consignee name or mark same as buyer.", { errEl });
        return;
      }
      if (!document.getElementById("edit-cust-consignee-address").value.trim()) {
        showValidationToast("Enter consignee address.", { errEl });
        return;
      }
      if (!isValidGstinOptional(consigneeGstin)) {
        showValidationToast("Invalid consignee GSTIN format (optional field).", { errEl });
        return;
      }
    }

    const payload = {
      name,
      address,
      phone,
      gstin,
      stateName: document.getElementById("edit-cust-state").value.trim(),
      stateCode: document.getElementById("edit-cust-state-code").value.trim(),
      buyerPan,
      placeOfSupply: document.getElementById("edit-cust-place").value.trim(),
      buyerContact: document.getElementById("edit-cust-contact").value.trim(),
      buyerEmail: document.getElementById("edit-cust-email").value.trim(),
      consigneeSameAsBuyer: consigneeSame,
      consigneeName: consigneeSame ? "" : document.getElementById("edit-cust-consignee-name").value.trim(),
      consigneeAddress: consigneeSame ? "" : document.getElementById("edit-cust-consignee-address").value.trim(),
      consigneeGstin: consigneeSame ? "" : consigneeGstin,
      consigneeStateName: consigneeSame ? "" : document.getElementById("edit-cust-consignee-state").value.trim(),
      consigneeStateCode: consigneeSame ? "" : document.getElementById("edit-cust-consignee-state-code").value.trim(),
      consigneePhone: consigneeSame ? "" : document.getElementById("edit-cust-consignee-phone").value.trim(),
      consigneeEmail: consigneeSame ? "" : document.getElementById("edit-cust-consignee-email").value.trim(),
    };

    if (!editingCustomerId) {
      const rawOp = document.getElementById("edit-cust-opening")?.value?.trim() ?? "";
      let opening = 0;
      if (rawOp !== "") {
        const p = parseFloat(rawOp);
        if (!Number.isFinite(p) || p < 0) {
          showValidationToast("Opening outstanding must be zero or a positive amount.", { errEl });
          return;
        }
        opening = round2(p);
      }
      try {
        const newId = await withLoading(
          () => addCustomer(db, currentUser.uid, { ...payload, outstandingBalance: opening }),
          "Saving…"
        );
        closeCustomerEditModal();
        const { route: routeName } = parseHash();
        if (routeName === "create" && invoiceFormApi && currentUser) {
          try {
            const list = await listCustomers(db, currentUser.uid);
            invoiceFormApi.setCustomerOptions(list);
            await invoiceFormApi.selectCustomerById(newId);
            showToast("Customer saved and linked to this invoice.");
          } catch (_) {
            showToast("Customer added.");
          }
        } else {
          showToast("Customer added.");
        }
        await renderCustomersPage();
      } catch (ex) {
        showValidationToast(firestorePermissionHint(ex) || ex.message || "Could not save customer.", { errEl });
      }
      return;
    }

    try {
      await withLoading(
        () => updateCustomer(db, editingCustomerId, payload),
        "Saving…"
      );
      showToast("Customer updated successfully.");
      closeCustomerEditModal();
      await renderCustomersPage();
    } catch (ex) {
      showValidationToast(firestorePermissionHint(ex) || ex.message || "Could not save customer.", { errEl });
    }
  });

  document.getElementById("btn-customers-add")?.addEventListener("click", () => openCustomerAddModal());

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = document.getElementById("customer-edit-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    closeCustomerEditModal();
  });
}

function invoiceRowMillis(inv) {
  const d = inv.date;
  if (d && typeof d.toMillis === "function") return d.toMillis();
  if (d instanceof Date) return d.getTime();
  return 0;
}

function sortInvoicesByDateDesc(rows) {
  return [...rows].sort((a, b) => invoiceRowMillis(b) - invoiceRowMillis(a));
}

/** Last time the invoice document was saved (edit updates `updatedAt`). Deleted rows show removal time. */
function formatInvoiceLastSavedForCustomerList(inv) {
  if (inv.isDeleted) {
    if (inv.deletedAt) return `${formatInvoiceDateTime(inv.deletedAt)} · removed`;
    return `${formatInvoiceDate(inv.date)} · removed`;
  }
  const ts = inv.updatedAt || inv.createdAt;
  if (ts) return formatInvoiceDateTime(ts);
  return `${formatInvoiceDate(inv.date)} (no save time)`;
}

function customerInvoiceDetailSummary(inv) {
  const parts = [];
  const sum = String(inv.itemsSummary || "").trim();
  if (sum) parts.push(sum);
  const ap = String(inv.accountPeriodLabel || "").trim();
  if (ap) parts.push(`Account period ${ap}`);
  const pos = String(inv.placeOfSupply || "").trim();
  if (pos) parts.push(`POS ${pos}`);
  return parts.length ? parts.join(" · ") : "—";
}

function mergeCustomerInvoiceMapsByCustomer(liveMap, deletedMap) {
  const out = new Map();
  const ids = new Set([...liveMap.keys(), ...deletedMap.keys()]);
  for (const cid of ids) {
    const live = liveMap.get(cid) || [];
    const del = deletedMap.get(cid) || [];
    const combined = [...live, ...del].sort((a, b) => invoiceRowMillis(b) - invoiceRowMillis(a));
    out.set(cid, combined);
  }
  return out;
}

function groupInvoicesByCustomerId(invoiceRows) {
  const map = new Map();
  for (const inv of invoiceRows) {
    const cid = String(inv.customerId || "").trim();
    if (!cid) continue;
    if (!map.has(cid)) map.set(cid, []);
    map.get(cid).push(inv);
  }
  return map;
}

function closeCustomerInvoicesModal() {
  const modal = document.getElementById("customer-invoices-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
}

function renderCustomerInvoicesModalTable() {
  const tbody = document.getElementById("customer-invoices-modal-tbody");
  const pagEl = document.getElementById("customer-invoices-pagination");
  if (!tbody) return;
  tbody.innerHTML = "";
  const rows = custInvModalRows;
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "muted";
    td.textContent = "No invoices saved for this customer yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    if (pagEl) {
      pagEl.innerHTML = "";
      pagEl.hidden = true;
    }
    return;
  }
  const pag = paginateSlice(rows, custInvModalPageIndex, CUST_INV_MODAL_PAGE_SIZE);
  custInvModalPageIndex = pag.pageIndex;
  for (const inv of pag.slice) {
    const tr = document.createElement("tr");
    if (inv.isDeleted) tr.classList.add("cust-inv-row--deleted");
    const tdNum = document.createElement("td");
    const a = document.createElement("a");
    a.href = inv.isDeleted ? `#/invoice-deleted/${encodeURIComponent(inv.id)}` : `#/invoice/${inv.id}`;
    a.textContent = inv.invoiceNumber || "—";
    a.className = "cust-inv-modal-link";
    tdNum.appendChild(a);
    if (inv.isDeleted) {
      const delSpan = document.createElement("span");
      delSpan.className = "cust-inv-deleted-tag muted small";
      delSpan.textContent = " Deleted";
      tdNum.appendChild(document.createTextNode(" "));
      tdNum.appendChild(delSpan);
    }
    const tdDoc = document.createElement("td");
    tdDoc.textContent = formatInvoiceDate(inv.date);
    const invoiceTotal = round2(Number(inv.total) || 0);
    const amountReceived = round2(Number(inv.amountPaidOnInvoice) || 0);
    const balanceAmount = round2(invoiceTotal - amountReceived);
    const tdInvAmt = document.createElement("td");
    tdInvAmt.className = "num";
    tdInvAmt.textContent = `₹ ${invoiceTotal.toFixed(2)}`;
    const tdReceived = document.createElement("td");
    tdReceived.className = "num";
    tdReceived.textContent = `₹ ${amountReceived.toFixed(2)}`;
    const tdBalance = document.createElement("td");
    tdBalance.className = "num";
    tdBalance.textContent = `₹ ${balanceAmount.toFixed(2)}`;
    const badge = historyPaymentStatusBadge(inv.paymentStatus, inv);
    const tdStatus = document.createElement("td");
    const st = document.createElement("span");
    st.className = `history-inv-status ${badge.mod}`;
    st.setAttribute("aria-label", `Payment status: ${badge.label}`);
    st.textContent = badge.label;
    tdStatus.appendChild(st);
    const tdDetail = document.createElement("td");
    tdDetail.className = "cust-inv-detail";
    tdDetail.textContent = customerInvoiceDetailSummary(inv);
    const tdWhen = document.createElement("td");
    tdWhen.className = "cust-inv-saved-at";
    tdWhen.textContent = formatInvoiceLastSavedForCustomerList(inv);
    tr.appendChild(tdNum);
    tr.appendChild(tdDoc);
    tr.appendChild(tdInvAmt);
    tr.appendChild(tdReceived);
    tr.appendChild(tdBalance);
    tr.appendChild(tdStatus);
    tr.appendChild(tdDetail);
    tr.appendChild(tdWhen);
    tbody.appendChild(tr);
  }
  mountPaginationBar(pagEl, {
    pageIndex: pag.pageIndex,
    pageSize: CUST_INV_MODAL_PAGE_SIZE,
    total: rows.length,
    onPageChange: (i) => {
      custInvModalPageIndex = i;
      renderCustomerInvoicesModalTable();
    },
  });
}

function openCustomerInvoicesModal(customerId, customerName) {
  const raw = customerInvoicesByCustomerIdCache.get(customerId) || [];
  custInvModalRows = sortInvoicesByDateDesc(raw);
  custInvModalPageIndex = 0;
  const sub = document.getElementById("customer-invoices-modal-sub");
  if (sub) sub.textContent = customerName ? `Customer: ${customerName}` : "";
  renderCustomerInvoicesModalTable();
  const modal = document.getElementById("customer-invoices-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }
}

function setupCustomerInvoicesModal() {
  document.getElementById("btn-customer-invoices-close")?.addEventListener("click", () => closeCustomerInvoicesModal());
  document.getElementById("customer-invoices-modal-backdrop")?.addEventListener("click", () => closeCustomerInvoicesModal());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = document.getElementById("customer-invoices-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    closeCustomerInvoicesModal();
  });
}

function wireCustomersSearch() {
  if (customersSearchWired) return;
  customersSearchWired = true;
  const input = document.getElementById("customers-search");
  if (!input) return;
  input.addEventListener("input", () => {
    clearTimeout(customersSearchDebounce);
    customersSearchDebounce = setTimeout(() => {
      customersSearchDebounce = null;
      renderCustomersListFromCache();
    }, 220);
  });
}

function renderCustomersListFromCache() {
  const listEl = document.getElementById("customers-list");
  const emptyEl = document.getElementById("customers-empty");
  const pagEl = document.getElementById("customers-pagination");
  if (!listEl || !emptyEl) return;
  listEl.innerHTML = "";
  const all = customersPageCache;
  if (!all || !all.length) {
    emptyEl.hidden = false;
    emptyEl.innerHTML =
      'No customers yet. Use <strong>Add customer</strong> above or <a href="#/create" class="text-link">create an invoice</a> and save a new buyer.';
    if (pagEl) {
      pagEl.innerHTML = "";
      pagEl.hidden = true;
    }
    return;
  }
  const q = document.getElementById("customers-search")?.value ?? "";
  if (q !== customersListSearchKey) {
    customersListSearchKey = q;
    customersListPageIndex = 0;
  }
  const rows = sortCustomerRows(all.filter((row) => matchesSearchTokens(customerSearchBlob(row), q)));
  if (!rows.length) {
    emptyEl.hidden = false;
    emptyEl.innerHTML =
      'No customers match your search. Clear the search box above to see all customers.';
    if (pagEl) {
      pagEl.innerHTML = "";
      pagEl.hidden = true;
    }
    return;
  }
  const pag = paginateSlice(rows, customersListPageIndex, CUSTOMERS_PAGE_SIZE);
  customersListPageIndex = pag.pageIndex;
  emptyEl.hidden = true;
  emptyEl.innerHTML =
    'No customers yet. Use <strong>Add customer</strong> above or <a href="#/create" class="text-link">create an invoice</a> and save a new buyer.';
  for (const row of pag.slice) {
    const li = document.createElement("li");
    li.className = "customer-row";
    const phone = escapeHtml(row.phone || "");
    const addr = escapeHtml((row.address || "").slice(0, 80));
    const ob = round2(Number(row.outstandingBalance) || 0);
    const custName = row.name || "";
    li.innerHTML = `<div class="customer-card">
      <strong><a href="#/create?customer=${encodeURIComponent(row.id)}" class="customer-name-link">${escapeHtml(custName)}</a></strong>
      <div class="meta">${phone} · ${addr}${(row.address || "").length > 80 ? "…" : ""}</div>
      <div class="meta customer-outstanding-line"><span class="customer-outstanding-label">Outstanding:</span> <span class="customer-outstanding-value">₹ ${ob.toFixed(2)}</span></div>
      <div class="btn-row customer-card-actions">
        <a class="btn btn-secondary btn-small" href="#/create?customer=${encodeURIComponent(row.id)}">Use in invoice</a>
        <button type="button" class="btn btn-secondary btn-small btn-show-customer-invoices" data-id="${escapeHtml(row.id)}" data-name="${escapeHtml(custName)}">Show invoices</button>
        <button type="button" class="btn btn-secondary btn-small btn-pay-customer" data-id="${escapeHtml(row.id)}">Record payment</button>
        <button type="button" class="btn btn-secondary btn-small btn-edit-customer" data-id="${escapeHtml(row.id)}">Edit</button>
        <button type="button" class="btn btn-ghost btn-small btn-del-customer" data-id="${escapeHtml(row.id)}">Delete</button>
      </div>
    </div>`;
    listEl.appendChild(li);
  }
  mountPaginationBar(pagEl, {
    pageIndex: pag.pageIndex,
    pageSize: CUSTOMERS_PAGE_SIZE,
    total: rows.length,
    onPageChange: (i) => {
      customersListPageIndex = i;
      renderCustomersListFromCache();
    },
  });
  listEl.querySelectorAll(".btn-show-customer-invoices").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cid = btn.getAttribute("data-id");
      const nm = btn.getAttribute("data-name") || "";
      if (!cid) return;
      openCustomerInvoicesModal(cid, nm);
    });
  });
  listEl.querySelectorAll(".btn-pay-customer").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cid = btn.getAttribute("data-id");
      if (!cid) return;
      try {
        await openCustomerPaymentModal(cid);
      } catch (ex) {
        showToast(firestorePermissionHint(ex) || ex.message || "Could not open payment.", { type: "error" });
      }
    });
  });
  listEl.querySelectorAll(".btn-edit-customer").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cid = btn.getAttribute("data-id");
      if (!cid) return;
      try {
        await openCustomerEditModal(cid);
      } catch (ex) {
        showToast(firestorePermissionHint(ex) || ex.message || "Could not load customer.", { type: "error" });
      }
    });
  });
  listEl.querySelectorAll(".btn-del-customer").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cid = btn.getAttribute("data-id");
      if (!cid || !confirm("Delete this customer from the list?")) return;
      try {
        await withLoading(async () => {
          await deleteCustomer(db, cid);
          await renderCustomersPage();
        }, "Deleting…");
        showToast("Customer deleted successfully.");
      } catch (ex) {
        showToast(firestorePermissionHint(ex) || ex.message || "Could not delete customer.", { type: "error" });
      }
    });
  });
}

let quickOrdersPageWired = false;

function qoEscapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function qoAddLineRow(container, line = {}) {
  const wrap = document.createElement("div");
  wrap.className = "quick-order-line-row";
  const prod = qoEscapeAttr(line.productName || "");
  const qty = Number(line.quantity) > 0 ? line.quantity : 1;
  const unit = qoEscapeAttr(line.unit || "Pcs");
  wrap.innerHTML = `
    <div class="quick-order-line-grid">
      <label class="qo-line-label">Product <input type="text" class="qo-line-product" maxlength="200" value="${prod}" /></label>
      <label class="qo-line-label">Qty <input type="number" class="qo-line-qty" min="0.001" step="any" value="${qty}" /></label>
      <label class="qo-line-label">Unit <input type="text" class="qo-line-unit" maxlength="12" placeholder="Pcs" value="${unit}" /></label>
    </div>
    <button type="button" class="btn btn-ghost btn-small qo-line-remove">Remove</button>`;
  wrap.querySelector(".qo-line-remove")?.addEventListener("click", () => {
    const rows = container.querySelectorAll(".quick-order-line-row");
    if (rows.length <= 1) return;
    wrap.remove();
  });
  container.appendChild(wrap);
}

function qoReadLines(container) {
  const rows = container.querySelectorAll(".quick-order-line-row");
  const lines = [];
  rows.forEach((row) => {
    const productName = row.querySelector(".qo-line-product")?.value?.trim() || "";
    const qty = parseFloat(row.querySelector(".qo-line-qty")?.value);
    const unit = row.querySelector(".qo-line-unit")?.value?.trim() || "Pcs";
    lines.push({
      productName,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      unit: unit || "Pcs",
    });
  });
  return lines;
}

function qoResetForm() {
  const editId = document.getElementById("quick-order-edit-id");
  if (editId) editId.value = "";
  document.getElementById("qo-customer-name").value = "";
  document.getElementById("qo-customer-phone").value = "";
  document.getElementById("qo-send-date").value = "";
  document.getElementById("qo-memo").value = "";
  const wrap = document.getElementById("qo-lines-wrap");
  if (wrap) {
    wrap.innerHTML = "";
    qoAddLineRow(wrap, {});
    qoAddLineRow(wrap, {});
  }
  const err = document.getElementById("qo-form-error");
  if (err) err.textContent = "";
  const btnSave = document.getElementById("btn-qo-save");
  if (btnSave) btnSave.textContent = "Save quick order";
  document.getElementById("btn-qo-cancel-edit")?.classList.add("hidden");
}

function qoFillFormForEdit(row) {
  const editId = document.getElementById("quick-order-edit-id");
  if (editId) editId.value = row.id || "";
  document.getElementById("qo-customer-name").value = row.customerName || "";
  document.getElementById("qo-customer-phone").value = row.customerPhone || "";
  document.getElementById("qo-send-date").value = row.sendDate || "";
  document.getElementById("qo-memo").value = row.memo || "";
  const wrap = document.getElementById("qo-lines-wrap");
  if (wrap) {
    wrap.innerHTML = "";
    const lines = Array.isArray(row.lines) && row.lines.length ? row.lines : [{}];
    lines.forEach((ln) => qoAddLineRow(wrap, ln));
  }
  const btnSave = document.getElementById("btn-qo-save");
  if (btnSave) btnSave.textContent = "Update quick order";
  document.getElementById("btn-qo-cancel-edit")?.classList.remove("hidden");
  const err = document.getElementById("qo-form-error");
  if (err) err.textContent = "";
  document.getElementById("form-quick-order")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setupQuickOrdersPage() {
  if (quickOrdersPageWired) return;
  quickOrdersPageWired = true;
  const form = document.getElementById("form-quick-order");
  const wrap = document.getElementById("qo-lines-wrap");
  if (wrap && !wrap.querySelector(".quick-order-line-row")) {
    qoAddLineRow(wrap, {});
    qoAddLineRow(wrap, {});
  }
  document.getElementById("btn-qo-add-line")?.addEventListener("click", () => {
    if (wrap) qoAddLineRow(wrap, {});
  });
  document.getElementById("btn-qo-cancel-edit")?.addEventListener("click", () => qoResetForm());
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("qo-form-error");
    if (errEl) errEl.textContent = "";
    if (!currentUser) return;
    const name = document.getElementById("qo-customer-name")?.value?.trim() || "";
    if (!name) {
      if (errEl) errEl.textContent = "Enter customer name.";
      return;
    }
    const lines = qoReadLines(wrap);
    const hasProduct = lines.some((l) => (l.productName || "").trim().length > 0);
    if (!hasProduct) {
      if (errEl) errEl.textContent = "Add at least one product line.";
      return;
    }
    const payload = {
      customerName: name,
      customerPhone: document.getElementById("qo-customer-phone")?.value?.trim() || "",
      sendDate: document.getElementById("qo-send-date")?.value?.trim() || "",
      memo: document.getElementById("qo-memo")?.value?.trim() || "",
      lines,
    };
    const editId = document.getElementById("quick-order-edit-id")?.value?.trim() || "";
    try {
      if (editId) {
        await withLoading(
          () => updateQuickOrder(db, editId, currentUser.uid, payload),
          "Saving…"
        );
        showToast("Quick order updated.");
      } else {
        await withLoading(() => addQuickOrder(db, currentUser.uid, payload), "Saving…");
        showToast("Quick order saved — it will show on your dashboard until you invoice or mark done.");
      }
      qoResetForm();
      await renderQuickOrdersPage();
    } catch (ex) {
      if (errEl) errEl.textContent = firestorePermissionHint(ex) || ex.message || "Could not save.";
    }
  });
}

async function renderQuickOrdersPage() {
  const listEl = document.getElementById("qo-list");
  const emptyEl = document.getElementById("qo-empty");
  const pagEl = document.getElementById("qo-pagination");
  if (!listEl || !currentUser) return;

  try {
    quickOrdersOpenCache = await listOpenQuickOrders(db, currentUser.uid);
  } catch (ex) {
    quickOrdersOpenCache = [];
    listEl.innerHTML = `<li class="muted">Could not load quick orders.</li>`;
    if (emptyEl) emptyEl.hidden = true;
    if (pagEl) {
      pagEl.innerHTML = "";
      pagEl.hidden = true;
    }
    return;
  }

  qoListPageIndex = 0;
  renderQuickOrdersListFromCache();
}

function renderQuickOrdersListFromCache() {
  const listEl = document.getElementById("qo-list");
  const emptyEl = document.getElementById("qo-empty");
  const pagEl = document.getElementById("qo-pagination");
  if (!listEl) return;
  const rows = quickOrdersOpenCache;

  if (!rows.length) {
    listEl.innerHTML = "";
    if (emptyEl) emptyEl.hidden = false;
    if (pagEl) {
      pagEl.innerHTML = "";
      pagEl.hidden = true;
    }
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  const pag = paginateSlice(rows, qoListPageIndex, QO_PAGE_SIZE);
  qoListPageIndex = pag.pageIndex;
  listEl.innerHTML = "";
  for (const row of pag.slice) {
    const li = document.createElement("li");
    li.className = "quick-order-card card";
    const lines = Array.isArray(row.lines) ? row.lines : [];
    const lineSummary = lines
      .filter((l) => (l.productName || "").trim())
      .map((l) => `${escapeHtml((l.productName || "").trim())} × ${escapeHtml(String(l.quantity ?? ""))}`)
      .join(" · ");
    const send = (row.sendDate || "").trim();
    const sendLabel = send
      ? send.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1")
      : "—";
    li.innerHTML = `
      <div class="quick-order-card-head">
        <strong class="quick-order-customer">${escapeHtml(row.customerName || "Customer")}</strong>
        <span class="quick-order-date-badge" title="Send / deliver by">Due ${escapeHtml(sendLabel)}</span>
      </div>
      <p class="quick-order-lines muted small">${lineSummary || "—"}</p>
      ${row.memo ? `<p class="quick-order-memo small">${escapeHtml(row.memo)}</p>` : ""}
      <div class="btn-row wrap quick-order-card-actions">
        <a class="btn btn-primary btn-small" href="#/create?quickOrder=${encodeURIComponent(row.id)}">Create GST invoice</a>
        <button type="button" class="btn btn-secondary btn-small btn-qo-edit" data-id="${escapeHtml(row.id)}">Edit</button>
        <button type="button" class="btn btn-secondary btn-small btn-qo-done" data-id="${escapeHtml(row.id)}">Mark done</button>
        <button type="button" class="btn btn-ghost btn-small btn-qo-del" data-id="${escapeHtml(row.id)}">Delete</button>
      </div>`;
    listEl.appendChild(li);
  }

  mountPaginationBar(pagEl, {
    pageIndex: pag.pageIndex,
    pageSize: QO_PAGE_SIZE,
    total: rows.length,
    onPageChange: (i) => {
      qoListPageIndex = i;
      renderQuickOrdersListFromCache();
    },
  });

  listEl.querySelectorAll(".btn-qo-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      const row = quickOrdersOpenCache.find((r) => r.id === id);
      if (row) qoFillFormForEdit(row);
    });
  });
  listEl.querySelectorAll(".btn-qo-done").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      try {
        await withLoading(() => markQuickOrderDone(db, id, currentUser.uid), "Updating…");
        showToast("Marked done — removed from reminders.");
        await renderQuickOrdersPage();
      } catch (ex) {
        showToast(firestorePermissionHint(ex) || ex.message || "Could not update.", { type: "error" });
      }
    });
  });
  listEl.querySelectorAll(".btn-qo-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!id || !confirm("Delete this quick order?")) return;
      try {
        await withLoading(() => deleteQuickOrder(db, id, currentUser.uid), "Deleting…");
        showToast("Deleted.");
        await renderQuickOrdersPage();
      } catch (ex) {
        showToast(firestorePermissionHint(ex) || ex.message || "Could not delete.", { type: "error" });
      }
    });
  });
}

async function renderCustomersPage() {
  const listEl = document.getElementById("customers-list");
  const emptyEl = document.getElementById("customers-empty");
  if (listEl) listEl.innerHTML = "";
  if (!currentUser) return;
  customersListPageIndex = 0;
  customersListSearchKey = "";

  let rows;
  let invoiceRows = [];
  let deletedRows = [];
  try {
    [rows, invoiceRows, deletedRows] = await Promise.all([
      listCustomers(db, currentUser.uid),
      listInvoicesForUser(db, currentUser.uid).catch(() => []),
      listDeletedInvoicesForUser(db, currentUser.uid).catch(() => []),
    ]);
  } catch (ex) {
    customersPageCache = null;
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent =
        ex.message ||
        "Could not load customers. Check Firestore rules for the customers collection.";
    }
    return;
  }
  const byCustomer = mergeCustomerInvoiceMapsByCustomer(
    groupInvoicesByCustomerId(invoiceRows),
    groupInvoicesByCustomerId(deletedRows)
  );
  customerInvoicesByCustomerIdCache = byCustomer;
  customersPageCache = rows;
  wireCustomersSearch();
  wireCustomersSortControls();
  renderCustomersListFromCache();
}

async function renderHistory() {
  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  const countEl = document.getElementById("history-count");
  if (!listEl || !emptyEl) return;
  listEl.innerHTML = "";
  historyCache = null;
  if (countEl) {
    countEl.hidden = true;
    countEl.textContent = "";
  }
  if (!currentUser) return;

  let rows = [];
  let deletedArchived = [];
  let customers = [];
  try {
    [rows, deletedArchived, customers] = await Promise.all([
      listInvoicesForUser(db, currentUser.uid),
      listDeletedInvoicesForUser(db, currentUser.uid).catch((e) => {
        console.error("[history] Could not load deleted invoice archive:", e?.message || e);
        return [];
      }),
      listCustomers(db, currentUser.uid).catch(() => []),
    ]);
  } catch (ex) {
    emptyEl.hidden = false;
    emptyEl.textContent =
      ex.message ||
      "Could not load history. If the console mentions an index, open the link to create it in Firebase.";
    return;
  }
  const live = rows.map((r) => ({ ...r, isDeleted: false }));
  const merged = [...live, ...deletedArchived].sort((a, b) => {
    const ta = rowInvoiceDate(a)?.getTime() ?? 0;
    const tb = rowInvoiceDate(b)?.getTime() ?? 0;
    return tb - ta;
  });
  historyCache = merged;
  wireHistoryFilters();
  wireHistorySortControls();
  populateHistoryAccountPeriodSelect();
  populateHistoryCustomerOptions(customers, merged);
  emptyEl.innerHTML =
    'No invoices yet. <a href="#/create" class="text-link">Create your first invoice</a>.';
  applyHistoryFilters();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hideCreateQuickOrderBanner() {
  document.getElementById("create-quick-order-banner")?.classList.add("hidden");
}

function showCreateQuickOrderBanner(qo) {
  const el = document.getElementById("create-quick-order-banner");
  const text = document.getElementById("create-quick-order-banner-text");
  if (!el || !text || !qo) return;
  const lines = Array.isArray(qo.lines) ? qo.lines : [];
  const lineSummary = lines
    .filter((l) => (l.productName || "").trim())
    .map((l) => `${String(l.productName || "").trim()} × ${l.quantity ?? ""}`)
    .slice(0, 8)
    .join("; ");
  const due = String(qo.sendDate || "").trim();
  const dueStr = due ? due.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1") : "—";
  const phone = String(qo.customerPhone || "").trim();
  const memo = String(qo.memo || "").trim();
  text.textContent = `Due ${dueStr}.${phone ? ` Phone: ${phone}.` : ""} ${lineSummary || "See line items below."}${
    memo ? ` Notes: ${memo.slice(0, 200)}${memo.length > 200 ? "…" : ""}` : ""
  }`;
  el.classList.remove("hidden");
}

function updateNavActive(routeName) {
  const nav = document.getElementById("nav-main");
  if (!nav) return;
  nav.querySelectorAll("[data-nav-route]").forEach((el) => el.classList.remove("nav-link--active"));
  if (!routeName) return;
  const key = routeName === "invoice" || routeName === "invoice-deleted" ? "history" : routeName;
  const link = nav.querySelector(`[data-nav-route="${key}"]`);
  if (link) link.classList.add("nav-link--active");
}

function updateDocumentTitle() {
  if (shouldForceLoginView(currentUser)) {
    document.title = authModeSignIn ? `Sign in · ${APP_NAME}` : `Create account · ${APP_NAME}`;
    return;
  }
  const { route: r, id, editId } = parseHash();
  const base = ` · ${APP_NAME}`;
  switch (r) {
    case "dashboard":
      document.title = `Billing dashboard${base}`;
      break;
    case "settings":
      document.title = `Business & GST settings${base}`;
      break;
    case "customers":
      document.title = `Customer directory${base}`;
      break;
    case "history":
      document.title = `Invoice register${base}`;
      break;
    case "quick-orders":
      document.title = `Quick orders${base}`;
      break;
    case "reports":
      document.title = `Reports${base}`;
      break;
    case "create":
      document.title = (editId ? "Edit GST invoice" : "New GST invoice") + base;
      break;
    case "invoice":
      if (id) {
        if (invoiceBreadcrumbState === "loading") {
          document.title = `Loading invoice${base}`;
        } else if (invoiceBreadcrumbState === "error") {
          document.title = `Invoice${base}`;
        } else {
          const label = invoiceBreadcrumbLabel || id;
          document.title = `${label}${base}`;
        }
      } else {
        document.title = `${APP_NAME} — GST invoices`;
      }
      break;
    case "invoice-deleted":
      if (id) {
        if (invoiceBreadcrumbState === "loading") {
          document.title = `Loading archived invoice${base}`;
        } else if (invoiceBreadcrumbState === "error") {
          document.title = `Deleted invoice${base}`;
        } else {
          const label = invoiceBreadcrumbLabel || id;
          document.title = `${label} (deleted)${base}`;
        }
      } else {
        document.title = `${APP_NAME} — GST invoices`;
      }
      break;
    default:
      document.title = `${APP_NAME} — GST invoices`;
  }
}

/**
 * Breadcrumbs, footer quick links, and main nav active state (call after route resolves).
 */
function syncAppChrome() {
  const bc = document.getElementById("app-breadcrumbs");
  const listEl = document.getElementById("breadcrumb-list");
  const footNav = document.getElementById("footer-quick-nav");
  if (!bc || !listEl) return;

  if (shouldForceLoginView(currentUser)) {
    bc.classList.add("hidden");
    bc.setAttribute("aria-hidden", "true");
    if (footNav) footNav.classList.add("hidden");
    updateNavActive(null);
    updateDocumentTitle();
    return;
  }

  bc.classList.remove("hidden");
  bc.setAttribute("aria-hidden", "false");
  if (footNav) footNav.classList.remove("hidden");

  const { route: r, id, editId } = parseHash();
  const segments = [{ href: "#/dashboard", label: "Dashboard" }];
  switch (r) {
    case "dashboard":
      segments.push({ current: true, label: "Billing overview" });
      break;
    case "settings":
      segments.push({ current: true, label: "Business & GST settings" });
      break;
    case "customers":
      segments.push({ current: true, label: "Customer directory" });
      break;
    case "history":
      segments.push({ current: true, label: "Invoice register" });
      break;
    case "quick-orders":
      segments.push({ current: true, label: "Quick orders" });
      break;
    case "reports":
      segments.push({ current: true, label: "Reports" });
      break;
    case "create":
      segments.push({ current: true, label: editId ? "Edit GST invoice" : "New GST invoice" });
      break;
    case "invoice":
      if (id) {
        segments.push({ href: "#/history", label: "Invoice register" });
        if (invoiceBreadcrumbState === "loading") {
          segments.push({ current: true, label: "Loading…", loading: true });
        } else if (invoiceBreadcrumbState === "error") {
          segments.push({ current: true, label: "Unable to load" });
        } else {
          segments.push({ current: true, label: invoiceBreadcrumbLabel || "Invoice" });
        }
      } else {
        segments.push({ current: true, label: "Dashboard" });
      }
      break;
    case "invoice-deleted":
      if (id) {
        segments.push({ href: "#/history", label: "Invoice register" });
        if (invoiceBreadcrumbState === "loading") {
          segments.push({ current: true, label: "Loading…", loading: true });
        } else if (invoiceBreadcrumbState === "error") {
          segments.push({ current: true, label: "Unable to load" });
        } else {
          segments.push({ current: true, label: invoiceBreadcrumbLabel || "Deleted invoice" });
        }
      } else {
        segments.push({ current: true, label: "Dashboard" });
      }
      break;
    default:
      segments.push({ current: true, label: "Dashboard" });
  }

  listEl.innerHTML = segments
    .map((seg) => {
      if (seg.current) {
        const busy = seg.loading ? ' aria-busy="true"' : "";
        const cls = seg.loading ? "breadcrumb-current breadcrumb-loading" : "breadcrumb-current";
        return `<li class="breadcrumb-item"><span class="${cls}" aria-current="page"${busy}>${escapeHtml(seg.label)}</span></li>`;
      }
      return `<li class="breadcrumb-item"><a href="${escapeHtml(seg.href)}">${escapeHtml(seg.label)}</a></li>`;
    })
    .join("");

  updateNavActive(r === "invoice" || r === "invoice-deleted" ? "invoice" : r);
  updateDocumentTitle();
}

/** Move focus to the visible view heading for screen readers (skip modals / form fields). */
function focusVisiblePageHeading() {
  if (shouldForceLoginView(currentUser)) return;
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "SELECT" ||
      active.getAttribute("contenteditable") === "true")
  ) {
    return;
  }
  if (
    active &&
    active.closest?.(
      "[role='dialog'], .invoice-preview-modal, .customer-edit-modal, .customer-invoices-modal, .dashboard-detail-modal, .dashboard-qo-modal"
    )
  ) {
    return;
  }

  const view = document.querySelector("#app-main .view:not([hidden])");
  const h1 = view?.querySelector("h1");
  if (!h1) return;
  if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
  try {
    h1.focus({ preventScroll: true });
  } catch (_) {
    h1.focus();
  }
}

/** Max invoices per bulk ZIP (browser / time limits). */
const BULK_HISTORY_PDF_MAX = 100;

/** Host width for bulk ZIP PDFs — matches `.invoice-print-outer { max-width: 210mm }` (~794px @ 96dpi). */
const INVOICE_PDF_CAPTURE_WIDTH_PX = Math.round((210 * 96) / 25.4);

let historyBulkDownloadBusy = false;

function uniquePdfFilenameInZip(baseName, used) {
  const safe = String(baseName || "invoice").replace(/[^a-zA-Z0-9-_]/g, "_") || "invoice";
  let name = `${safe}.pdf`;
  let n = 2;
  while (used.has(name)) {
    name = `${safe}-${n}.pdf`;
    n += 1;
  }
  used.add(name);
  return name;
}

async function invoiceNodeToPdfBlob(node) {
  const h2p = window.html2pdf;
  if (!h2p) throw new Error("PDF library not loaded.");
  await prepareInvoiceStampImagesForPdf(node);
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  try {
    await document.fonts?.ready?.catch?.(() => {});
  } catch (_) {
    /* ignore */
  }
  /**
   * html2canvas ignores @media print — PDF looked like screen, not like Print preview.
   * `html.invoice-pdf-emulate-print` mirrors print CSS (see app.css); toggle only during capture.
   */
  const rootEl = document.documentElement;
  rootEl.classList.add("invoice-pdf-emulate-print");
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  try {
    /** Higher scale = sharper text and borders (html2canvas raster). Min 3 for readable PDF; cap 4 for memory. */
    const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const pdfCanvasScale = Math.min(4, Math.max(3, Math.round(dpr * 2.25)));
    const opts = {
      /* [top, left, bottom, right] mm — match @page { margin: 0 } used in print */
      margin: [0, 0, 0, 0],
      filename: "x.pdf",
      image: { type: "png", quality: 1 },
      html2canvas: {
        scale: pdfCanvasScale,
        useCORS: true,
        allowTaint: false,
        logging: false,
        scrollY: 0,
        scrollX: 0,
        backgroundColor: "#ffffff",
        /* Crisper text on the canvas (helps vs default grayscale-ish raster) */
        letterRendering: true,
        onclone: (clonedDoc, clonedEl) => {
          const root =
            clonedEl ||
            clonedDoc?.querySelector?.(".gst-invoice.invoice-doc") ||
            clonedDoc?.body;
          applyCachedStampPngToStampImages(root);
        },
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css"] },
    };
    const chain = h2p().set(opts).from(node);
    if (typeof chain.outputPdf === "function") {
      return await chain.outputPdf("blob");
    }
    if (typeof chain.output === "function") {
      return await chain.output("blob");
    }
    throw new Error("PDF export is not supported in this browser.");
  } finally {
    rootEl.classList.remove("invoice-pdf-emulate-print");
  }
}

async function downloadHistoryFilteredZip() {
  if (historyBulkDownloadBusy) {
    showToast("A bulk download is already in progress.", { type: "info" });
    return;
  }
  historyBulkDownloadBusy = true;
  try {
  if (!currentUser) {
    showToast("Sign in to download invoices.", { type: "error" });
    return;
  }
  if (!historyCache || !historyCache.length) {
    showToast("No invoices loaded. Refresh the page or open History again.", { type: "error" });
    return;
  }
  const filtered = filterHistoryRows(historyCache, readHistoryCriteria());
  const sorted = sortHistoryFilteredRows(filtered);
  if (!sorted.length) {
    showToast("No invoices match the current filters.", { type: "error" });
    return;
  }
  const rows = sorted.slice(0, BULK_HISTORY_PDF_MAX);
  if (sorted.length > BULK_HISTORY_PDF_MAX) {
    showToast(
      `Downloading the first ${BULK_HISTORY_PDF_MAX} of ${sorted.length} matching invoices. Narrow filters to include the rest in another ZIP.`,
      { type: "info" }
    );
  }
  if (!window.JSZip) {
    showToast("ZIP library not loaded. Refresh the page and try again.", { type: "error" });
    return;
  }
  if (!window.html2pdf) {
    showToast("PDF library not loaded. Refresh the page and try again.", { type: "error" });
    return;
  }

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-12000px;top:0;width:${INVOICE_PDF_CAPTURE_WIDTH_PX}px;max-width:100vw;pointer-events:none;z-index:-1;overflow:visible;`;
  document.body.appendChild(host);

  showLoading("Preparing ZIP…");
  const usedNames = new Set();
  const zip = new window.JSZip();
  let added = 0;

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const prog = document.querySelector(".app-loading-text");
      if (prog) prog.textContent = `Generating PDF ${i + 1} / ${rows.length}…`;

      const inv = await getInvoiceById(db, row.id);
      if (!inv || !canAccessInvoice(currentUser, inv.userId)) continue;

      const node = renderInvoiceDocument(inv);
      host.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "invoice-print-outer";
      wrap.appendChild(node);
      host.appendChild(wrap);
      await new Promise((r) => requestAnimationFrame(r));

      const blob = await invoiceNodeToPdfBlob(wrap);
      const fname = uniquePdfFilenameInZip(inv.invoiceNumber || inv.id || row.id, usedNames);
      zip.file(fname, blob);
      added += 1;
    }

    if (added === 0) {
      showToast("No invoices could be exported.", { type: "error" });
      return;
    }

    const prog2 = document.querySelector(".app-loading-text");
    if (prog2) prog2.textContent = "Creating ZIP file…";
    const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const stamp = formatLocalYmd();
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoices-${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Downloaded ${added} invoice PDF${added === 1 ? "" : "s"} in one ZIP.`);
  } catch (e) {
    showToast(e.message || "Could not create ZIP.", { type: "error" });
  } finally {
    host.remove();
    hideLoading();
  }
} finally {
  historyBulkDownloadBusy = false;
}
}

function setupHistoryBulkDownload() {
  document.getElementById("btn-history-bulk-pdf")?.addEventListener("click", () => downloadHistoryFilteredZip());
}

/** Deleted / read-only invoice view: no edit or delete (clears prior live-invoice handlers). */
function applyInvoiceViewActionsReadOnly() {
  const btnEdit = document.getElementById("btn-invoice-edit");
  const btnDel = document.getElementById("btn-invoice-delete");
  if (btnEdit) {
    btnEdit.hidden = true;
    btnEdit.setAttribute("aria-hidden", "true");
    btnEdit.setAttribute("aria-disabled", "true");
    btnEdit.removeAttribute("href");
    btnEdit.tabIndex = -1;
    btnEdit.onclick = (e) => {
      e.preventDefault();
    };
  }
  if (btnDel) {
    btnDel.hidden = true;
    btnDel.disabled = true;
    btnDel.onclick = null;
  }
}

/** Undo read-only state before loading a live invoice (e.g. after viewing a deleted copy). */
function resetInvoiceViewActionsForLiveInvoice() {
  const btnEdit = document.getElementById("btn-invoice-edit");
  const btnDel = document.getElementById("btn-invoice-delete");
  if (btnEdit) {
    btnEdit.removeAttribute("aria-hidden");
    btnEdit.removeAttribute("aria-disabled");
    btnEdit.removeAttribute("tabIndex");
  }
  if (btnDel) btnDel.disabled = false;
}

async function renderInvoicePage(id) {
  resetInvoiceViewActionsForLiveInvoice();
  const archBanner = document.getElementById("invoice-view-archived-banner");
  if (archBanner) {
    archBanner.classList.add("hidden");
    archBanner.textContent = "";
  }
  const root = document.getElementById("invoice-print-root");
  if (!root) {
    invoiceBreadcrumbState = "error";
    return;
  }
  root.replaceChildren();
  const sheetMount = document.createElement("div");
  sheetMount.className = "invoice-view-sheet-wrap";
  root.appendChild(sheetMount);
  const invViewTitle = document.getElementById("invoice-view-page-title-text");
  if (invViewTitle) invViewTitle.textContent = "GST invoice";
  if (!currentUser) {
    invoiceBreadcrumbState = "error";
    return;
  }

  const btnEdit = document.getElementById("btn-invoice-edit");
  const btnDel = document.getElementById("btn-invoice-delete");
  if (btnEdit) btnEdit.hidden = true;
  if (btnDel) btnDel.hidden = true;

  let inv;
  try {
    inv = await getInvoiceById(db, id);
  } catch (ex) {
    invoiceBreadcrumbState = "error";
    root.innerHTML = `<p class="muted">${escapeHtml(formatAppError(ex, "Could not load invoice."))}</p>`;
    showToast(formatAppError(ex, "Could not load invoice."), { type: "error" });
    return;
  }
  if (!inv || !canAccessInvoice(currentUser, inv.userId)) {
    invoiceBreadcrumbState = "error";
    root.innerHTML = `<p class="muted">Invoice not found.</p>`;
    if (btnEdit) btnEdit.hidden = true;
    if (btnDel) btnDel.hidden = true;
    return;
  }

  if (btnEdit) {
    btnEdit.href = `#/create?edit=${encodeURIComponent(id)}`;
    btnEdit.hidden = false;
    if (isInvoiceStatusPaid(inv)) {
      btnEdit.onclick = (e) => {
        e.preventDefault();
        if (window.confirm(PAID_INVOICE_EDIT_WARNING)) {
          suppressPaidInvoiceEditWarning = true;
          window.location.hash = `#/create?edit=${encodeURIComponent(id)}`;
        }
      };
    } else {
      btnEdit.onclick = null;
    }
  }
  if (btnDel) {
    btnDel.hidden = false;
    btnDel.onclick = async () => {
      const label = inv.invoiceNumber || id;
      if (
        !window.confirm(
          `Delete invoice ${label}? This cannot be undone. The customer’s outstanding balance will be adjusted if this invoice was linked to a customer.`
        )
      ) {
        return;
      }
      try {
        await withLoading(() => deleteInvoice(db, currentUser.uid, id), "Deleting invoice…");
        showToast(`Invoice ${label} deleted.`);
        window.location.hash = "#/history";
      } catch (e) {
        const code = e && e.code;
        const msg = firestorePermissionHint(e) || e.message || "Could not delete invoice.";
        if (code === "permission-denied") {
          const ok = window.confirm(
            "Full delete failed (Firestore blocked updating the customer or writing the ledger — often unpublished rules or a bad customer userId). Delete this invoice only? The customer balance in the app will not be adjusted; fix it in Firebase if needed."
          );
          if (ok) {
            try {
              await withLoading(() => deleteInvoiceDocumentOnly(db, currentUser.uid, id), "Deleting invoice…");
              showToast("Invoice deleted (customer balance not adjusted automatically).");
              window.location.hash = "#/history";
            } catch (e2) {
              showToast(firestorePermissionHint(e2) || e2.message || "Could not delete invoice.", {
                type: "error",
              });
            }
            return;
          }
        }
        showToast(msg, { type: "error" });
      }
    };
  }

  const stampChk = document.getElementById("invoice-view-show-stamp");
  if (stampChk) stampChk.checked = false;
  const typeSel = document.getElementById("invoice-view-type-select");
  if (typeSel) typeSel.value = "";

  function getInvoiceTypeLabel() {
    const sel = document.getElementById("invoice-view-type-select");
    if (!sel) return "";
    const v = sel.value;
    if (v === "original") return "Original for Recipient";
    if (v === "duplicate") return "Duplicate for Transporter";
    return "";
  }

  let viewNode;
  function mountInvoiceView() {
    const includeStamp = stampChk ? stampChk.checked : false;
    const invoiceTypeLabel = getInvoiceTypeLabel();
    const newNode = renderInvoiceDocument(inv, { includeStamp, invoiceTypeLabel });
    sheetMount.replaceChildren(newNode);
    viewNode = newNode;
  }

  try {
    mountInvoiceView();
  } catch (ex) {
    invoiceBreadcrumbState = "error";
    root.innerHTML = `<p class="muted">${escapeHtml(formatAppError(ex, "Could not render invoice."))}</p>`;
    showToast(formatAppError(ex, "Could not render invoice."), { type: "error" });
    return;
  }

  if (stampChk) {
    stampChk.onchange = () => mountInvoiceView();
  }
  if (typeSel) {
    typeSel.onchange = () => mountInvoiceView();
  }
  invoiceBreadcrumbLabel = inv.invoiceNumber || id;
  invoiceBreadcrumbState = "ready";
  const invTitleEl = document.getElementById("invoice-view-page-title-text");
  if (invTitleEl) {
    const num = inv.invoiceNumber || id;
    invTitleEl.textContent = num ? `GST invoice · ${num}` : "GST invoice";
  }

  const dl = document.getElementById("btn-download-pdf");
  const pr = document.getElementById("btn-print");
  if (!dl || !pr) return;

  dl.onclick = async () => {
    try {
      if (!window.html2pdf) {
        showToast("PDF library not loaded. Refresh the page and try again.", { type: "error" });
        return;
      }
      const safeName = String(inv.invoiceNumber || "invoice").replace(/[^a-zA-Z0-9-_]/g, "_");
      await withLoading(async () => {
        await new Promise((r) => requestAnimationFrame(r));
        const pdfCaptureEl = document.getElementById("invoice-print-root") || viewNode;
        const blob = await invoiceNodeToPdfBlob(pdfCaptureEl);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }, "Generating PDF…");
      showToast("PDF generated successfully.");
    } catch (e) {
      showToast(e.message || "Could not generate PDF.", { type: "error" });
    }
  };

  pr.onclick = () => {
    printInvoice();
    showToast("Print dialog opened.");
  };
}

async function renderDeletedInvoicePage(archiveId) {
  applyInvoiceViewActionsReadOnly();
  const archBanner = document.getElementById("invoice-view-archived-banner");
  if (archBanner) {
    archBanner.classList.remove("hidden");
    archBanner.textContent =
      "This invoice was deleted. The layout below is a read-only snapshot from when it was removed.";
  }

  const root = document.getElementById("invoice-print-root");
  if (!root) {
    invoiceBreadcrumbState = "error";
    return;
  }
  root.replaceChildren();
  const sheetMount = document.createElement("div");
  sheetMount.className = "invoice-view-sheet-wrap";
  root.appendChild(sheetMount);

  if (!currentUser) {
    invoiceBreadcrumbState = "error";
    return;
  }

  let arch;
  try {
    arch = await getDeletedInvoiceArchiveById(db, currentUser.uid, archiveId);
  } catch (ex) {
    invoiceBreadcrumbState = "error";
    root.innerHTML = `<p class="muted">${escapeHtml(formatAppError(ex, "Could not load archived invoice."))}</p>`;
    showToast(formatAppError(ex, "Could not load archived invoice."), { type: "error" });
    return;
  }
  if (!arch) {
    invoiceBreadcrumbState = "error";
    root.innerHTML = `<p class="muted">Archived invoice not found.</p>`;
    showToast("Archived invoice not found.", { type: "error" });
    return;
  }

  const inv = invoiceViewModelFromDeletedArchive(arch);
  const items = Array.isArray(inv?.items) ? inv.items : [];

  const stampChk = document.getElementById("invoice-view-show-stamp");
  if (stampChk) stampChk.checked = false;
  const typeSel = document.getElementById("invoice-view-type-select");
  if (typeSel) typeSel.value = "";

  function getInvoiceTypeLabel() {
    const sel = document.getElementById("invoice-view-type-select");
    if (!sel) return "";
    const v = sel.value;
    if (v === "original") return "Original for Recipient";
    if (v === "duplicate") return "Duplicate for Transporter";
    return "";
  }

  let viewNode;
  function mountInvoiceView() {
    const includeStamp = stampChk ? stampChk.checked : false;
    const invoiceTypeLabel = getInvoiceTypeLabel();
    const newNode = renderInvoiceDocument(inv, { includeStamp, invoiceTypeLabel });
    sheetMount.replaceChildren(newNode);
    viewNode = newNode;
  }

  if (items.length === 0) {
    sheetMount.innerHTML = `<p class="muted">Line items were not stored in this archive. Only register summary fields are available for older deletions.</p>`;
    invoiceBreadcrumbLabel = arch.invoiceNumber || archiveId;
    invoiceBreadcrumbState = "ready";
    const invTitleEl = document.getElementById("invoice-view-page-title-text");
    if (invTitleEl) {
      const num = arch.invoiceNumber || archiveId;
      invTitleEl.textContent = num ? `GST invoice · ${num} (deleted)` : "GST invoice (deleted)";
    }
    const dl = document.getElementById("btn-download-pdf");
    const pr = document.getElementById("btn-print");
    if (dl) {
      dl.onclick = () =>
        showToast("PDF is not available for this archive because line items were not saved.", { type: "error" });
    }
    if (pr) {
      pr.onclick = () =>
        showToast("Print is not available for this archive because line items were not saved.", { type: "error" });
    }
    if (stampChk) stampChk.onchange = null;
    if (typeSel) typeSel.onchange = null;
    return;
  }

  try {
    mountInvoiceView();
  } catch (ex) {
    invoiceBreadcrumbState = "error";
    root.innerHTML = `<p class="muted">${escapeHtml(formatAppError(ex, "Could not render invoice."))}</p>`;
    showToast(formatAppError(ex, "Could not render invoice."), { type: "error" });
    return;
  }

  if (stampChk) stampChk.onchange = () => mountInvoiceView();
  if (typeSel) typeSel.onchange = () => mountInvoiceView();

  invoiceBreadcrumbLabel = inv.invoiceNumber || archiveId;
  invoiceBreadcrumbState = "ready";
  const invTitleEl = document.getElementById("invoice-view-page-title-text");
  if (invTitleEl) {
    const num = inv.invoiceNumber || archiveId;
    invTitleEl.textContent = num ? `GST invoice · ${num} (deleted)` : "GST invoice (deleted)";
  }

  const dl = document.getElementById("btn-download-pdf");
  const pr = document.getElementById("btn-print");
  if (!dl || !pr) return;

  dl.onclick = async () => {
    try {
      if (!window.html2pdf) {
        showToast("PDF library not loaded. Refresh the page and try again.", { type: "error" });
        return;
      }
      const safeName = String(inv.invoiceNumber || "invoice").replace(/[^a-zA-Z0-9-_]/g, "_");
      await withLoading(async () => {
        await new Promise((r) => requestAnimationFrame(r));
        const pdfCaptureEl = document.getElementById("invoice-print-root") || viewNode;
        const blob = await invoiceNodeToPdfBlob(pdfCaptureEl);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }, "Generating PDF…");
      showToast("PDF generated successfully.");
    } catch (e) {
      showToast(e.message || "Could not generate PDF.", { type: "error" });
    }
  };

  pr.onclick = () => {
    printInvoice();
    showToast("Print dialog opened.");
  };
}

function setupLogout() {
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    try {
      await withLoading(() => signOutUser(), "Signing out…");
      showToast("Signed out successfully.");
      window.location.hash = "#/login";
    } catch (ex) {
      showToast(formatAppError(ex, "Could not sign out."), { type: "error" });
    }
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const { protocol, hostname } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return;
  if (hostname === "localhost" || protocol === "https:" || hostname === "127.0.0.1") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

window.addEventListener("hashchange", () => route());

onUserChanged((user) => {
  currentUser = user;
  if (bootEl) bootEl.classList.add("hidden");

  if (!user) {
    historyCache = null;
    window.location.hash = "#/login";
  }
  route();
});

setupAuthForm();
setupLoginHeroCarousel();
setupSettingsForm();
setupSettingsHardRefresh();
setupDevAccountResetUI({
  db,
  getUid: () => currentUser?.uid,
  onAfterReset: () => {
    historyCache = null;
    customersPageCache = null;
    customerInvoicesByCustomerIdCache = new Map();
    quickOrdersOpenCache = [];
    invalidateDashboardCachesForDevReset();
    window.location.hash = "#/dashboard";
  },
});
setupInvoiceForm();
setupInvoicePreviewModal();
setupCustomerEditModal();
setupCustomerPaymentModal();
setupCustomerInvoicesModal();
setupLogout();
setupHistoryBulkDownload();
setupQuickOrdersPage();
registerServiceWorker();

if (isConfigPlaceholder() && bootEl) {
  bootEl.textContent = "Set your Firebase keys in firebase-config.js, then refresh.";
}

route();
