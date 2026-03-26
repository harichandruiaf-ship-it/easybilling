import { computeTotals, round2 } from "./invoices.js";

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
  return round2(qty * rate);
}

function createRow(tbody, data = {}) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="text" class="inv-item-name" maxlength="200" placeholder="Item" value="${escapeAttr(data.name || "")}" /></td>
    <td><input type="text" class="inv-hsn" maxlength="20" placeholder="HSN" value="${escapeAttr(data.hsn || "")}" /></td>
    <td><input type="number" class="inv-qty" min="0" step="any" value="${data.quantity ?? 1}" /></td>
    <td><input type="text" class="inv-per" maxlength="12" placeholder="Pcs" value="${escapeAttr(data.per || "Pcs")}" /></td>
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

function parseOptMoney(el) {
  const v = el.value;
  if (v === "" || v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? round2(n) : null;
}

function toggleCustomerCheckboxes(selectedId) {
  const lblNew = document.getElementById("lbl-save-new");
  const lblUpd = document.getElementById("lbl-update-customer");
  const chkNew = document.getElementById("inv-save-new-customer");
  const chkUpd = document.getElementById("inv-update-customer");
  if (selectedId) {
    lblNew.classList.add("hidden");
    lblUpd.classList.remove("hidden");
    chkNew.checked = false;
  } else {
    lblNew.classList.remove("hidden");
    lblUpd.classList.add("hidden");
    chkUpd.checked = false;
    chkNew.checked = true;
  }
}

export function initInvoiceForm(opts) {
  const tbody = document.getElementById("items-tbody");
  const btnAdd = document.getElementById("btn-add-item");
  const form = document.getElementById("form-invoice");
  const sel = document.getElementById("inv-customer-select");

  let taxRates = { cgstPercent: 2.5, sgstPercent: 2.5 };

  function setTaxRates(cgstPercent, sgstPercent) {
    taxRates = {
      cgstPercent: Number(cgstPercent) || 0,
      sgstPercent: Number(sgstPercent) || 0,
    };
    document.getElementById("tot-cgst-label").textContent = `CGST (${taxRates.cgstPercent}%)`;
    document.getElementById("tot-sgst-label").textContent = `SGST (${taxRates.sgstPercent}%)`;
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
      sub += qn * rn;
    });
    sub = round2(sub);
    const t = computeTotals(sub, taxRates.cgstPercent, taxRates.sgstPercent);
    document.getElementById("tot-sub").textContent = t.subtotal.toFixed(2);
    document.getElementById("tot-cgst").textContent = t.cgst.toFixed(2);
    document.getElementById("tot-sgst").textContent = t.sgst.toFixed(2);
    document.getElementById("tot-total").textContent = t.total.toFixed(2);
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
    createRow(tbody, { quantity: 1, rate: 0, per: "Pcs" });
    recalcTotals();
  });

  document.getElementById("inv-consignee-same").addEventListener("change", toggleConsigneeField);

  sel.addEventListener("change", async () => {
    const id = sel.value;
    toggleCustomerCheckboxes(id);
    if (!id) {
      document.getElementById("inv-buyer-name").value = "";
      document.getElementById("inv-buyer-address").value = "";
      document.getElementById("inv-buyer-phone").value = "";
      document.getElementById("inv-buyer-gstin").value = "";
      document.getElementById("inv-buyer-state").value = "";
      document.getElementById("inv-buyer-state-code").value = "";
      document.getElementById("inv-buyer-pan").value = "";
      document.getElementById("inv-place-of-supply").value = "";
      document.getElementById("inv-buyer-contact").value = "";
      document.getElementById("inv-consignee-same").checked = true;
      toggleConsigneeField();
      return;
    }
    if (opts.loadCustomer) {
      const c = await opts.loadCustomer(id);
      if (!c) return;
      document.getElementById("inv-buyer-name").value = c.name || "";
      document.getElementById("inv-buyer-address").value = c.address || "";
      document.getElementById("inv-buyer-phone").value = c.phone || "";
      document.getElementById("inv-buyer-gstin").value = c.gstin || "";
      document.getElementById("inv-buyer-state").value = c.stateName || "";
      document.getElementById("inv-buyer-state-code").value = c.stateCode || "";
      document.getElementById("inv-buyer-pan").value = c.buyerPan || "";
      document.getElementById("inv-place-of-supply").value = c.placeOfSupply || "";
      document.getElementById("inv-buyer-contact").value = c.buyerContact || "";
      const same = c.consigneeSameAsBuyer !== false;
      document.getElementById("inv-consignee-same").checked = same;
      toggleConsigneeField();
      if (!same) {
        document.getElementById("inv-consignee-name").value = c.consigneeName || "";
        document.getElementById("inv-consignee-address").value = c.consigneeAddress || "";
        document.getElementById("inv-consignee-state").value = c.consigneeStateName || "";
        document.getElementById("inv-consignee-state-code").value = c.consigneeStateCode || "";
        document.getElementById("inv-consignee-gstin").value = c.consigneeGstin || "";
      }
    }
  });

  function resetForm() {
    tbody.innerHTML = "";
    createRow(tbody, { quantity: 1, rate: 0, per: "Pcs" });
    sel.innerHTML = '<option value="">— New customer (enter details below) —</option>';
    sel.value = "";
    document.getElementById("inv-buyer-name").value = "";
    document.getElementById("inv-buyer-address").value = "";
    document.getElementById("inv-buyer-phone").value = "";
    document.getElementById("inv-buyer-gstin").value = "";
    document.getElementById("inv-buyer-state").value = "";
    document.getElementById("inv-buyer-state-code").value = "";
    document.getElementById("inv-buyer-pan").value = "";
    document.getElementById("inv-place-of-supply").value = "";
    document.getElementById("inv-buyer-contact").value = "";
    document.getElementById("inv-consignee-same").checked = true;
    toggleConsigneeField();
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
    document.getElementById("inv-vehicle-no").value = "";
    document.getElementById("inv-terms-delivery").value = "";
    document.getElementById("inv-vessel-flight").value = "";
    document.getElementById("inv-place-receipt").value = "";
    document.getElementById("inv-port-loading").value = "";
    document.getElementById("inv-port-discharge").value = "";
    document.getElementById("inv-einv-irn").value = "";
    document.getElementById("inv-einv-ack-no").value = "";
    document.getElementById("inv-einv-ack-date").value = "";
    document.getElementById("inv-einv-qr-url").value = "";
    document.getElementById("inv-prev-balance").value = "";
    document.getElementById("inv-curr-balance").value = "";
    document.getElementById("inv-eway").value = "";
    document.getElementById("inv-save-new-customer").checked = true;
    document.getElementById("inv-update-customer").checked = false;
    toggleCustomerCheckboxes("");
    document.getElementById("invoice-form-error").textContent = "";
    recalcTotals();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("invoice-form-error");
    errEl.textContent = "";

    const buyerName = document.getElementById("inv-buyer-name").value.trim();
    const buyerAddress = document.getElementById("inv-buyer-address").value.trim();
    const buyerPhone = document.getElementById("inv-buyer-phone").value.trim();
    const buyerGstin = document.getElementById("inv-buyer-gstin").value.trim().toUpperCase();
    const buyerStateName = document.getElementById("inv-buyer-state").value.trim();
    const buyerStateCode = document.getElementById("inv-buyer-state-code").value.trim();
    const buyerPan = document.getElementById("inv-buyer-pan").value.trim().toUpperCase();
    const placeOfSupply = document.getElementById("inv-place-of-supply").value.trim();
    const buyerContact = document.getElementById("inv-buyer-contact").value.trim();
    const consigneeSame = document.getElementById("inv-consignee-same").checked;
    const consigneeName = document.getElementById("inv-consignee-name").value.trim();
    const consigneeAddress = document.getElementById("inv-consignee-address").value.trim();
    const consigneeGstin = document.getElementById("inv-consignee-gstin").value.trim().toUpperCase();
    const consigneeStateName = document.getElementById("inv-consignee-state").value.trim();
    const consigneeStateCode = document.getElementById("inv-consignee-state-code").value.trim();
    const ewayBillNo = document.getElementById("inv-eway").value.trim();
    const selectedCustomerId = sel.value || "";
    const saveNewCustomer = document.getElementById("inv-save-new-customer").checked;
    const updateCustomer = document.getElementById("inv-update-customer").checked;

    if (!buyerName) {
      errEl.textContent = "Enter buyer name.";
      return;
    }
    if (!buyerAddress) {
      errEl.textContent = "Enter buyer address.";
      return;
    }
    if (!buyerPhone) {
      errEl.textContent = "Enter phone number.";
      return;
    }
    if (!isValidGstinOptional(buyerGstin)) {
      errEl.textContent = "Invalid GSTIN format (optional field).";
      return;
    }
    if (!isValidPanOptional(buyerPan)) {
      errEl.textContent = "Invalid PAN format (optional field).";
      return;
    }
    if (!consigneeSame) {
      if (!consigneeName) {
        errEl.textContent = "Enter consignee name or mark same as buyer.";
        return;
      }
      if (!consigneeAddress) {
        errEl.textContent = "Enter consignee address.";
        return;
      }
      if (!isValidGstinOptional(consigneeGstin)) {
        errEl.textContent = "Invalid consignee GSTIN format (optional field).";
        return;
      }
    }

    const items = [];
    const rows = tbody.querySelectorAll("tr");
    for (const tr of rows) {
      const name = tr.querySelector(".inv-item-name")?.value.trim() || "";
      const hsn = tr.querySelector(".inv-hsn")?.value.trim() || "";
      const per = tr.querySelector(".inv-per")?.value.trim() || "Pcs";
      const qty = parseFloat(tr.querySelector(".inv-qty")?.value);
      const rate = parseFloat(tr.querySelector(".inv-rate")?.value);
      const qn = Number.isFinite(qty) ? qty : 0;
      const rn = Number.isFinite(rate) ? rate : 0;
      if (!name) {
        errEl.textContent = "Each row needs an item name.";
        return;
      }
      if (qn <= 0) {
        errEl.textContent = "Quantity must be greater than zero for all items.";
        return;
      }
      if (rn < 0) {
        errEl.textContent = "Rate cannot be negative.";
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
      errEl.textContent = "Add at least one item.";
      return;
    }

    const totals = recalcTotals();
    const prevBal = parseOptMoney(document.getElementById("inv-prev-balance"));
    const currBal = parseOptMoney(document.getElementById("inv-curr-balance"));
    if (opts.onSubmit) {
      await opts.onSubmit({
        customerName: buyerName,
        buyerAddress,
        buyerPhone,
        buyerGstin,
        buyerStateName,
        buyerStateCode,
        buyerPan,
        placeOfSupply,
        buyerContact,
        consigneeSameAsBuyer: consigneeSame,
        consigneeName: consigneeSame ? "" : consigneeName,
        consigneeAddress: consigneeSame ? "" : consigneeAddress,
        consigneeGstin: consigneeSame ? "" : consigneeGstin,
        consigneeStateName: consigneeSame ? "" : consigneeStateName,
        consigneeStateCode: consigneeSame ? "" : consigneeStateCode,
        ewayBillNo,
        deliveryNote: document.getElementById("inv-delivery-note").value.trim(),
        paymentTerms: document.getElementById("inv-payment-terms").value.trim(),
        referenceNo: document.getElementById("inv-ref-no").value.trim(),
        referenceDate: document.getElementById("inv-ref-date").value.trim(),
        otherReferences: document.getElementById("inv-other-refs").value.trim(),
        buyerOrderNo: document.getElementById("inv-buyer-order-no").value.trim(),
        buyerOrderDate: document.getElementById("inv-buyer-order-date").value.trim(),
        dispatchDocNo: document.getElementById("inv-dispatch-doc").value.trim(),
        deliveryNoteDate: document.getElementById("inv-delivery-note-date").value.trim(),
        dispatchedThrough: document.getElementById("inv-dispatch-through").value.trim(),
        destination: document.getElementById("inv-destination").value.trim(),
        billOfLadingNo: document.getElementById("inv-bol").value.trim(),
        motorVehicleNo: document.getElementById("inv-vehicle-no").value.trim(),
        termsOfDelivery: document.getElementById("inv-terms-delivery").value.trim(),
        vesselFlightNo: document.getElementById("inv-vessel-flight").value.trim(),
        placeReceiptShipper: document.getElementById("inv-place-receipt").value.trim(),
        portLoading: document.getElementById("inv-port-loading").value.trim(),
        portDischarge: document.getElementById("inv-port-discharge").value.trim(),
        eInvoiceIrn: document.getElementById("inv-einv-irn").value.trim(),
        eInvoiceAckNo: document.getElementById("inv-einv-ack-no").value.trim(),
        eInvoiceAckDate: document.getElementById("inv-einv-ack-date").value.trim(),
        eInvoiceQrUrl: document.getElementById("inv-einv-qr-url").value.trim(),
        previousBalance: prevBal,
        currentBalance: currBal,
        selectedCustomerId,
        saveNewCustomer,
        updateCustomer,
        items,
        subtotal: totals.subtotal,
        cgst: totals.cgst,
        sgst: totals.sgst,
        total: totals.total,
        cgstPercent: totals.cgstPercent,
        sgstPercent: totals.sgstPercent,
      });
    }
  });

  toggleConsigneeField();

  return {
    resetForm,
    recalcTotals,
    setTaxRates,
    ensureOneRow() {
      if (!tbody.querySelector("tr")) createRow(tbody, { quantity: 1, rate: 0, per: "Pcs" });
      recalcTotals();
    },
    setCustomerOptions(customers) {
      const v = sel.value;
      sel.innerHTML = '<option value="">— New customer (enter details below) —</option>';
      for (const c of customers) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name || c.id;
        sel.appendChild(opt);
      }
      if (v && [...sel.options].some((o) => o.value === v)) sel.value = v;
      toggleCustomerCheckboxes(sel.value);
    },
  };
}
