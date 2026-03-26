import { amountToWordsIn } from "./number-to-words-in.js";
import { formatInvoiceDateNumeric } from "./invoices.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(n) {
  const x = typeof n === "number" ? n : parseFloat(n);
  if (Number.isNaN(x)) return "0.00";
  return x.toFixed(2);
}

function pct(inv) {
  const c = inv.cgstPercent;
  const s = inv.sgstPercent;
  if (typeof c === "number" && typeof s === "number") return { cgst: c, sgst: s };
  return { cgst: 2.5, sgst: 2.5 };
}

function nz(s) {
  const t = String(s ?? "").trim();
  return t;
}

function safeQrUrl(u) {
  const s = nz(u);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(s)) return s;
  return "";
}

function buildTopTitle() {
  return `<div class="inv-top-title">
    <h2 class="inv-title inv-title-center">Tax Invoice</h2>
    <p class="inv-recipient-note">(ORIGINAL FOR RECIPIENT)</p>
  </div>`;
}

function buildEInvoiceStrip(inv) {
  const irn = nz(inv.eInvoiceIrn);
  const ackNo = nz(inv.eInvoiceAckNo);
  const ackDt = nz(inv.eInvoiceAckDate);
  const qr = safeQrUrl(inv.eInvoiceQrUrl);
  if (!irn && !ackNo && !ackDt && !qr) return "";
  const qrBlock = qr
    ? `<div class="inv-einv-qr-wrap"><img src=${JSON.stringify(qr)} alt="" class="inv-einv-qr-img" /></div>`
    : `<div class="inv-einv-qr-placeholder"><span>e-Invoice</span></div>`;
  return `<div class="inv-einv-strip">
    <div class="inv-einv-left">
      ${irn ? `<div class="inv-einv-line"><strong>IRN:</strong> <span class="inv-irn-text">${escapeHtml(irn)}</span></div>` : ""}
      ${ackNo ? `<div class="inv-einv-line"><strong>Ack No.:</strong> ${escapeHtml(ackNo)}</div>` : ""}
      ${ackDt ? `<div class="inv-einv-line"><strong>Ack Date:</strong> ${escapeHtml(ackDt)}</div>` : ""}
    </div>
    <div class="inv-einv-right">${qrBlock}</div>
  </div>`;
}

function buildMetaGridHtml(inv, dateStr) {
  const cells = [];
  const push = (k, v) => {
    cells.push(
      `<div class="inv-meta-cell"><span class="mk">${escapeHtml(k)}</span><span class="mv">${escapeHtml(v)}</span></div>`
    );
  };
  const add = (k, val) => {
    const v = nz(val);
    if (v) push(k, v);
  };
  push("Invoice No.", nz(inv.invoiceNumber) || "—");
  push("Dated", nz(dateStr) || "—");
  add("e-Way Bill no.", inv.ewayBillNo);
  add("Delivery Note", inv.deliveryNote);
  add("Mode/Terms of Payment", inv.paymentTerms);
  const refNo = nz(inv.referenceNo);
  const refDt = nz(inv.referenceDate);
  if (refNo || refDt) add("Reference No. & Date", [refNo, refDt].filter(Boolean).join(" · "));
  add("Other References", inv.otherReferences);
  add("Buyer's Order No.", inv.buyerOrderNo);
  add("Dated (order)", inv.buyerOrderDate);
  add("Dispatch Doc No.", inv.dispatchDocNo);
  add("Delivery Note Date", inv.deliveryNoteDate);
  add("Dispatched through", inv.dispatchedThrough);
  add("Destination", inv.destination);
  add("Bill of Lading / LR-RR No.", inv.billOfLadingNo);
  add("Motor Vehicle No.", inv.motorVehicleNo);
  add("Vessel/Flight No.", inv.vesselFlightNo);
  add("Place of receipt by shipper", inv.placeReceiptShipper);
  add("City/Port of Loading", inv.portLoading);
  add("City/Port of Discharge", inv.portDischarge);
  add("Terms of Delivery", inv.termsOfDelivery);
  return `<div class="inv-meta-grid">${cells.join("")}</div>`;
}

