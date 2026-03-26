import { amountToWordsIn } from "./number-to-words-in.js";
import { formatInvoiceDateDashed } from "./invoices.js";

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

function paymentMethodDisplay(code) {
  const m = {
    credit_sale: "Credit sale",
    cash: "Cash",
    upi: "UPI",
    bank_transfer: "Bank transfer",
    cheque: "Cheque",
    card: "Card",
  };
  const k = String(code ?? "").trim();
  return m[k] || (k ? k.replace(/_/g, " ") : "");
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

function metaCell(k, v, multiline, colspan) {
  const raw = nz(v);
  let inner;
  if (!raw) {
    inner = "—";
  } else if (multiline) {
    inner = escapeHtml(raw).replace(/\n/g, "<br />");
  } else {
    inner = escapeHtml(raw);
  }
  const cs = colspan && colspan > 1 ? ` colspan="${colspan}"` : "";
  /* Inner div carries flex; td stays table-cell so the grid does not collapse into stacked boxes */
  return `<td class="inv-meta-td"${cs}><div class="inv-meta-cell"><span class="mk">${escapeHtml(k)}</span><span class="mv">${inner}</span></div></td>`;
}

function bolCombinedStr(inv) {
  const bolParts = [nz(inv.billOfLadingNo)];
  if (nz(inv.billOfLadingDate)) bolParts.push(`Dt ${nz(inv.billOfLadingDate)}`);
  return bolParts.filter(Boolean).join(" ").trim() || "—";
}

/** Meta grid beside seller only (rows 1–7). Terms of delivery is a separate aside beside parties. */
function buildMetaGridOnlyHtml(inv, dateStr) {
  const refParts = [nz(inv.referenceNo), nz(inv.referenceDate)].filter(Boolean);
  const refCombined = refParts.length ? refParts.join(" dt ") : "—";
  const bolCombined = bolCombinedStr(inv);

  /* 6 cols: row1 = three pairs; row2+ = two half-width fields (colspan 3 each) */
  const r1 = `<tr>${metaCell("Invoice No.", inv.invoiceNumber || "—", false, 2)}${metaCell("e-Way Bill No.", inv.ewayBillNo, false, 2)}${metaCell("Dated", dateStr || "—", false, 2)}</tr>`;
  const r2 = `<tr>${metaCell("Delivery Note", inv.deliveryNote, false, 3)}${metaCell("Mode / Terms of Payment", inv.paymentTerms, false, 3)}</tr>`;
  const r3 = `<tr>${metaCell("Reference No. & Date", refCombined, false, 3)}${metaCell("Other References", inv.otherReferences, false, 3)}</tr>`;
  const r4 = `<tr>${metaCell("Buyer's Order No.", inv.buyerOrderNo, false, 3)}${metaCell("Dated", inv.buyerOrderDate, false, 3)}</tr>`;
  const r5 = `<tr>${metaCell("Dispatch Doc No.", inv.dispatchDocNo, false, 3)}${metaCell("Delivery Note Date", inv.deliveryNoteDate, false, 3)}</tr>`;
  const r6 = `<tr>${metaCell("Dispatched through", inv.dispatchedThrough, false, 3)}${metaCell("Destination", inv.destination, false, 3)}</tr>`;
  const r7 = `<tr>${metaCell("Bill of Lading/LR-RR No. & Date", bolCombined, false, 3)}${metaCell("Motor Vehicle No.", inv.motorVehicleNo, false, 3)}</tr>`;

  return `<table class="inv-meta-print-table" role="presentation"><colgroup><col /><col /><col /><col /><col /><col /></colgroup><tbody>${r1}${r2}${r3}${r4}${r5}${r6}${r7}</tbody></table>`;
}

function buildTermsOfDeliveryAside(inv) {
  const raw = nz(inv.termsOfDelivery);
  const inner = !raw ? "—" : escapeHtml(raw).replace(/\n/g, "<br />");
  return `<div class="inv-terms-delivery-aside">
      <div class="inv-meta-terms-wrap">
        <div class="inv-meta-terms-label">Terms of Delivery</div>
        <div class="inv-meta-terms-value">${inner}</div>
      </div>
    </div>`;
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
  let totalQty = 0;
  let perUnit = "Kgs";
  const tbodies = items
    .map((it, i) => {
      const taxable = Number(it.amount) || 0;
      const cgstL = Math.round(taxable * cgstR * 100) / 100;
      const sgstL = Math.round(taxable * sgstR * 100) / 100;
      const sn = i + 1;
      const qn = Number(it.quantity) || 0;
      totalQty += qn;
      if (nz(it.per)) perUnit = String(it.per).trim();
      return `<tbody class="inv-item-group">
<tr class="inv-item-row inv-item-main">
  <td class="c-num" rowspan="3">${sn}</td>
  <td class="c-desc">${escapeHtml(it.name)}</td>
  <td class="c-hsn">${escapeHtml(it.hsn || "—")}</td>
  <td class="num inv-bold-print">${escapeHtml(String(it.quantity))}</td>
  <td class="num">${formatMoney(it.rate)}</td>
  <td class="c-per">${escapeHtml(it.per || "Pcs")}</td>
  <td class="num inv-bold-print">${formatMoney(it.amount)}</td>
</tr>
<tr class="inv-tax-sub">
  <td colspan="5" class="c-tax-label"><strong>CGST @ ${rates.cgst}%</strong></td>
  <td class="num inv-bold-print">${formatMoney(cgstL)}</td>
</tr>
<tr class="inv-tax-sub">
  <td colspan="5" class="c-tax-label"><strong>SGST @ ${rates.sgst}%</strong></td>
  <td class="num inv-bold-print">${formatMoney(sgstL)}</td>
</tr>
</tbody>`;
    })
    .join("");
  const qtyLabel = `${totalQty} ${perUnit}`.trim();
  const tfoot = `<tfoot>
<tr class="inv-grand-total-row">
  <td colspan="3" class="c-total-label"><strong>Total</strong></td>
  <td class="num inv-bold-print"><strong>${escapeHtml(qtyLabel)}</strong></td>
  <td colspan="2"></td>
  <td class="num inv-bold-print"><strong>${formatMoney(inv.total)}</strong></td>
</tr>
</tfoot>`;
  return `<div class="inv-items-print-wrap">
<table class="inv-print-table inv-items">
  <thead>
    <tr>
      <th class="c-num">Sl.</th>
      <th>Description of Goods</th>
      <th class="c-hsn">HSN/SAC</th>
      <th class="num">Quantity</th>
      <th class="num">Rate</th>
      <th class="c-per">Per</th>
      <th class="num">Amount</th>
    </tr>
  </thead>
  ${tbodies}
  ${tfoot}
</table>
<p class="inv-eoe-below-items"><strong>E. &amp; O.E</strong></p>
</div>`;
}

function partyKV(k, v) {
  if (!nz(v)) return "";
  return `<div class="inv-party-line"><span class="inv-party-k">${escapeHtml(k)}</span><span class="inv-party-v">${escapeHtml(v)}</span></div>`;
}

function buildPartyBlockInner(p) {
  const head = `<p class="inv-bn"><strong>${escapeHtml(p.name)}</strong></p><p class="inv-addr">${escapeHtml(p.address || "").replace(/\n/g, "<br />")}</p>`;
  const kv = [];
  kv.push(partyKV("Phone No.", p.phone));
  if (nz(p.contactExtra)) kv.push(partyKV("Contact", p.contactExtra));
  if (nz(p.gstin)) kv.push(partyKV("GSTIN/UIN", p.gstin));
  if (nz(p.pan)) kv.push(partyKV("PAN / IT No.", p.pan));
  if (nz(p.stateName) || nz(p.stateCode)) {
    const sv = [nz(p.stateName), nz(p.stateCode) ? `Code: ${nz(p.stateCode)}` : ""].filter(Boolean).join(", ");
    kv.push(partyKV("State Name", sv));
  }
  if (nz(p.placeOfSupply)) kv.push(partyKV("Place of supply", p.placeOfSupply));
  if (nz(p.email)) kv.push(partyKV("Email", p.email));
  return `${head}<div class="inv-party-kv">${kv.join("")}</div>`;
}

function partyBillTo(inv) {
  return buildPartyBlockInner({
    name: inv.customerName,
    address: inv.buyerAddress,
    phone: inv.buyerPhone,
    contactExtra: inv.buyerContact,
    email: inv.buyerEmail,
    gstin: inv.buyerGstin,
    pan: inv.buyerPan,
    stateName: inv.buyerStateName,
    stateCode: inv.buyerStateCode,
    placeOfSupply: inv.placeOfSupply,
  });
}

function partyShipTo(inv) {
  if (inv.consigneeSameAsBuyer !== false) {
    return partyBillTo(inv);
  }
  return buildPartyBlockInner({
    name: inv.consigneeName,
    address: inv.consigneeAddress,
    phone: nz(inv.consigneePhone) ? inv.consigneePhone : inv.buyerPhone,
    contactExtra: inv.buyerContact,
    email: nz(inv.consigneeEmail) ? inv.consigneeEmail : inv.buyerEmail,
    gstin: inv.consigneeGstin || inv.buyerGstin,
    pan: inv.buyerPan,
    stateName: inv.consigneeStateName || inv.buyerStateName,
    stateCode: inv.consigneeStateCode || inv.buyerStateCode,
    placeOfSupply: inv.placeOfSupply,
  });
}

function buildHeaderAndBuyer(inv) {
  const dateStr = formatInvoiceDateDashed(inv.date);
  const sellerPan = inv.sellerPan ? partyKV("PAN", inv.sellerPan) : "";
  const sellerUdyam = inv.sellerUdyam ? partyKV("UDYAM", inv.sellerUdyam) : "";
  const sellerContactX = inv.sellerContactExtra ? partyKV("Contact", inv.sellerContactExtra) : "";
  const sellerEmailLine = inv.sellerEmail ? partyKV("Email", inv.sellerEmail) : "";
  const sellerGstLine = inv.sellerGstin ? partyKV("GSTIN/UIN", inv.sellerGstin) : "";
  const sellerStateLine =
    inv.sellerStateName || inv.sellerStateCode
      ? partyKV(
          "State Name",
          [nz(inv.sellerStateName), nz(inv.sellerStateCode) ? `Code: ${nz(inv.sellerStateCode)}` : ""]
            .filter(Boolean)
            .join(", ")
        )
      : "";

  const subLine = inv.sellerSubtitle ? `<p class="inv-subtitle">${escapeHtml(inv.sellerSubtitle)}</p>` : "";

  return `${buildTopTitle()}${buildEInvoiceStrip(inv)}
    <div class="inv-bill-header-grid">
      <div class="inv-bill-top-left">
        <div class="inv-seller">
          <p class="inv-co-name"><strong>${escapeHtml(inv.sellerName)}</strong></p>
          ${subLine}
          <p class="inv-addr">${escapeHtml(inv.sellerAddress).replace(/\n/g, "<br />")}</p>
          <div class="inv-party-kv">
            ${partyKV("Phone No.", inv.sellerPhone)}
            ${sellerContactX}
            ${sellerGstLine}
            ${sellerStateLine}
            ${sellerEmailLine}
            ${sellerPan}
            ${sellerUdyam}
          </div>
        </div>
      </div>
      <div class="inv-bill-top-right">
        ${buildMetaGridOnlyHtml(inv, dateStr)}
      </div>
      <div class="inv-bill-bottom-left">
        <div class="inv-mid-left">
          <div class="inv-block">
            <div class="block-label">Consignee (Ship to)</div>
            ${partyShipTo(inv)}
          </div>
          <div class="inv-block">
            <div class="block-label">Buyer (Bill to)</div>
            ${partyBillTo(inv)}
          </div>
        </div>
      </div>
      <div class="inv-bill-bottom-right">
        ${buildTermsOfDeliveryAside(inv)}
      </div>
    </div>`;
}

function buildFooterBlock(inv) {
  const words = amountToWordsIn(inv.total);
  const taxTotal = (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0);
  const taxWords = amountToWordsIn(taxTotal);

  const prev = inv.previousBalanceSnapshot ?? inv.previousBalance;
  const curr = inv.currentBalanceSnapshot ?? inv.currentBalance;
  const hasPrev = typeof prev === "number" && !Number.isNaN(prev);
  const hasCurr = typeof curr === "number" && !Number.isNaN(curr);
  const paidRaw = Number(inv.amountPaidOnInvoice);
  const paid = Number.isFinite(paidRaw) ? paidRaw : 0;
  const payStatus = String(inv.paymentStatus ?? "").trim();
  const showPaymentReceived = payStatus === "partial" && paid > 0;
  const methodLabel = paymentMethodDisplay(inv.paymentMethod);
  const methodSuffix = methodLabel ? ` <span class="inv-payment-method">(${escapeHtml(methodLabel)})</span>` : "";
  const paymentReceivedLine = showPaymentReceived
    ? `<div class="inv-payment-received-line"><strong>Payment received on this invoice:</strong> ₹ ${formatMoney(paid)}${methodSuffix}</div>`
    : "";
  const balanceSide =
    hasPrev || hasCurr || showPaymentReceived
      ? `<div class="inv-balance-side">
          ${hasPrev ? `<div class="inv-prev-balance-line"><strong>Previous balance: ₹ ${formatMoney(prev)} Dr</strong></div>` : ""}
          ${paymentReceivedLine}
          ${hasCurr ? `<div class="inv-balance-current"><strong>Current balance:</strong> ₹ ${formatMoney(curr)} Dr</div>` : ""}
        </div>`
      : "";

  const hsnRowData = hsnSummaryRows(inv);
  const hsnRows = hsnRowData
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
  const hsnSumTaxable = hsnRowData.reduce((a, r) => a + r.taxable, 0);
  const hsnSumCgst = hsnRowData.reduce((a, r) => a + r.cgstAmt, 0);
  const hsnSumSgst = hsnRowData.reduce((a, r) => a + r.sgstAmt, 0);
  const hsnSumTax = hsnRowData.reduce((a, r) => a + r.taxTot, 0);
  const hsnTfoot =
    hsnRowData.length > 0
      ? `<tfoot>
<tr class="inv-hsn-total-row">
  <td><strong>Total</strong></td>
  <td class="num inv-bold-print"><strong>${formatMoney(hsnSumTaxable)}</strong></td>
  <td class="num"></td>
  <td class="num inv-bold-print"><strong>${formatMoney(hsnSumCgst)}</strong></td>
  <td class="num"></td>
  <td class="num inv-bold-print"><strong>${formatMoney(hsnSumSgst)}</strong></td>
  <td class="num inv-bold-print"><strong>${formatMoney(hsnSumTax)}</strong></td>
</tr>
</tfoot>`
      : "";

  const termsBlock = inv.invoiceTerms
    ? `<div class="inv-terms"><div class="block-label">Declaration</div><pre class="inv-terms-pre">${escapeHtml(inv.invoiceTerms)}</pre></div>`
    : `<div class="inv-terms"><div class="block-label">Declaration</div><pre class="inv-terms-pre">—</pre></div>`;

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
    <div class="inv-totals-balance-row inv-words-balance-row">
    <p class="words-line inv-words-chargeable"><span class="inv-words-main"><strong>Amount chargeable (in words):</strong> <strong class="inv-words-amount">${escapeHtml(words)}</strong></span></p>
    ${balanceSide}
    </div>

    <table class="inv-print-table inv-hsn-sum">
      <caption class="block-label">GST tax analysis</caption>
      <thead>
        <tr>
          <th>HSN/SAC</th>
          <th class="num">Taxable value</th>
          <th class="num">CGST %</th>
          <th class="num">CGST Amt</th>
          <th class="num">SGST/UTGST %</th>
          <th class="num">SGST/UTGST Amt</th>
          <th class="num">Total tax</th>
        </tr>
      </thead>
      <tbody>${hsnRows || `<tr><td colspan="7" class="num">—</td></tr>`}</tbody>
      ${hsnTfoot}
    </table>

    <p class="words-line words-tax"><strong>Tax amount (in words):</strong> <strong class="inv-tax-words-amount">${escapeHtml(taxWords)}</strong></p>

    ${footerPan}

    <div class="inv-bank-terms">
      <div class="inv-footer-decl-col">${termsBlock}</div>
      <div class="inv-footer-bank-col">
      <div class="inv-bank">
        <div class="block-label block-label-caps">Company&apos;s bank details</div>
        ${bankHolder}
        ${inv.bankName ? `<div><strong>${escapeHtml(inv.bankName)}</strong></div>` : ""}
        ${bankBranch}
        ${inv.bankAccount ? `<div><strong>A/c No.:</strong> ${escapeHtml(inv.bankAccount)}</div>` : ""}
        ${inv.bankIfsc ? `<div><strong>IFSC:</strong> ${escapeHtml(inv.bankIfsc)}</div>` : ""}
      </div>
      </div>
    </div>

    <div class="inv-sign-row">
      <div class="sig-customer">
        <p>Customer&apos;s Seal and Signature</p>
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
