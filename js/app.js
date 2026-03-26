import { initializeApp } from "firebase/app";
import { firebaseConfig } from "../firebase-config.js";
import {
  initAuthServices,
  onUserChanged,
  signUpUser,
  signInUser,
  signOutUser,
  loadUserSettings,
  saveUserSettings,
} from "./auth.js";
import {
  saveInvoice,
  updateInvoice,
  deleteInvoice,
  deleteInvoiceDocumentOnly,
  listInvoicesForUser,
  getInvoiceById,
  formatInvoiceDate,
  formatInvoiceDateTime,
  computeInvoicePaymentAmounts,
  round2,
} from "./invoices.js";
import { recordCustomerPayment, listMoneyTransactionsForCustomer } from "./payments.js";
import { initInvoiceForm, isValidGstinOptional, isValidPanOptional } from "./invoice-form.js";
import { renderInvoiceDocument, printInvoice } from "./invoice-pdf.js";
import { shouldForceLoginView, canAccessInvoice } from "./auth-guard.js";
import {
  listCustomers,
  addCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerById,
} from "./customers.js";
import { withLoading, showLoading, hideLoading } from "./loading.js";
import { showToast } from "./toast.js";
import { mountDashboard, closeDashboardDetail } from "./dashboard.js";

const app = initializeApp(firebaseConfig);
const { auth, db } = initAuthServices(app);

const bootEl = document.getElementById("boot-loading");
const navMain = document.getElementById("nav-main");

const views = {
  login: document.getElementById("view-login"),
  dashboard: document.getElementById("view-dashboard"),
  settings: document.getElementById("view-settings"),
  create: document.getElementById("view-create"),
  customers: document.getElementById("view-customers"),
  history: document.getElementById("view-history"),
  invoice: document.getElementById("view-invoice"),
};

/** Full invoice rows for history filtering (cleared when leaving / reload). */
let historyCache = null;
let historyFiltersWired = false;
let historyFilterDebounce = null;