function hsnSummaryRows(inv) {
  const items = inv.items || [];
  const map = new Map();
  const rates = pct(inv);
  for (const it of items) {
    const hsn = (it.hsn || "—").trim() || "—";
    const taxable = Number(it.amount) || 0;
    if (!map.has(hsn)) {
      map.set(hsn, { taxable: 0, hsn });
    }
    const row = map.get(hsn);
    row.taxable = Math.round((row.taxable + taxable + Number.EPSILON) * 100) / 100;
  }
  const rows = [];
  for (const [, row] of map) {
    const tv = row.taxable;
    const cgstAmt = Math.round(tv * (rates.cgst / 100) * 100) / 100;
    const sgstAmt = Math.round(tv * (rates.sgst / 100) * 100) / 100;
    rows.push({
      hsn: row.hsn,
      taxable: tv,
      cgstRate: rates.cgst,
      cgstAmt,
      sgstRate: rates.sgst,
      sgstAmt,
      taxTot: Math.round((cgstAmt + sgstAmt) * 100) / 100,
    });
  }
  return rows;
}

function buildItemsTableHtml(inv) {
  const items = inv.items || [];
  const rates = pct(inv);
  const cgstR = rates.cgst / 100;
  const sgstR = rates.sgst / 100;
  const tbodies = items
    .map((it, i) => {
      const taxable = Number(it.amount) || 0;
      const cgstL = Math.round(taxable * cgstR * 100) / 100;
      const sgstL = Math.round(taxable * sgstR * 100) / 100;
      const sn = i + 1;
      return `<tbody class="inv-item-group">
<tr class="inv-item-row inv-item-main">
  <td class="c-num" rowspan="3">${sn}</td>
  <td class="c-desc">${escapeHtml(it.name)}</td>
  <td class="c-hsn">${escapeHtml(it.hsn || "—")}</td>
  <td class="num">${escapeHtml(String(it.quantity))}</td>
  <td class="c-per">${escapeHtml(it.per || "Pcs")}</td>
  <td class="num">${formatMoney(it.rate)}</td>
  <td class="num">${formatMoney(it.amount)}</td>
</tr>
<tr class="inv-tax-sub">
  <td colspan="5" class="c-tax-label">CGST ${rates.cgst}%</td>
  <td class="num">${formatMoney(cgstL)}</td>
</tr>
<tr class="inv-tax-sub">
  <td colspan="5" class="c-tax-label">SGST ${rates.sgst}%</td>
  <td class="num">${formatMoney(sgstL)}</td>
</tr>
</tbody>`;
    })
    .join("");
  return `
<table class="inv-print-table inv-items">
  <thead>
    <tr>
      <th class="c-num">Sl.</th>
      <th>Description of Goods</th>
      <th class="c-hsn">HSN/SAC</th>
      <th class="num">Qty</th>
      <th class="c-per">Per</th>
      <th class="num">Rate</th>
      <th class="num">Amt</th>
    </tr>
  </thead>
  ${tbodies}
</table>`;
}

