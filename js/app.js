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
  listInvoicesForUser,
  getInvoiceById,
  formatInvoiceDate,
} from "./invoices.js";
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
import { withLoading } from "./loading.js";
import { showToast } from "./toast.js";

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

let currentUser = null;
let authModeSignIn = true;
let invoiceFormApi = null;

/** Form payload waiting for user to confirm in preview modal */
let pendingInvoicePayload = null;

/** Customers page: Firestore id being edited in the modal */
let editingCustomerId = null;

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
  return { route, id, customerId };
}

async function route() {
  const { route: r, id, customerId } = parseHash();

  if (r !== "create") {
    closeInvoicePreviewModal();
    pendingInvoicePayload = null;
  }

  if (r !== "customers") {
    closeCustomerEditModal();
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
        try {
          const list = await listCustomers(db, currentUser.uid);
          invoiceFormApi.setCustomerOptions(list);
          if (customerId && list.some((c) => c.id === customerId)) {
            await invoiceFormApi.selectCustomerById(customerId);
          }
        } catch (e) {
          console.error(e);
        }
        invoiceFormApi.ensureOneRow();
        invoiceFormApi.recalcTotals();
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
    return "Firestore blocked this (rules). In Firebase: Firestore Database → Rules → paste rules from FIREBASE_SETUP.md or firestore.rules → Publish.";
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
    if (!pendingInvoicePayload || !currentUser) return;
    const errEl = document.getElementById("invoice-form-error");
    errEl.textContent = "";
    const payload = pendingInvoicePayload;

    try {
      await withLoading(async () => {
        if (!payload.selectedCustomerId) {
          await addCustomer(db, currentUser.uid, customerPayloadFromInvoice(payload));
        } else if (payload.selectedCustomerId) {
          await updateCustomer(db, payload.selectedCustomerId, customerPayloadFromInvoice(payload));
        }

        const seller = await loadUserSettings(currentUser.uid);
        if (!seller.sellerName || !seller.sellerAddress || !seller.sellerPhone) {
          throw new Error("SELLER_INCOMPLETE");
        }

        const full = mergeSellerIntoInvoicePayload(payload, seller);
        delete full.selectedCustomerId;

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
      }, "Saving invoice…");
    } catch (ex) {
      if (ex.message === "SELLER_INCOMPLETE") {
        errEl.textContent = "Complete Seller settings before creating an invoice.";
        window.location.hash = "#/settings";
        return;
      }
      errEl.textContent =
        firestorePermissionHint(ex) || ex.message || "Could not save invoice.";
      if (ex.code === "failed-precondition") {
        errEl.textContent +=
          " If this mentions an index, open the link in the browser console to create it.";
      }
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
      errEl.textContent = "";
      if (!currentUser) return;

      const seller = await withLoading(
        () => loadUserSettings(currentUser.uid),
        "Loading…"
      );
      if (!seller.sellerName || !seller.sellerAddress || !seller.sellerPhone) {
        errEl.textContent = "Complete Seller settings before creating an invoice.";
        window.location.hash = "#/settings";
        return;
      }

      pendingInvoicePayload = payload;
      const merged = mergeSellerIntoInvoicePayload(payload, seller);
      const inv = { ...merged, date: new Date(), invoiceNumber: "" };
      delete inv.selectedCustomerId;

      const scroll = document.getElementById("invoice-preview-scroll");
      scroll.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "invoice-print-outer";
      wrap.appendChild(renderInvoiceDocument(inv));
      scroll.appendChild(wrap);

      const modal = document.getElementById("invoice-preview-modal");
      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
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

async function renderCustomersPage() {
  const listEl = document.getElementById("customers-list");
  const emptyEl = document.getElementById("customers-empty");
  listEl.innerHTML = "";
  if (!currentUser) return;

  let rows;
  try {
    rows = await listCustomers(db, currentUser.uid);
  } catch (ex) {
    emptyEl.hidden = false;
    emptyEl.textContent =
      ex.message ||
      "Could not load customers. Check Firestore rules for the customers collection.";
    return;
  }
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
    li.innerHTML = `<div class="customer-card">
      <strong>${escapeHtml(row.name || "")}</strong>
      <div class="meta">${phone} · ${addr}${(row.address || "").length > 80 ? "…" : ""}</div>
      <div class="btn-row customer-card-actions">
        <a class="btn btn-secondary btn-small" href="#/create?customer=${encodeURIComponent(row.id)}">Use in invoice</a>
        <button type="button" class="btn btn-secondary btn-small btn-edit-customer" data-id="${escapeHtml(row.id)}">Edit</button>
        <button type="button" class="btn btn-ghost btn-small btn-del-customer" data-id="${escapeHtml(row.id)}">Delete</button>
      </div>
    </div>`;
    listEl.appendChild(li);
  }
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
  listEl.innerHTML = "";
  if (!currentUser) return;

  let rows;
  try {
    rows = await listInvoicesForUser(db, currentUser.uid);
  } catch (ex) {
    emptyEl.hidden = false;
    emptyEl.textContent =
      ex.message ||
      "Could not load history. If the console mentions an index, open the link to create it in Firebase.";
    return;
  }
  emptyEl.textContent = "No invoices yet.";
  if (!rows.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const row of rows) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#/invoice/${row.id}`;
    const dateStr = formatInvoiceDate(row.date);
    a.innerHTML = `<strong>${escapeHtml(row.invoiceNumber)}</strong> — ${escapeHtml(row.customerName)}<div class="meta"><span>${escapeHtml(dateStr)}</span><span>₹ ${Number(row.total).toFixed(2)}</span></div>`;
    li.appendChild(a);
    listEl.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderInvoicePage(id) {
  const root = document.getElementById("invoice-print-root");
  root.innerHTML = "";
  if (!currentUser) return;

  const inv = await getInvoiceById(db, id);
  if (!inv || !canAccessInvoice(currentUser, inv.userId)) {
    root.innerHTML = `<p class="muted">Invoice not found.</p>`;
    return;
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
    window.location.hash = "#/login";
  }
  route();
});

setupAuthForm();
setupSettingsForm();
setupInvoiceForm();
setupInvoicePreviewModal();
setupCustomerEditModal();
setupLogout();
registerServiceWorker();

if (isConfigPlaceholder() && bootEl) {
  bootEl.textContent = "Set your Firebase keys in firebase-config.js, then refresh.";
}

route();