function rowInvoiceDate(row) {
  const v = row.date;
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
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

function historyDateRange(criteria) {
  const preset = criteria.preset || "all";
  const now = new Date();
  const endToday = endOfLocalDay(now);
  if (preset === "all") return null;
  if (preset === "custom") {
    const a = parseLocalYmd(criteria.dateFrom);
    const b = parseLocalYmd(criteria.dateTo);
    if (!a || !b) return null;
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

function filterHistoryRows(rows, c) {
  const range = historyDateRange(c);
  return rows.filter((row) => {
    const d = rowInvoiceDate(row);
    if (range) {
      if (!d) return false;
      if (d.getTime() < range.start.getTime() || d.getTime() > range.end.getTime()) return false;
    }
    const customerBlob = [row.customerName, row.consigneeName].filter(Boolean).join(" ");
    if (c.customer) {
      const target = normLower(c.customer);
      const buyer = normLower(row.customerName);
      const consignee = normLower(row.consigneeName);
      if (buyer !== target && consignee !== target) return false;
    }
    const min = c.amountMin;
    const max = c.amountMax;
    if (min !== "" && min != null && Number.isFinite(Number(min)) && row.total < Number(min)) return false;
    if (max !== "" && max != null && Number.isFinite(Number(max)) && row.total > Number(max)) return false;
    if (c.paymentStatus && String(row.paymentStatus || "") !== c.paymentStatus) return false;
    if (c.paymentMethod && String(row.paymentMethod || "") !== c.paymentMethod) return false;
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

function historyPaymentStatusBadge(status) {
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
  return { label: "Unknown", mod: "history-inv-status--unknown" };
}

function renderHistoryListRows(rows) {
  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  const countEl = document.getElementById("history-count");
  listEl.innerHTML = "";
  const total = historyCache?.length ?? 0;
  if (!rows.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = total ? "No invoices match your filters." : "No invoices yet.";
    if (countEl) {
      countEl.hidden = true;
      countEl.textContent = "";
    }
    return;
  }
  emptyEl.hidden = true;
  if (countEl) {
    countEl.hidden = false;
    if (rows.length === total) {
      countEl.textContent = `${total} invoice${total === 1 ? "" : "s"}`;
    } else {
      countEl.textContent = `${rows.length} of ${total} invoice${total === 1 ? "" : "s"} match filters`;
    }
  }
  for (const row of rows) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#/invoice/${row.id}`;
    a.classList.add("history-inv-card");
    const dateStr = formatInvoiceDate(row.date);
    const badge = historyPaymentStatusBadge(row.paymentStatus);
    a.innerHTML = `<span class="history-inv-status ${badge.mod}" aria-label="Payment status: ${escapeHtml(badge.label)}">${escapeHtml(badge.label)}</span><span class="history-inv-main"><strong>${escapeHtml(row.invoiceNumber)}</strong> — ${escapeHtml(row.customerName)}</span><div class="meta"><span>${escapeHtml(dateStr)}</span><span>₹ ${Number(row.total).toFixed(2)}</span></div>`;
    li.appendChild(a);
    listEl.appendChild(li);
  }
}

function applyHistoryFilters() {
  if (!historyCache) return;
  const filtered = filterHistoryRows(historyCache, readHistoryCriteria());
  renderHistoryListRows(filtered);
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

/** Customers page: Firestore id being edited in the modal */
let editingCustomerId = null;

/** Customers page: record-payment modal target id */
let paymentCustomerId = null;

/** Filled when the Customers page loads; used by the “Show invoices” modal. */
let customerInvoicesByCustomerIdCache = new Map();

function hideAllViews() {
  Object.values(views).forEach((el) => {
    if (el) el.hidden = true;
  });
}

function showView(name) {
  hideAllViews();
  const v = views[name];
  if (v) v.hidden = false;
}

function parseHash() {
  const raw = (window.location.hash || "#/").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const route = parts[0] || "dashboard";
  const id = parts[1] || null;
  const params = new URLSearchParams(queryPart || "");
  const customerId = params.get("customer") || null;
  const editId = (params.get("edit") || "").trim() || null;
  return { route, id, customerId, editId };
}

function setCreatePageEditMode(isEdit, invoiceNumberHint) {
  const h1 = document.getElementById("create-page-title");
  if (h1) h1.textContent = isEdit ? "Edit invoice" : "Create invoice";
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
  const { route: r, id, customerId, editId } = parseHash();

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
    navMain.classList.add("hidden");
    showView("login");
    return;
  }

  navMain.classList.remove("hidden");

  if (r === "login") {
    window.location.hash = "#/dashboard";
    return;
  }

  if (r === "settings") {
    showView("settings");
    await withLoading(() => fillSettingsForm(), "Loading settings…");
    return;
  }

  if (r === "customers") {
    showView("customers");
    await withLoading(() => renderCustomersPage(), "Loading customers…");
    return;
  }

  if (r === "create") {
    showView("create");
    if (invoiceFormApi && currentUser) {
      await withLoading(async () => {
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
          editingInvoiceId = editId;
          editingInvoiceSnapshot = inv;
          const oldNet = round2(Number(inv.total) || 0) - round2(Number(inv.amountPaidOnInvoice) || 0);
          let openingBefore = null;
          if (inv.customerId) {
            const c = await getCustomerById(db, inv.customerId);
            const b = round2(Number(c?.outstandingBalance) || 0);
            openingBefore = round2(b - oldNet);
          }
          invoiceFormApi.populateFromInvoice(inv, { openingBeforeInvoice: openingBefore });
          setCreatePageEditMode(true, inv.invoiceNumber);
        } else {
          editingInvoiceId = null;
          editingInvoiceSnapshot = null;
          invoiceFormApi.resetForm();
          setCreatePageEditMode(false);
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
      }, "Loading…");
    }
    return;
  }

  if (r === "history") {
    showView("history");
    await withLoading(() => renderHistory(), "Loading invoices…");
    return;
  }

  if (r === "invoice" && id) {
    showView("invoice");
    await withLoading(() => renderInvoicePage(id), "Loading invoice…");
    return;
  }

  showView("dashboard");
  if (currentUser) {
    await withLoading(() => mountDashboard(db, currentUser.uid), "Loading dashboard…");
  }
}

function isConfigPlaceholder() {
  return (
    !firebaseConfig.apiKey ||
    firebaseConfig.apiKey === "YOUR_API_KEY" ||
    firebaseConfig.projectId === "YOUR_PROJECT_ID"
  );
}

function setupAuthForm() {
  const form = document.getElementById("form-auth");
  const err = document.getElementById("auth-error");
  const btnToggle = document.getElementById("btn-auth-toggle");
  const btnSubmit = document.getElementById("btn-auth-submit");

  btnToggle.addEventListener("click", () => {
    authModeSignIn = !authModeSignIn;
    btnSubmit.textContent = authModeSignIn ? "Sign in" : "Create account";
    btnToggle.textContent = authModeSignIn ? "Create account" : "Already have an account? Sign in";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (isConfigPlaceholder()) {
      err.textContent = "Configure firebase-config.js with your Firebase keys first.";
      return;
    }
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    try {
      if (authModeSignIn) {
        await signInUser(email, password);
        showToast("Signed in successfully.");
      } else {
        await signUpUser(email, password);
        showToast("Account created successfully.");
      }
      window.location.hash = "#/dashboard";
    } catch (ex) {
      err.textContent = ex.message || "Authentication failed.";
    }
  });
}

async function fillSettingsForm() {
  if (!currentUser) return;
  const s = await loadUserSettings(currentUser.uid);
  document.getElementById("set-name").value = s.sellerName || "";
  document.getElementById("set-subtitle").value = s.sellerSubtitle || "";
  document.getElementById("set-address").value = s.sellerAddress || "";
  document.getElementById("set-phone").value = s.sellerPhone || "";
  document.getElementById("set-gstin").value = s.sellerGstin || "";
  document.getElementById("set-email").value = s.sellerEmail || "";
  document.getElementById("set-state-name").value = s.sellerStateName || "";
  document.getElementById("set-state-code").value = s.sellerStateCode || "";
  document.getElementById("set-pan").value = s.sellerPan || "";
  document.getElementById("set-udyam").value = s.sellerUdyam || "";
  document.getElementById("set-contact-extra").value = s.sellerContactExtra || "";
  document.getElementById("set-cgst-pct").value = String(s.cgstPercent ?? 2.5);
  document.getElementById("set-sgst-pct").value = String(s.sgstPercent ?? 2.5);
  document.getElementById("set-acc-holder").value = s.accountHolderName || "";
  document.getElementById("set-bank-name").value = s.bankName || "";
  document.getElementById("set-bank-branch").value = s.bankBranch || "";
  document.getElementById("set-bank-account").value = s.bankAccount || "";
  document.getElementById("set-bank-ifsc").value = s.bankIfsc || "";
  document.getElementById("set-jurisdiction").value = s.jurisdictionFooter || "";
  document.getElementById("set-terms").value = s.invoiceTerms || "";
  document.getElementById("settings-error").textContent = "";
  document.getElementById("settings-success").textContent = "";
}

function setupSettingsForm() {
  const form = document.getElementById("form-settings");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("settings-error");
    const okEl = document.getElementById("settings-success");
    errEl.textContent = "";
    okEl.textContent = "";
    if (!currentUser) return;

    const sellerName = document.getElementById("set-name").value.trim();
    const sellerAddress = document.getElementById("set-address").value.trim();
    const sellerPhone = document.getElementById("set-phone").value.trim();
    const sellerGstin = document.getElementById("set-gstin").value.trim().toUpperCase();
    const cgst = parseFloat(document.getElementById("set-cgst-pct").value);
    const sgst = parseFloat(document.getElementById("set-sgst-pct").value);

    if (!sellerName || !sellerAddress || !sellerPhone) {
      errEl.textContent = "Fill business name, address, and phone.";
      return;
    }
    if (Number.isNaN(cgst) || cgst < 0 || cgst > 100 || Number.isNaN(sgst) || sgst < 0 || sgst > 100) {
      errEl.textContent = "CGST and SGST must be between 0 and 100.";
      return;
    }

    try {
      await withLoading(
        () =>
          saveUserSettings(currentUser.uid, {
        sellerName,
        sellerSubtitle: document.getElementById("set-subtitle").value.trim(),
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
      errEl.textContent = firestorePermissionHint(ex) || ex.message || "Could not save.";
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

function mergeSellerIntoInvoicePayload(payload, seller) {
  return {
    ...payload,
    sellerName: seller.sellerName,
    sellerSubtitle: seller.sellerSubtitle || "",
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
          ? "Complete Seller settings before creating an invoice."
          : firestorePermissionHint(ex) || ex.message || "Could not save invoice.";
      const detail =
        ex.code === "failed-precondition"
          ? `${msg} If this mentions an index, open the link in the browser console to create it.`
          : msg;
      if (ex.message === "SELLER_INCOMPLETE") {
        window.location.hash = "#/settings";
      }
      if (previewErr) previewErr.textContent = detail;
      if (errEl) errEl.textContent = detail;
      showToast(detail, { type: "error" });
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
  invoiceFormApi = initInvoiceForm({
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
          if (errEl) errEl.textContent = "Complete Seller settings before creating an invoice.";
          window.location.hash = "#/settings";
          return;
        }

        const merged = mergeSellerIntoInvoicePayload(payload, seller);
        const { amountPaidOnInvoice, normalizedStatus } = computeInvoicePaymentAmounts(
          payload.total,
          payload.paymentStatus,
          payload.amountPaidOnInvoice
        );

        let prevSnap = 0;
        let currSnap = 0;

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
          currSnap = round2(prevSnap + Number(payload.total) - amountPaidOnInvoice);
        } else {
          if (payload.selectedCustomerId) {
            const c = await getCustomerById(db, payload.selectedCustomerId);
            prevSnap = round2(Number(c?.outstandingBalance) || 0);
          }
          currSnap = round2(prevSnap + Number(payload.total) - amountPaidOnInvoice);
        }

        const inv = {
          ...merged,
          date: editingInvoiceSnapshot ? editingInvoiceSnapshot.date : new Date(),
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
        if (errEl) errEl.textContent = msg;
        showToast(msg, { type: "error" });
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
  toggleEditConsigneeFields();
}

async function openCustomerEditModal(customerId) {
  if (!currentUser || !customerId) return;
  const errEl = document.getElementById("edit-customer-error");
  if (errEl) errEl.textContent = "";

  const c = await withLoading(() => getCustomerById(db, customerId), "Loading…");
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

  const modal = document.getElementById("customer-edit-modal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("edit-cust-name").focus();
}

function closeCustomerPaymentModal() {
  paymentCustomerId = null;
  const modal = document.getElementById("customer-payment-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
  const form = document.getElementById("form-customer-payment");
  if (form) form.reset();
  const errEl = document.getElementById("customer-payment-error");
  if (errEl) errEl.textContent = "";
  const ul = document.getElementById("pay-tx-list");
  if (ul) ul.innerHTML = "";
}

async function openCustomerPaymentModal(customerId) {
  if (!currentUser || !customerId) return;
  const errEl = document.getElementById("customer-payment-error");
  if (errEl) errEl.textContent = "";

  const c = await withLoading(() => getCustomerById(db, customerId), "Loading…");
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

  const ul = document.getElementById("pay-tx-list");
  if (ul) {
    ul.innerHTML = "";
    try {
      const txs = await listMoneyTransactionsForCustomer(db, currentUser.uid, customerId, 25);
      const typeShort = (t) => {
        if (t === "INVOICE_TOTAL") return "Invoice total";
        if (t === "PAYMENT_ON_INVOICE") return "Payment (on invoice)";
        if (t === "PAYMENT_STANDALONE") return "Payment";
        if (t === "INVOICE_ADJUSTMENT") return "Invoice adjustment";
        return t || "Entry";
      };
      const txAmount = (tx) => {
        if (tx.type === "INVOICE_ADJUSTMENT" && tx.receivableDelta != null) {
          return round2(Number(tx.receivableDelta));
        }
        return round2(Number(tx.amount) || 0);
      };
      for (const tx of txs) {
        const li = document.createElement("li");
        const amt = txAmount(tx);
        const dt = tx.createdAt ? formatInvoiceDate(tx.createdAt) : "—";
        const invNo = tx.invoiceNumber ? ` ${tx.invoiceNumber}` : "";
        let alloc = "";
        if (tx.type === "PAYMENT_STANDALONE" && Array.isArray(tx.allocatedInvoices) && tx.allocatedInvoices.length) {
          const nums = tx.allocatedInvoices.map((a) => a.invoiceNumber || "").filter(Boolean);
          if (nums.length) {
            const shown = nums.slice(0, 4);
            alloc = ` → ${shown.join(", ")}${nums.length > 4 ? "…" : ""}`;
          }
        }
        li.textContent = `${dt} · ${typeShort(tx.type)}${invNo}${alloc} · ₹ ${amt.toFixed(2)}`;
        ul.appendChild(li);
      }
    } catch (_) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Could not load transactions.";
      ul.appendChild(li);
    }
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
  if (!form || !btnCancel) return;

  btnCancel.addEventListener("click", () => closeCustomerPaymentModal());
  backdrop?.addEventListener("click", () => closeCustomerPaymentModal());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("customer-payment-error");
    if (errEl) errEl.textContent = "";
    if (!paymentCustomerId || !currentUser) return;

    const raw = parseFloat(document.getElementById("pay-amount")?.value);
    if (!Number.isFinite(raw) || raw <= 0) {
      if (errEl) errEl.textContent = "Enter a valid amount.";
      return;
    }
    const method = document.getElementById("pay-method")?.value || "other";
    const note = document.getElementById("pay-note")?.value?.trim() || "";

    try {
      await withLoading(
        () =>
          recordCustomerPayment(db, currentUser.uid, {
            customerId: paymentCustomerId,
            amount: raw,
            paymentMethod: method,
            note,
          }),
        "Saving payment…"
      );
      showToast("Payment recorded.");
      closeCustomerPaymentModal();
      await renderCustomersPage();
    } catch (ex) {
      if (errEl) errEl.textContent = firestorePermissionHint(ex) || ex.message || "Could not save payment.";
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
    errEl.textContent = "";
    if (!editingCustomerId || !currentUser) return;

    const name = document.getElementById("edit-cust-name").value.trim();
    const address = document.getElementById("edit-cust-address").value.trim();
    const phone = document.getElementById("edit-cust-phone").value.trim();
    const gstin = document.getElementById("edit-cust-gstin").value.trim().toUpperCase();
    const buyerPan = document.getElementById("edit-cust-pan").value.trim().toUpperCase();
    const consigneeGstin = document.getElementById("edit-cust-consignee-gstin").value.trim().toUpperCase();
    const consigneeSame = document.getElementById("edit-cust-consignee-same").checked;

    if (!name) {
      errEl.textContent = "Enter buyer name.";
      return;
    }
    if (!address) {
      errEl.textContent = "Enter address.";
      return;
    }
    if (!phone) {
      errEl.textContent = "Enter phone number.";
      return;
    }
    if (!isValidGstinOptional(gstin)) {
      errEl.textContent = "Invalid GSTIN format (optional field).";
      return;
    }
    if (!isValidPanOptional(buyerPan)) {
      errEl.textContent = "Invalid PAN format (optional field).";
      return;
    }
    if (!consigneeSame) {
      if (!document.getElementById("edit-cust-consignee-name").value.trim()) {
        errEl.textContent = "Enter consignee name or mark same as buyer.";
        return;
      }
      if (!document.getElementById("edit-cust-consignee-address").value.trim()) {
        errEl.textContent = "Enter consignee address.";
        return;
      }
      if (!isValidGstinOptional(consigneeGstin)) {
        errEl.textContent = "Invalid consignee GSTIN format (optional field).";
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

    try {
      await withLoading(
        () => updateCustomer(db, editingCustomerId, payload),
        "Saving…"
      );
      showToast("Customer updated successfully.");
      closeCustomerEditModal();
      await renderCustomersPage();
    } catch (ex) {
      errEl.textContent = firestorePermissionHint(ex) || ex.message || "Could not save customer.";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = document.getElementById("customer-edit-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    closeCustomerEditModal();
  });
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

function openCustomerInvoicesModal(customerId, customerName) {
  const rows = customerInvoicesByCustomerIdCache.get(customerId) || [];
  const sub = document.getElementById("customer-invoices-modal-sub");
  if (sub) sub.textContent = customerName ? `Customer: ${customerName}` : "";
  const tbody = document.getElementById("customer-invoices-modal-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "muted";
    td.textContent = "No invoices saved for this customer yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const inv of rows) {
      const tr = document.createElement("tr");
      const tdNum = document.createElement("td");
      const a = document.createElement("a");
      a.href = `#/invoice/${inv.id}`;
      a.textContent = inv.invoiceNumber || "—";
      a.className = "cust-inv-modal-link";
      tdNum.appendChild(a);
      const tdAmt = document.createElement("td");
      tdAmt.className = "num";
      const amt = Number(inv.total);
      tdAmt.textContent = `₹ ${Number.isFinite(amt) ? amt.toFixed(2) : "0.00"}`;
      const tdWhen = document.createElement("td");
      tdWhen.textContent = formatInvoiceDateTime(inv.date);
      tr.appendChild(tdNum);
      tr.appendChild(tdAmt);
      tr.appendChild(tdWhen);
      tbody.appendChild(tr);
    }
  }
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

async function renderCustomersPage() {
  const listEl = document.getElementById("customers-list");
  const emptyEl = document.getElementById("customers-empty");
  listEl.innerHTML = "";
  if (!currentUser) return;

  let rows;
  let invoiceRows = [];
  try {
    [rows, invoiceRows] = await Promise.all([
      listCustomers(db, currentUser.uid),
      listInvoicesForUser(db, currentUser.uid).catch(() => []),
    ]);
  } catch (ex) {
    emptyEl.hidden = false;
    emptyEl.textContent =
      ex.message ||
      "Could not load customers. Check Firestore rules for the customers collection.";
    return;
  }
  const byCustomer = groupInvoicesByCustomerId(invoiceRows);
  customerInvoicesByCustomerIdCache = byCustomer;
  emptyEl.textContent = "No customers yet. Create an invoice and save a new buyer.";
  if (!rows.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "customer-row";
    const phone = escapeHtml(row.phone || "");
    const addr = escapeHtml((row.address || "").slice(0, 80));
    const ob = round2(Number(row.outstandingBalance) || 0);
    const custName = row.name || "";
    li.innerHTML = `<div class="customer-card">
      <strong>${escapeHtml(custName)}</strong>
      <div class="meta">${phone} · ${addr}${(row.address || "").length > 80 ? "…" : ""}</div>
      <div class="meta"><span>Outstanding: ₹ ${ob.toFixed(2)}</span></div>
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

async function renderHistory() {
  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  const countEl = document.getElementById("history-count");
  listEl.innerHTML = "";
  historyCache = null;
  if (countEl) {
    countEl.hidden = true;
    countEl.textContent = "";
  }
  if (!currentUser) return;

  let rows;
  let customers = [];
  try {
    [rows, customers] = await Promise.all([
      listInvoicesForUser(db, currentUser.uid),
      listCustomers(db, currentUser.uid).catch(() => []),
    ]);
  } catch (ex) {
    emptyEl.hidden = false;
    emptyEl.textContent =
      ex.message ||
      "Could not load history. If the console mentions an index, open the link to create it in Firebase.";
    return;
  }
  historyCache = rows;
  wireHistoryFilters();
  populateHistoryCustomerOptions(customers, rows);
  emptyEl.textContent = "No invoices yet.";
  applyHistoryFilters();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Max invoices per bulk ZIP (browser / time limits). */
const BULK_HISTORY_PDF_MAX = 100;

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
  const opts = {
    margin: [8, 8, 10, 8],
    filename: "x.pdf",
    image: { type: "jpeg", quality: 0.95 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      logging: false,
      scrollY: 0,
      scrollX: 0,
      backgroundColor: "#ffffff",
    },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: { mode: ["css"] },
  };
  const chain = h2p().set(opts).from(node);
  if (typeof chain.outputPdf === "function") {
    return chain.outputPdf("blob");
  }
  if (typeof chain.output === "function") {
    return chain.output("blob");
  }
  throw new Error("PDF export is not supported in this browser.");
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
  if (!filtered.length) {
    showToast("No invoices match the current filters.", { type: "error" });
    return;
  }
  const rows = filtered.slice(0, BULK_HISTORY_PDF_MAX);
  if (filtered.length > BULK_HISTORY_PDF_MAX) {
    showToast(
      `Downloading the first ${BULK_HISTORY_PDF_MAX} of ${filtered.length} matching invoices. Narrow filters to include the rest in another ZIP.`,
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
  host.style.cssText =
    "position:fixed;left:-12000px;top:0;width:794px;max-width:100vw;visibility:hidden;pointer-events:none;z-index:-1;";
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
      host.appendChild(node);
      await new Promise((r) => requestAnimationFrame(r));

      const blob = await invoiceNodeToPdfBlob(node);
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
    const stamp = new Date().toISOString().slice(0, 10);
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

async function renderInvoicePage(id) {
  const root = document.getElementById("invoice-print-root");
  root.innerHTML = "";
  if (!currentUser) return;

  const btnEdit = document.getElementById("btn-invoice-edit");
  const btnDel = document.getElementById("btn-invoice-delete");
  if (btnEdit) btnEdit.hidden = true;
  if (btnDel) btnDel.hidden = true;

  const inv = await getInvoiceById(db, id);
  if (!inv || !canAccessInvoice(currentUser, inv.userId)) {
    root.innerHTML = `<p class="muted">Invoice not found.</p>`;
    if (btnEdit) btnEdit.hidden = true;
    if (btnDel) btnDel.hidden = true;
    return;
  }

  if (btnEdit) {
    btnEdit.href = `#/create?edit=${encodeURIComponent(id)}`;
    btnEdit.hidden = false;
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

  const node = renderInvoiceDocument(inv);
  root.appendChild(node);

  const dl = document.getElementById("btn-download-pdf");
  const pr = document.getElementById("btn-print");

  dl.onclick = async () => {
    try {
      const opt = window.html2pdf;
      if (!opt) {
        showToast("PDF library not loaded. Refresh the page and try again.", { type: "error" });
        return;
      }
      const safeName = String(inv.invoiceNumber || "invoice").replace(/[^a-zA-Z0-9-_]/g, "_");
      await withLoading(async () => {
        await new Promise((r) => requestAnimationFrame(r));
        await opt()
          .set({
            margin: [8, 8, 10, 8],
            filename: `${safeName}.pdf`,
            image: { type: "jpeg", quality: 0.95 },
            html2canvas: {
              scale: 2,
              useCORS: true,
              logging: false,
              scrollY: 0,
              scrollX: 0,
              backgroundColor: "#ffffff",
            },
            jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
            pagebreak: { mode: ["css"] },
          })
          .from(node)
          .save();
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
  document.getElementById("btn-logout").addEventListener("click", async () => {
    await withLoading(() => signOutUser(), "Signing out…");
    showToast("Signed out successfully.");
    window.location.hash = "#/login";
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
setupSettingsForm();
setupInvoiceForm();
setupInvoicePreviewModal();
setupCustomerEditModal();
setupCustomerPaymentModal();
setupCustomerInvoicesModal();
setupLogout();
setupHistoryBulkDownload();
registerServiceWorker();

if (isConfigPlaceholder() && bootEl) {
  bootEl.textContent = "Set your Firebase keys in firebase-config.js, then refresh.";
}

route();