function buildHeaderAndBuyer(inv) {
  const dateStr = formatInvoiceDateNumeric(inv.date);
  const sellerGst = inv.sellerGstin ? `GSTIN/UIN: ${escapeHtml(inv.sellerGstin)}` : "";
  const sellerState =
    inv.sellerStateName || inv.sellerStateCode
      ? `State: ${escapeHtml(inv.sellerStateName || "")}${inv.sellerStateCode ? `, Code: ${escapeHtml(inv.sellerStateCode)}` : ""}`
      : "";
  const sellerEmail = inv.sellerEmail ? `Email: ${escapeHtml(inv.sellerEmail)}` : "";
  const sellerPan = inv.sellerPan ? `<p class="inv-line-tight"><strong>PAN:</strong> ${escapeHtml(inv.sellerPan)}</p>` : "";
  const sellerUdyam = inv.sellerUdyam
    ? `<p class="inv-line-tight"><strong>UDYAM:</strong> ${escapeHtml(inv.sellerUdyam)}</p>`
    : "";
  const sellerContactX = inv.sellerContactExtra
    ? `<p class="inv-line-tight"><strong>Contact:</strong> ${escapeHtml(inv.sellerContactExtra)}</p>`
    : "";

  const buyerGst = inv.buyerGstin ? `GSTIN/UIN: ${escapeHtml(inv.buyerGstin)}` : "";
  const buyerState =
    inv.buyerStateName || inv.buyerStateCode
      ? `State: ${escapeHtml(inv.buyerStateName || "")}${inv.buyerStateCode ? `, Code: ${escapeHtml(inv.buyerStateCode)}` : ""}`
      : "";
  const buyerPanLine = inv.buyerPan
    ? `<p class="inv-line-tight"><strong>PAN/IT No.:</strong> ${escapeHtml(inv.buyerPan)}</p>`
    : "";
  const placeSup = inv.placeOfSupply
    ? `<p class="inv-line-tight"><strong>Place of supply:</strong> ${escapeHtml(inv.placeOfSupply)}</p>`
    : "";
  const buyerContactLine = inv.buyerContact
    ? `<p class="inv-line-tight"><strong>Contact:</strong> ${escapeHtml(inv.buyerContact)}</p>`
    : "";

  const consigneeGst =
    inv.consigneeGstin && inv.consigneeSameAsBuyer === false
      ? `GSTIN/UIN: ${escapeHtml(inv.consigneeGstin)}`
      : "";
  const consigneeState =
    inv.consigneeSameAsBuyer === false && (inv.consigneeStateName || inv.consigneeStateCode)
      ? `State: ${escapeHtml(inv.consigneeStateName || "")}${inv.consigneeStateCode ? `, Code: ${escapeHtml(inv.consigneeStateCode)}` : ""}`
      : "";

  const consigneeBlock =
    inv.consigneeSameAsBuyer !== false
      ? `<div class="inv-block">
          <div class="block-label">Consignee (Ship to)</div>
          <p class="inv-note">Same as Bill to</p>
        </div>`
      : `<div class="inv-block">
          <div class="block-label">Consignee (Ship to)</div>
          <p class="inv-bn"><strong>${escapeHtml(inv.consigneeName || "")}</strong></p>
          <p class="inv-addr">${escapeHtml(inv.consigneeAddress || "").replace(/\n/g, "<br />")}</p>
          ${consigneeGst ? `<p class="inv-line-tight">${consigneeGst}</p>` : ""}
          ${consigneeState ? `<p class="inv-line-tight">${consigneeState}</p>` : ""}
        </div>`;

  const subLine = inv.sellerSubtitle
    ? `<p class="inv-subtitle">${escapeHtml(inv.sellerSubtitle)}</p>`
    : "";

  return `${buildTopTitle()}${buildEInvoiceStrip(inv)}
    <div class="inv-header-row">
      <div class="inv-seller">
        <p class="inv-co-name"><strong>${escapeHtml(inv.sellerName)}</strong></p>
        ${subLine}
        <p class="inv-addr">${escapeHtml(inv.sellerAddress).replace(/\n/g, "<br />")}</p>
        <p class="inv-line-tight">Ph: ${escapeHtml(inv.sellerPhone)}</p>
        ${sellerContactX}
        ${sellerEmail ? `<p class="inv-line-tight">${sellerEmail}</p>` : ""}
        ${sellerPan}
        ${sellerUdyam}
        ${sellerGst ? `<p class="inv-line-tight">${sellerGst}</p>` : ""}
        ${sellerState ? `<p class="inv-line-tight">${sellerState}</p>` : ""}
      </div>
      <div class="inv-meta">
        ${buildMetaGridHtml(inv, dateStr)}
      </div>
    </div>

    <div class="inv-two-col">
      ${consigneeBlock}
      <div class="inv-block">
        <div class="block-label">Buyer (Bill to)</div>
        <p class="inv-bn"><strong>${escapeHtml(inv.customerName)}</strong></p>
        <p class="inv-addr">${escapeHtml(inv.buyerAddress).replace(/\n/g, "<br />")}</p>
        <p class="inv-line-tight">Ph: ${escapeHtml(inv.buyerPhone)}</p>
        ${buyerContactLine}
        ${buyerGst ? `<p class="inv-line-tight">${buyerGst}</p>` : ""}
        ${buyerPanLine}
        ${buyerState ? `<p class="inv-line-tight">${buyerState}</p>` : ""}
        ${placeSup}
      </div>
    </div>`;
}

