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
import { initInvoiceForm } from "./invoice-form.js";
import { renderInvoiceDocument, printInvoice } from "./invoice-pdf.js";
import { shouldForceLoginView, canAccessInvoice } from "./auth-guard.js";
import {
  listCustomers,
  addCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerById,
} from "./customers.js";

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
  const h = (window.location.hash || "#/").replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  const route = parts[0] || "dashboard";
  const id = parts[1] || null;
  return { route, id };
}

async function route() {
  const { route: r, id } = parseHash();

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
    await fillSettingsForm();
    return;
  }

  if (r === "customers") {
    showView("customers");
    await renderCustomersPage();
    return;
  }

  if (r === "create") {
    showView("create");
    if (invoiceFormApi && currentUser) {
      const s = await loadUserSettings(currentUser.uid);
      invoiceFormApi.setTaxRates(s.cgstPercent, s.sgstPercent);
      try {
        const list = await listCustomers(db, currentUser.uid);
        invoiceFormApi.setCustomerOptions(list);
      } catch (e) {
        console.error(e);
      }
      invoiceFormApi.ensureOneRow();
      invoiceFormApi.recalcTotals();
    }
    return;
  }

  if (r === "history") {
    showView("history");
    await renderHistory();
    return;
  }

  if (r === "invoice" && id) {
    showView("invoice");
    await renderInvoicePage(id);
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
      } else {
        await signUpUser(email, password);
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
      await saveUserSettings(currentUser.uid, {
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
      });
      okEl.textContent = "Saved.";
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
    consigneeAddress: p.consigneeSameAsBuyer ? "" : p.consigneeAddress,
    consigneeName: p.consigneeSameAsBuyer ? "" : p.consigneeName || "",
    consigneeGstin: p.consigneeSameAsBuyer ? "" : p.consigneeGstin || "",
    consigneeStateName: p.consigneeSameAsBuyer ? "" : p.consigneeStateName || "",
    consigneeStateCode: p.consigneeSameAsBuyer ? "" : p.consigneeStateCode || "",
    consigneeSameAsBuyer: p.consigneeSameAsBuyer,
  };
}

function setupInvoiceForm() {
  invoiceFormApi = initInvoiceForm({
    loadCustomer: (id) => getCustomerById(db, id),
    onSubmit: async (payload) => {
      const errEl = document.getElementById("invoice-form-error");
      errEl.textContent = "";
      if (!currentUser) return;

      const seller = await loadUserSettings(currentUser.uid);
      if (!seller.sellerName || !seller.sellerAddress || !seller.sellerPhone) {
        errEl.textContent = "Complete Seller settings before creating an invoice.";
        window.location.hash = "#/settings";
        return;
      }

      try {
        if (!payload.selectedCustomerId && payload.saveNewCustomer) {
          await addCustomer(db, currentUser.uid, customerPayloadFromInvoice(payload));
        } else if (payload.selectedCustomerId && payload.updateCustomer) {
          await updateCustomer(db, payload.selectedCustomerId, customerPayloadFromInvoice(payload));
        }

        const full = {
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
        delete full.selectedCustomerId;
        delete full.saveNewCustomer;
        delete full.updateCustomer;

        const { id, invoiceNumber } = await saveInvoice(db, currentUser.uid, full);
        invoiceFormApi.resetForm();
        if (currentUser) {
          try {
            const list = await listCustomers(db, currentUser.uid);
            invoiceFormApi.setCustomerOptions(list);
          } catch (_) {}
          const s = await loadUserSettings(currentUser.uid);
          invoiceFormApi.setTaxRates(s.cgstPercent, s.sgstPercent);
        }
        window.location.hash = `#/invoice/${id}`;
        alert(`Saved as ${invoiceNumber}`);
      } catch (ex) {
        errEl.textContent =
          firestorePermissionHint(ex) || ex.message || "Could not save invoice.";
        if (ex.code === "failed-precondition") {
          errEl.textContent +=
            " If this mentions an index, open the link in the browser console to create it.";
        }
      }
    },
  });
  invoiceFormApi.ensureOneRow();
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
      <div class="btn-row">
        <a class="btn btn-secondary btn-small" href="#/create">Use in invoice</a>
        <button type="button" class="btn btn-ghost btn-small btn-del-customer" data-id="${escapeHtml(row.id)}">Delete</button>
      </div>
    </div>`;
    listEl.appendChild(li);
  }
  listEl.querySelectorAll(".btn-del-customer").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cid = btn.getAttribute("data-id");
      if (!cid || !confirm("Delete this customer from the list?")) return;
      try {
        await deleteCustomer(db, cid);
        await renderCustomersPage();
      } catch (ex) {
        alert(firestorePermissionHint(ex) || ex.message || "Could not delete.");
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
        alert("PDF library not loaded.");
        return;
      }
      const safeName = String(inv.invoiceNumber || "invoice").replace(/[^a-zA-Z0-9-_]/g, "_");
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
    } catch (e) {
      alert(e.message || "PDF failed.");
    }
  };

  pr.onclick = () => printInvoice();
}

function setupLogout() {
  document.getElementById("btn-logout").addEventListener("click", async () => {
    await signOutUser();
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
setupLogout();
registerServiceWorker();

if (isConfigPlaceholder() && bootEl) {
  bootEl.textContent = "Set your Firebase keys in firebase-config.js, then refresh.";
}

route();
