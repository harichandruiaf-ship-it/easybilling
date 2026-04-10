import { computeTotals, round2, roundOffRupee } from "./invoices.js";
import { withLoading } from "./loading.js";
import { showValidationToast } from "./toast.js";

const GSTIN_REGEX = /^([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

export function isValidGstinOptional(value) {
  const v = (value || "").trim().toUpperCase();
  if (!v) return true;
  return GSTIN_REGEX.test(v);
}

export function isValidPanOptional(value) {
  const v = (value || "").trim().toUpperCase();
  if (!v) return true;
  return PAN_REGEX.test(v);
}

function lineAmount(qty, rate) {
  return roundOffRupee(round2(qty * rate));
}

function createRow(tbody, data = {}) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="text" class="inv-item-name" maxlength="200" placeholder="Item" value="${escapeAttr(data.name || "")}" /></td>
    <td><input type="text" class="inv-hsn" maxlength="20" placeholder="HSN" value="${escapeAttr(data.hsn || "")}" /></td>
    <td><input type="number" class="inv-qty" min="0" step="any" value="${data.quantity ?? 1}" /></td>
    <td><input type="text" class="inv-per" maxlength="12" placeholder="Kgs" value="${escapeAttr(data.per || "Kgs")}" /></td>
    <td><input type="number" class="inv-rate" min="0" step="any" value="${data.rate ?? 0}" /></td>
    <td class="cell-amt inv-line-amt">${lineAmount(Number(data.quantity) || 0, Number(data.rate) || 0).toFixed(2)}</td>
    <td><button type="button" class="btn-icon inv-remove" aria-label="Remove row">✕</button></td>
  `;
  tbody.appendChild(tr);
  wireRow(tr);
  return tr;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function wireRow(tr) {
  const qty = tr.querySelector(".inv-qty");
  const rate = tr.querySelector(".inv-rate");
  const amtCell = tr.querySelector(".inv-line-amt");
  const recalc = () => {
    const q = parseFloat(qty.value);
    const r = parseFloat(rate.value);
    const qn = Number.isFinite(q) ? q : 0;
    const rn = Number.isFinite(r) ? r : 0;
    amtCell.textContent = lineAmount(qn, rn).toFixed(2);
  };
  qty.addEventListener("input", recalc);
  rate.addEventListener("input", recalc);
}

function toggleConsigneeField() {
  const same = document.getElementById("inv-consignee-same").checked;
  const extra = document.getElementById("inv-consignee-extra");
  const fields = extra.querySelectorAll("input, textarea");
  if (same) {
    extra.classList.add("hidden");
    fields.forEach((el) => {
      el.disabled = true;
      el.value = "";
    });
  } else {
    extra.classList.remove("hidden");
    fields.forEach((el) => {
      el.disabled = false;
    });
  }
}

function formatMoneyInr(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = round2(Number(n));
  if (v < 0) return `−₹ ${Math.abs(v).toFixed(2)} (advance)`;
  return `₹ ${v.toFixed(2)}`;
}

function syncPaymentPartialUI() {
  const st = document.getElementById("inv-payment-status")?.value || "unpaid";
  const wrap = document.getElementById("inv-amount-paid-wrap");
  const inp = document.getElementById("inv-amount-paid-on-invoice");
  if (!wrap || !inp) return;
  if (st === "partial") {
    wrap.classList.remove("hidden");
    inp.required = true;
  } else {
    wrap.classList.add("hidden");
    inp.required = false;
    inp.value = "";
  }
}

function setOutstandingLabel(amountOrNull) {
  const el = document.getElementById("inv-customer-outstanding");
  if (!el) return;
  el.textContent = amountOrNull == null ? "—" : formatMoneyInr(amountOrNull);
}

/** HTML &lt;input type="date"&gt; value (yyyy-mm-dd) → dd/mm/yyyy for Firestore / invoice print */
function isoDateToDdMmYyyy(iso) {
  const s = String(iso ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Stored dd/mm/yyyy → yyyy-mm-dd for &lt;input type="date"&gt; */
function ddMmYyyyToIsoDate(s) {
  const str = String(s ?? "").trim();
  if (!str) return "";
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}

function localDateToIsoDate(d) {
  if (!d || Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIsoDateLocal() {
  return localDateToIsoDate(new Date());
}

function invoiceDateIsoFromInv(inv) {
  const raw = inv && inv.date;
  let d = null;
  if (raw && typeof raw.toDate === "function") d = raw.toDate();
  else if (raw instanceof Date) d = raw;
  if (d && !Number.isNaN(d.getTime())) return localDateToIsoDate(d);
  return todayIsoDateLocal();
}

function normKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .trim();
}

export function initInvoiceForm(opts) {
  const tbody = document.getElementById("items-tbody");
  const btnAdd = document.getElementById("btn-add-item");
  const form = document.getElementById("form-invoice");
  if (!tbody || !btnAdd || !form) {
    console.warn("initInvoiceForm: missing invoice form DOM.");
    return {
      resetForm() {},
      recalcTotals() {},
      setTaxRates() {},
      populateFromInvoice() {},
      ensureOneRow() {},
      async selectCustomerById() {},
      setCustomerOptions() {},
    };
  }
  const customerSearchInput = document.getElementById("inv-customer-search");
  const customerIdHidden = document.getElementById("inv-customer-id");
  const listbox = document.getElementById("inv-customer-listbox");
  const combobox = document.getElementById("inv-customer-combobox");

  let taxRates = { cgstPercent: 2.5, sgstPercent: 2.5 };
  let customerList = [];
  let formPreviewBusy = false;

  function closeCustomerListbox() {
    if (!listbox) return;
    listbox.classList.add("hidden");
    listbox.hidden = true;
    customerSearchInput?.setAttribute("aria-expanded", "false");
  }

  function openCustomerListbox() {
    if (!listbox) return;
    listbox.classList.remove("hidden");
    listbox.hidden = false;
    customerSearchInput?.setAttribute("aria-expanded", "true");
  }

  function renderCustomerListbox() {
    if (!listbox) return;
    const q = normKey(customerSearchInput?.value || "");
    const matches = !q
      ? customerList.slice(0, 80)
      : customerList.filter((c) => normKey(c.name).includes(q)).slice(0, 80);

    listbox.innerHTML = "";

    const newLi = document.createElement("li");
    newLi.setAttribute("role", "option");
    newLi.className = "inv-customer-option inv-customer-option-new";
    newLi.dataset.customerId = "";
    newLi.textContent = "— New customer (enter details below) —";
    listbox.appendChild(newLi);

    for (const c of matches) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = "inv-customer-option";
      li.dataset.customerId = c.id;
      li.textContent = c.name || c.id;
      listbox.appendChild(li);
    }
  }

  async function applyCustomerSelection(customerId) {
    const id = customerId || "";
    customerIdHidden.value = id;

    if (!id) {
      customerSearchInput.value = "";
      setOutstandingLabel(null);
      document.getElementById("inv-buyer-name").value = "";
      document.getElementById("inv-buyer-address").value = "";
      document.getElementById("inv-buyer-phone").value = "";
      document.getElementById("inv-buyer-gstin").value = "";
      document.getElementById("inv-buyer-state").value = "";
      document.getElementById("inv-buyer-state-code").value = "";
      document.getElementById("inv-buyer-pan").value = "";
      document.getElementById("inv-place-of-supply").value = "";
      document.getElementById("inv-buyer-contact").value = "";
      document.getElementById("inv-buyer-email").value = "";
      document.getElementById("inv-consignee-same").checked = true;
      toggleConsigneeField();
      closeCustomerListbox();
      return;
    }

    const picked = customerList.find((c) => c.id === id);
    if (picked) {
      customerSearchInput.value = picked.name || "";
      setOutstandingLabel(round2(Number(picked.outstandingBalance) || 0));
    }

    if (opts.loadCustomer) {
      try {
        await withLoading(async () => {
          const c = await opts.loadCustomer(id);
          if (!c) return;
          setOutstandingLabel(round2(Number(c.outstandingBalance) || 0));
          document.getElementById("inv-buyer-name").value = c.name || "";
        document.getElementById("inv-buyer-address").value = c.address || "";
        document.getElementById("inv-buyer-phone").value = c.phone || "";
        document.getElementById("inv-buyer-gstin").value = c.gstin || "";
        document.getElementById("inv-buyer-state").value = c.stateName || "";
        document.getElementById("inv-buyer-state-code").value = c.stateCode || "";
        document.getElementById("inv-buyer-pan").value = c.buyerPan || "";
        document.getElementById("inv-place-of-supply").value = c.placeOfSupply || "";
        document.getElementById("inv-buyer-contact").value = c.buyerContact || "";
        document.getElementById("inv-buyer-email").value = c.buyerEmail || "";
        const same = c.consigneeSameAsBuyer !== false;
        document.getElementById("inv-consignee-same").checked = same;
        toggleConsigneeField();
        if (!same) {
          document.getElementById("inv-consignee-name").value = c.consigneeName || "";
          document.getElementById("inv-consignee-address").value = c.consigneeAddress || "";
          document.getElementById("inv-consignee-state").value = c.consigneeStateName || "";
          document.getElementById("inv-consignee-state-code").value = c.consigneeStateCode || "";
          document.getElementById("inv-consignee-gstin").value = c.consigneeGstin || "";
          document.getElementById("inv-consignee-phone").value = c.consigneePhone || "";
          document.getElementById("inv-consignee-email").value = c.consigneeEmail || "";
        }
        }, "Loading customer…");
      } catch (ex) {
        const errEl = document.getElementById("invoice-form-error");
        const msg = ex && ex.message ? String(ex.message) : "Could not load customer.";
        showValidationToast(msg, { errEl });
      }
    }
    closeCustomerListbox();
  }

  if (listbox && customerSearchInput) {
    listbox.addEventListener("mousedown", (e) => {
      const li = e.target.closest(".inv-customer-option");
      if (!li) return;
      e.preventDefault();
      const cid = li.dataset.customerId ?? "";
      applyCustomerSelection(cid);
    });

    customerSearchInput.addEventListener("input", () => {
      const hid = customerIdHidden.value;
      if (hid) {
        const cur = customerList.find((c) => c.id === hid);
        if (cur && normKey(cur.name) !== normKey(customerSearchInput.value)) {
          customerIdHidden.value = "";
          setOutstandingLabel(null);
        }
      }
      renderCustomerListbox();
      openCustomerListbox();
    });

    customerSearchInput.addEventListener("focus", () => {
      renderCustomerListbox();
      openCustomerListbox();
    });

    customerSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeCustomerListbox();
      }
    });

    document.addEventListener("click", (e) => {
      if (combobox && !combobox.contains(e.target)) {
        closeCustomerListbox();
      }
    });
  }

  function setTaxRates(cgstPercent, sgstPercent) {
    taxRates = {
      cgstPercent: Number(cgstPercent) || 0,
      sgstPercent: Number(sgstPercent) || 0,
    };
    const cgL = document.getElementById("tot-cgst-label");
    const sgL = document.getElementById("tot-sgst-label");
    if (cgL) cgL.textContent = `CGST (${taxRates.cgstPercent}%)`;
    if (sgL) sgL.textContent = `SGST (${taxRates.sgstPercent}%)`;
    recalcTotals();
  }

  function recalcTotals() {
    const rows = tbody.querySelectorAll("tr");
    let sub = 0;
    rows.forEach((tr) => {
      const q = parseFloat(tr.querySelector(".inv-qty")?.value);
      const r = parseFloat(tr.querySelector(".inv-rate")?.value);
      const qn = Number.isFinite(q) ? q : 0;
      const rn = Number.isFinite(r) ? r : 0;
      sub += lineAmount(qn, rn);
    });
    sub = round2(sub);
    const t = computeTotals(sub, taxRates.cgstPercent, taxRates.sgstPercent);
    const elSub = document.getElementById("tot-sub");
    const elCgst = document.getElementById("tot-cgst");
    const elSgst = document.getElementById("tot-sgst");
    const elTot = document.getElementById("tot-total");
    if (elSub) elSub.textContent = t.subtotal.toFixed(2);
    if (elCgst) elCgst.textContent = t.cgst.toFixed(2);
    if (elSgst) elSgst.textContent = t.sgst.toFixed(2);
    if (elTot) elTot.textContent = t.total.toFixed(2);
    return t;
  }

  tbody.addEventListener("input", (e) => {
    if (e.target.matches(".inv-qty, .inv-rate")) recalcTotals();
  });

  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".inv-remove");
    if (!btn) return;
    const tr = btn.closest("tr");
    if (tbody.querySelectorAll("tr").length <= 1) return;
    tr.remove();
    recalcTotals();
  });

  btnAdd.addEventListener("click", () => {
    createRow(tbody, { quantity: 1, rate: 0, per: "Kgs" });
    recalcTotals();
  });

  document.getElementById("inv-consignee-same").addEventListener("change", toggleConsigneeField);

  const payStatusEl = document.getElementById("inv-payment-status");
  payStatusEl?.addEventListener("change", syncPaymentPartialUI);
  syncPaymentPartialUI();

  function resetForm() {
    tbody.innerHTML = "";
    createRow(tbody, { quantity: 1, rate: 0, per: "Kgs" });
    if (customerIdHidden) customerIdHidden.value = "";
    if (customerSearchInput) customerSearchInput.value = "";
    closeCustomerListbox();
    if (listbox) listbox.innerHTML = "";
    document.getElementById("inv-buyer-name").value = "";
    document.getElementById("inv-buyer-address").value = "";
    document.getElementById("inv-buyer-phone").value = "";
    document.getElementById("inv-buyer-gstin").value = "";
    document.getElementById("inv-buyer-state").value = "";
    document.getElementById("inv-buyer-state-code").value = "";
    document.getElementById("inv-buyer-pan").value = "";
    document.getElementById("inv-place-of-supply").value = "";
    document.getElementById("inv-buyer-contact").value = "";
    document.getElementById("inv-buyer-email").value = "";
    document.getElementById("inv-consignee-same").checked = true;
    toggleConsigneeField();
    document.getElementById("inv-consignee-name").value = "";
    document.getElementById("inv-consignee-address").value = "";
    document.getElementById("inv-consignee-state").value = "";
    document.getElementById("inv-consignee-state-code").value = "";
    document.getElementById("inv-consignee-gstin").value = "";
    document.getElementById("inv-consignee-phone").value = "";
    document.getElementById("inv-consignee-email").value = "";
    document.getElementById("inv-delivery-note").value = "";
    document.getElementById("inv-payment-terms").value = "";
    document.getElementById("inv-ref-no").value = "";
    document.getElementById("inv-ref-date").value = "";
    document.getElementById("inv-other-refs").value = "";
    document.getElementById("inv-buyer-order-no").value = "";
    document.getElementById("inv-buyer-order-date").value = "";
    document.getElementById("inv-dispatch-doc").value = "";
    document.getElementById("inv-delivery-note-date").value = "";
    document.getElementById("inv-dispatch-through").value = "";
    document.getElementById("inv-destination").value = "";
    document.getElementById("inv-bol").value = "";
    document.getElementById("inv-bol-date").value = "";
    document.getElementById("inv-vehicle-no").value = "";
    document.getElementById("inv-terms-delivery").value = "";
    const paySt = document.getElementById("inv-payment-status");
    if (paySt) paySt.value = "unpaid";
    const payM = document.getElementById("inv-payment-method");
    if (payM) payM.value = "credit_sale";
    const paidInp = document.getElementById("inv-amount-paid-on-invoice");
    if (paidInp) paidInp.value = "";
    syncPaymentPartialUI();
    setOutstandingLabel(null);
    document.getElementById("inv-eway").value = "";
    const invDateEl = document.getElementById("inv-invoice-date");
    if (invDateEl) invDateEl.value = todayIsoDateLocal();
    document.getElementById("invoice-form-error").textContent = "";
    recalcTotals();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("invoice-form-error");
    if (errEl) errEl.textContent = "";

    const buyerName = document.getElementById("inv-buyer-name").value.trim();
    const buyerAddress = document.getElementById("inv-buyer-address").value.trim();
    const buyerPhone = document.getElementById("inv-buyer-phone").value.trim();
    const buyerGstin = document.getElementById("inv-buyer-gstin").value.trim().toUpperCase();
    const buyerStateName = document.getElementById("inv-buyer-state").value.trim();
    const buyerStateCode = document.getElementById("inv-buyer-state-code").value.trim();
    const buyerPan = document.getElementById("inv-buyer-pan").value.trim().toUpperCase();
    const placeOfSupply = document.getElementById("inv-place-of-supply").value.trim();
    const buyerContact = document.getElementById("inv-buyer-contact").value.trim();
    const buyerEmail = document.getElementById("inv-buyer-email").value.trim();
    const consigneeSame = document.getElementById("inv-consignee-same").checked;
    const consigneeName = document.getElementById("inv-consignee-name").value.trim();
    const consigneeAddress = document.getElementById("inv-consignee-address").value.trim();
    const consigneeGstin = document.getElementById("inv-consignee-gstin").value.trim().toUpperCase();
    const consigneeStateName = document.getElementById("inv-consignee-state").value.trim();
    const consigneeStateCode = document.getElementById("inv-consignee-state-code").value.trim();
    const consigneePhone = document.getElementById("inv-consignee-phone").value.trim();
    const consigneeEmail = document.getElementById("inv-consignee-email").value.trim();
    const ewayBillNo = document.getElementById("inv-eway").value.trim();
    const selectedCustomerId = (customerIdHidden && customerIdHidden.value) || "";
    const paymentStatus = document.getElementById("inv-payment-status")?.value || "unpaid";
    const paymentMethod = document.getElementById("inv-payment-method")?.value || "credit_sale";
    let amountPaidOnInvoice = 0;
    if (paymentStatus === "partial") {
      const rawPaid = parseFloat(document.getElementById("inv-amount-paid-on-invoice")?.value);
      if (!Number.isFinite(rawPaid) || rawPaid <= 0) {
        showValidationToast("Enter amount paid for a partial payment.", { errEl });
        return;
      }
      amountPaidOnInvoice = round2(rawPaid);
    }

    if (!buyerName) {
      showValidationToast("Enter buyer name.", { errEl });
      return;
    }
    if (!buyerAddress) {
      showValidationToast("Enter buyer address.", { errEl });
      return;
    }
    if (!buyerPhone) {
      showValidationToast("Enter phone number.", { errEl });
      return;
    }
    if (!isValidGstinOptional(buyerGstin)) {
      showValidationToast("Invalid GSTIN format (optional field).", { errEl });
      return;
    }
    if (!isValidPanOptional(buyerPan)) {
      showValidationToast("Invalid PAN format (optional field).", { errEl });
      return;
    }
    if (!consigneeSame) {
      if (!consigneeName) {
        showValidationToast("Enter consignee name or mark same as buyer.", { errEl });
        return;
      }
      if (!consigneeAddress) {
        showValidationToast("Enter consignee address.", { errEl });
        return;
      }
      if (!isValidGstinOptional(consigneeGstin)) {
        showValidationToast("Invalid consignee GSTIN format (optional field).", { errEl });
        return;
      }
    }

    const items = [];
    const rows = tbody.querySelectorAll("tr");
    for (const tr of rows) {
      const name = tr.querySelector(".inv-item-name")?.value.trim() || "";
      const hsn = tr.querySelector(".inv-hsn")?.value.trim() || "";
      const per = tr.querySelector(".inv-per")?.value.trim() || "Kgs";
      const qty = parseFloat(tr.querySelector(".inv-qty")?.value);
      const rate = parseFloat(tr.querySelector(".inv-rate")?.value);
      const qn = Number.isFinite(qty) ? qty : 0;
      const rn = Number.isFinite(rate) ? rate : 0;
      if (!name) {
        showValidationToast("Each row needs an item name.", { errEl });
        return;
      }
      if (qn <= 0) {
        showValidationToast("Quantity must be greater than zero for all items.", { errEl });
        return;
      }
      if (rn < 0) {
        showValidationToast("Rate cannot be negative.", { errEl });
        return;
      }
      items.push({
        name,
        hsn,
        per,
        quantity: qn,
        rate: rn,
        amount: lineAmount(qn, rn),
      });
    }

    if (!items.length) {
      showValidationToast("Add at least one item.", { errEl });
      return;
    }

    const totals = recalcTotals();
    const invoiceDateIso =
      document.getElementById("inv-invoice-date")?.value?.trim() || todayIsoDateLocal();
    if (opts.onPreview) {
      try {
        await opts.onPreview({
        invoiceDateIso,
        customerName: buyerName,
        buyerAddress,
        buyerPhone,
        buyerGstin,
        buyerStateName,
        buyerStateCode,
        buyerPan,
        placeOfSupply,
        buyerContact,
        buyerEmail,
        consigneeSameAsBuyer: consigneeSame,
        consigneeName: consigneeSame ? "" : consigneeName,
        consigneeAddress: consigneeSame ? "" : consigneeAddress,
        consigneeGstin: consigneeSame ? "" : consigneeGstin,
        consigneeStateName: consigneeSame ? "" : consigneeStateName,
        consigneeStateCode: consigneeSame ? "" : consigneeStateCode,
        consigneePhone: consigneeSame ? "" : consigneePhone,
        consigneeEmail: consigneeSame ? "" : consigneeEmail,
        ewayBillNo,
        deliveryNote: document.getElementById("inv-delivery-note").value.trim(),
        paymentTerms: document.getElementById("inv-payment-terms").value.trim(),
        referenceNo: document.getElementById("inv-ref-no").value.trim(),
        referenceDate: isoDateToDdMmYyyy(document.getElementById("inv-ref-date").value),
        otherReferences: document.getElementById("inv-other-refs").value.trim(),
        buyerOrderNo: document.getElementById("inv-buyer-order-no").value.trim(),
        buyerOrderDate: isoDateToDdMmYyyy(document.getElementById("inv-buyer-order-date").value),
        dispatchDocNo: document.getElementById("inv-dispatch-doc").value.trim(),
        deliveryNoteDate: isoDateToDdMmYyyy(document.getElementById("inv-delivery-note-date").value),
        dispatchedThrough: document.getElementById("inv-dispatch-through").value.trim(),
        destination: document.getElementById("inv-destination").value.trim(),
        billOfLadingNo: document.getElementById("inv-bol").value.trim(),
        billOfLadingDate: isoDateToDdMmYyyy(document.getElementById("inv-bol-date").value),
        motorVehicleNo: document.getElementById("inv-vehicle-no").value.trim(),
        termsOfDelivery: document.getElementById("inv-terms-delivery").value.trim(),
        vesselFlightNo: "",
        placeReceiptShipper: "",
        portLoading: "",
        portDischarge: "",
        eInvoiceIrn: "",
        eInvoiceAckNo: "",
        eInvoiceAckDate: "",
        eInvoiceQrUrl: "",
        paymentStatus,
        paymentMethod,
        amountPaidOnInvoice,
        selectedCustomerId,
        items,
        subtotal: totals.subtotal,
        cgst: totals.cgst,
        sgst: totals.sgst,
        total: totals.total,
        cgstPercent: totals.cgstPercent,
        sgstPercent: totals.sgstPercent,
      });
      } catch (ex) {
        const msg = ex && ex.message ? String(ex.message) : "Could not open preview.";
        showValidationToast(msg, { errEl });
      } finally {
        formPreviewBusy = false;
      }
    }
  });

  toggleConsigneeField();

  function populateFromInvoice(inv, opts = {}) {
    const openingBeforeInvoice = opts.openingBeforeInvoice;
    tbody.innerHTML = "";
    const items = Array.isArray(inv.items) ? inv.items : [];
    if (items.length) {
      for (const it of items) {
        createRow(tbody, {
          name: it.name,
          hsn: it.hsn,
          quantity: it.quantity,
          rate: it.rate,
          per: it.per || "Kgs",
        });
      }
    } else {
      createRow(tbody, { quantity: 1, rate: 0, per: "Kgs" });
    }

    setTaxRates(inv.cgstPercent, inv.sgstPercent);

    if (customerIdHidden && customerSearchInput) {
      const cid = (inv.customerId || "").trim();
      customerIdHidden.value = cid;
      if (cid) {
        const picked = customerList.find((c) => c.id === cid);
        customerSearchInput.value = picked ? picked.name || "" : inv.customerName || "";
      } else {
        customerSearchInput.value = "";
      }
    }

    document.getElementById("inv-buyer-name").value = inv.customerName || "";
    document.getElementById("inv-buyer-address").value = inv.buyerAddress || "";
    document.getElementById("inv-buyer-phone").value = inv.buyerPhone || "";
    document.getElementById("inv-buyer-gstin").value = inv.buyerGstin || "";
    document.getElementById("inv-buyer-state").value = inv.buyerStateName || "";
    document.getElementById("inv-buyer-state-code").value = inv.buyerStateCode || "";
    document.getElementById("inv-buyer-pan").value = inv.buyerPan || "";
    document.getElementById("inv-place-of-supply").value = inv.placeOfSupply || "";
    document.getElementById("inv-buyer-contact").value = inv.buyerContact || "";
    document.getElementById("inv-buyer-email").value = inv.buyerEmail || "";

    const same = inv.consigneeSameAsBuyer !== false;
    document.getElementById("inv-consignee-same").checked = same;
    toggleConsigneeField();
    if (!same) {
      document.getElementById("inv-consignee-name").value = inv.consigneeName || "";
      document.getElementById("inv-consignee-address").value = inv.consigneeAddress || "";
      document.getElementById("inv-consignee-state").value = inv.consigneeStateName || "";
      document.getElementById("inv-consignee-state-code").value = inv.consigneeStateCode || "";
      document.getElementById("inv-consignee-gstin").value = inv.consigneeGstin || "";
      document.getElementById("inv-consignee-phone").value = inv.consigneePhone || "";
      document.getElementById("inv-consignee-email").value = inv.consigneeEmail || "";
    }

    document.getElementById("inv-delivery-note").value = inv.deliveryNote || "";
    document.getElementById("inv-payment-terms").value = inv.paymentTerms || "";
    document.getElementById("inv-ref-no").value = inv.referenceNo || "";
    document.getElementById("inv-ref-date").value = ddMmYyyyToIsoDate(inv.referenceDate || "");
    document.getElementById("inv-other-refs").value = inv.otherReferences || "";
    document.getElementById("inv-buyer-order-no").value = inv.buyerOrderNo || "";
    document.getElementById("inv-buyer-order-date").value = ddMmYyyyToIsoDate(inv.buyerOrderDate || "");
    document.getElementById("inv-dispatch-doc").value = inv.dispatchDocNo || "";
    document.getElementById("inv-delivery-note-date").value = ddMmYyyyToIsoDate(inv.deliveryNoteDate || "");
    document.getElementById("inv-dispatch-through").value = inv.dispatchedThrough || "";
    document.getElementById("inv-destination").value = inv.destination || "";
    document.getElementById("inv-bol").value = inv.billOfLadingNo || "";
    document.getElementById("inv-bol-date").value = ddMmYyyyToIsoDate(inv.billOfLadingDate || "");
    document.getElementById("inv-vehicle-no").value = inv.motorVehicleNo || "";
    document.getElementById("inv-terms-delivery").value = inv.termsOfDelivery || "";
    document.getElementById("inv-eway").value = inv.ewayBillNo || "";
    const invDateEl = document.getElementById("inv-invoice-date");
    if (invDateEl) invDateEl.value = invoiceDateIsoFromInv(inv);

    const paySt = document.getElementById("inv-payment-status");
    if (paySt) paySt.value = inv.paymentStatus || "unpaid";
    const payM = document.getElementById("inv-payment-method");
    if (payM) payM.value = inv.paymentMethod || "credit_sale";
    const paidInp = document.getElementById("inv-amount-paid-on-invoice");
    if (paidInp) {
      if ((inv.paymentStatus || "") === "partial") {
        paidInp.value = String(inv.amountPaidOnInvoice ?? "");
      } else {
        paidInp.value = "";
      }
    }
    syncPaymentPartialUI();

    setOutstandingLabel(openingBeforeInvoice != null ? openingBeforeInvoice : null);
    document.getElementById("invoice-form-error").textContent = "";
    recalcTotals();
  }

  return {
    resetForm,
    recalcTotals,
    setTaxRates,
    populateFromInvoice,
    ensureOneRow() {
      if (!tbody.querySelector("tr")) createRow(tbody, { quantity: 1, rate: 0, per: "Kgs" });
      recalcTotals();
    },
    async selectCustomerById(customerId) {
      if (!customerId) return;
      await applyCustomerSelection(customerId);
    },
    setCustomerOptions(customers) {
      customerList = customers || [];
      if (!customerIdHidden || !customerSearchInput) return;
      const v = customerIdHidden.value;
      const stillValid = v && customerList.some((c) => c.id === v);
      if (stillValid) {
        const c = customerList.find((x) => x.id === v);
        customerIdHidden.value = v;
        customerSearchInput.value = c ? c.name || "" : "";
      } else {
        customerIdHidden.value = "";
        customerSearchInput.value = "";
      }
      closeCustomerListbox();
      if (listbox) listbox.innerHTML = "";
    },
    /**
     * Prefill from a saved quick order (draft). Caller should run after resetForm + settings load.
     * @param {{ customerName?: string, customerPhone?: string, sendDate?: string, memo?: string, lines?: Array<{ productName?: string, quantity?: number, unit?: string }> }} draft
     */
    applyQuickOrderDraft(draft) {
      resetForm();
      const name = (draft?.customerName || "").trim();
      if (name) document.getElementById("inv-buyer-name").value = name;
      const phone = (draft?.customerPhone || "").trim();
      if (phone) document.getElementById("inv-buyer-phone").value = phone;
      const memo = (draft?.memo || "").trim();
      if (memo) {
        const other = document.getElementById("inv-other-refs");
        if (other) other.value = memo.slice(0, 200);
      }
      const sd = (draft?.sendDate || "").trim();
      if (sd) {
        const dn = document.getElementById("inv-delivery-note-date");
        if (dn) dn.value = sd;
      }
      const rawLines = Array.isArray(draft?.lines) ? draft.lines : [];
      const lines =
        rawLines.length > 0
          ? rawLines
          : [{ productName: "", quantity: 1, unit: "Kgs" }];
      tbody.innerHTML = "";
      lines.forEach((line) => {
        createRow(tbody, {
          name: (line.productName || "").trim(),
          quantity: Number(line.quantity) > 0 ? Number(line.quantity) : 1,
          rate: 0,
          per: (line.unit || "Kgs").trim() || "Kgs",
        });
      });
      if (!tbody.querySelector("tr")) {
        createRow(tbody, { quantity: 1, rate: 0, per: "Kgs" });
      }
      recalcTotals();
    },
  };
}