function buildFooterBlock(inv) {
  const rates = pct(inv);
  const words = amountToWordsIn(inv.total);
  const taxTotal = (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0);
  const taxWords = amountToWordsIn(taxTotal);

  const prev = inv.previousBalance;
  const curr = inv.currentBalance;
  const hasPrev = typeof prev === "number" && !Number.isNaN(prev);
  const hasCurr = typeof curr === "number" && !Number.isNaN(curr);
  const balanceSide =
    hasPrev || hasCurr
      ? `<div class="inv-balance-side">
          ${hasPrev ? `<div><strong>Previous balance:</strong> ₹ ${formatMoney(prev)} Dr</div>` : ""}
          ${hasCurr ? `<div><strong>Current balance:</strong> ₹ ${formatMoney(curr)} Dr</div>` : ""}
        </div>`
      : "";

  const hsnRows = hsnSummaryRows(inv)
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.hsn)}</td>
      <td class="num">${formatMoney(r.taxable)}</td>
      <td class="num">${r.cgstRate}%</td>
      <td class="num">${formatMoney(r.cgstAmt)}</td>
      <td class="num">${r.sgstRate}%</td>
      <td class="num">${formatMoney(r.sgstAmt)}</td>
      <td class="num">${formatMoney(r.taxTot)}</td>
    </tr>`
    )
    .join("");

  const terms = inv.invoiceTerms
    ? `<div class="inv-terms"><div class="block-label">Declaration</div><pre class="inv-terms-pre">${escapeHtml(inv.invoiceTerms)}</pre></div>`
    : "";

  const bankHolder = inv.accountHolderName
    ? `<div><strong>A/c Holder&apos;s Name:</strong> ${escapeHtml(inv.accountHolderName)}</div>`
    : "";
  const bankBranch = inv.bankBranch ? `<div><strong>Branch:</strong> ${escapeHtml(inv.bankBranch)}</div>` : "";
  const footerPan = inv.sellerPan
    ? `<p class="inv-footer-pan"><strong>Company&apos;s PAN:</strong> ${escapeHtml(inv.sellerPan)}</p>`
    : "";

  const subForSig = inv.sellerSubtitle ? ` ${escapeHtml(inv.sellerSubtitle)}` : "";

  const footerNote = inv.jurisdictionFooter
    ? `<p class="inv-footer-jurisdiction">${escapeHtml(inv.jurisdictionFooter)}</p>`
    : "";
  const computerGen = `<p class="inv-computer-gen">This is a Computer Generated Invoice</p>`;

  return `
    <div class="inv-pdf-footer-block">
    <div class="inv-totals-balance-row">
    <div class="inv-totals-wrap">
      <div class="inv-totals">
        <div class="row"><span>Taxable</span><span>${formatMoney(inv.subtotal)}</span></div>
        <div class="row"><span>CGST (${rates.cgst}%)</span><span>${formatMoney(inv.cgst)}</span></div>
        <div class="row"><span>SGST (${rates.sgst}%)</span><span>${formatMoney(inv.sgst)}</span></div>
        <div class="row total"><span>Total</span><span>₹ ${formatMoney(inv.total)}</span></div>
      </div>
    </div>
    ${balanceSide}
    </div>

    <p class="words-line inv-words-eoe"><span class="inv-words-main"><strong>Amount chargeable (in words):</strong> ${escapeHtml(words)}</span><span class="inv-eoe"><strong>E. &amp; O.E</strong></span></p>

    <table class="inv-print-table inv-hsn-sum">
      <caption class="block-label">Tax breakdown</caption>
      <thead>
        <tr>
          <th>HSN</th>
          <th class="num">Taxable</th>
          <th class="num">CGST%</th>
          <th class="num">CGST</th>
          <th class="num">SGST/UTGST%</th>
          <th class="num">SGST/UTGST</th>
          <th class="num">Tax</th>
        </tr>
      </thead>
      <tbody>${hsnRows || `<tr><td colspan="7" class="num">—</td></tr>`}</tbody>
    </table>

    <p class="words-line words-tax"><strong>Tax amount (in words):</strong> ${escapeHtml(taxWords)}</p>

    ${footerPan}

    <div class="inv-bank-terms">
      <div class="inv-bank">
        <div class="block-label">Bank details</div>
        ${bankHolder}
        ${inv.bankName ? `<div><strong>${escapeHtml(inv.bankName)}</strong></div>` : ""}
        ${bankBranch}
        ${inv.bankAccount ? `<div><strong>A/c No.:</strong> ${escapeHtml(inv.bankAccount)}</div>` : ""}
        ${inv.bankIfsc ? `<div><strong>IFSC:</strong> ${escapeHtml(inv.bankIfsc)}</div>` : ""}
      </div>
      ${terms}
    </div>

    <div class="inv-sign-row">
      <div class="sig-customer">
        <p>Customer's seal &amp; signature</p>
      </div>
      <div class="sig-box">
        <p>For <strong>${escapeHtml(inv.sellerName)}</strong>${subForSig}</p>
        <p class="sig-line">Authorised Signatory</p>
      </div>
    </div>

    <div class="inv-pdf-footer-tail">
    ${footerNote}
    ${computerGen}
    </div>
    </div>`;
}

export function buildInvoiceHtml(inv) {
  return `${buildHeaderAndBuyer(inv)}${buildItemsTableHtml(inv)}${buildFooterBlock(inv)}`;
}

export function renderInvoiceDocument(inv) {
  const root = document.createElement("div");
  root.className = "invoice-doc gst-invoice invoice-a4-compact invoice-a4-single";
  root.innerHTML = buildInvoiceHtml(inv);
  return root;
}

export function printInvoice() {
  window.print();
}
