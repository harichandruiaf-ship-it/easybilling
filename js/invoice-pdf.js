import { amountToWordsIn } from "./number-to-words-in.js";
import { formatInvoiceDateDashed } from "./invoices.js";

/**
 * Public path fallback (e.g. tests). Prefer `resolveStampAssetUrl()` which uses `import.meta.url`
 * so the file resolves next to this module (`js/` → `../assets/`) and works with file://, subpaths, and hash routing.
 */
export const INVOICE_STAMP_ASSET = "/assets/stamp.svg";

function resolveStampAssetUrl() {
  try {
    return new URL("../assets/stamp.svg", import.meta.url).href;
  } catch (_) {
    if (typeof window === "undefined" || !window.location) return INVOICE_STAMP_ASSET;
    try {
      return new URL(INVOICE_STAMP_ASSET, window.location.origin).href;
    } catch (_) {
      return INVOICE_STAMP_ASSET;
    }
  }
}

/** Raster PNG — html2canvas often skips SVG in img (http or data URL); PNG paints reliably. */
let stampPngDataUrlForPdfCache = null;

function stampSvgViewBoxSize(svgText) {
  const m = svgText.match(/viewBox\s*=\s*["']\s*([^"']+)["']/i);
  if (m) {
    const parts = m[1].trim().split(/[\s,]+/);
    if (parts.length >= 4) {
      const w = parseFloat(parts[2]);
      const h = parseFloat(parts[3]);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
    }
  }
  return { w: 656, h: 1024 };
}

/** CSS max-height for stamp; raster well above capture scale so the stamp stays sharp in PDF. */
const STAMP_DISPLAY_MAX_PX = 96;
const STAMP_RASTER_SCALE = 6;

async function getStampPngDataUrlForPdf() {
  if (stampPngDataUrlForPdfCache) return stampPngDataUrlForPdfCache;
  const url = resolveStampAssetUrl();
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Could not load stamp image (${res.status}).`);
  const svgText = await res.text();
  const { w: vw, h: vh } = stampSvgViewBoxSize(svgText);
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Stamp image failed to decode."));
      img.src = blobUrl;
    });
    const nw = img.naturalWidth > 0 ? img.naturalWidth : vw;
    const nh = img.naturalHeight > 0 ? img.naturalHeight : vh;
    const maxH = STAMP_DISPLAY_MAX_PX * STAMP_RASTER_SCALE;
    const scale = Math.min(1, maxH / nh);
    const cw = Math.max(1, Math.round(nw * scale));
    const ch = Math.max(1, Math.round(nh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available for PDF stamp.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, nw, nh, 0, 0, cw, ch);
    stampPngDataUrlForPdfCache = canvas.toDataURL("image/png", 1);
    return stampPngDataUrlForPdfCache;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Apply cached PNG to stamp imgs (sync). Use in html2canvas onclone — the clone may not copy decoded images.
 */
export function applyCachedStampPngToStampImages(root) {
  if (!stampPngDataUrlForPdfCache || !root) return;
  root.querySelectorAll("img.inv-sign-stamp-img").forEach((img) => {
    img.src = stampPngDataUrlForPdfCache;
  });
}

/**
 * Replace stamp img sources with a raster PNG and wait for decode.
 * Call before html2pdf capture when the invoice includes a stamp.
 */
export async function prepareInvoiceStampImagesForPdf(root) {
  const imgs = root?.querySelectorAll?.("img.inv-sign-stamp-img") ?? [];
  if (!imgs.length) return;
  const dataUrl = await getStampPngDataUrlForPdf();
  imgs.forEach((img) => {
    img.src = dataUrl;
  });
  await Promise.all(
    [...imgs].map((img) => {
      if (typeof img.decode === "function") return img.decode().catch(() => {});
      return new Promise((resolve) => {
        if (img.complete) resolve();
        else {
          img.onload = () => resolve();
          img.onerror = () => resolve();
        }
      });
    })
  );
  await new Promise((r) => requestAnimationFrame(r));
}

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

function safeAmountToWords(n) {
  try {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    return amountToWordsIn(x);
  } catch (_) {
    return "";
  }
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
  return String(s ?? "").trim();
}

/** Printed value when a field is empty (avoids em dash; keeps cell height). */
const EMPTY_FIELD = "\u00A0";

/** Receivable balance line: positive = Dr (due), negative = Cr (advance / credit). */
function formatBalanceLine(label, amount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return "";
  const abs = formatMoney(Math.abs(a));
  if (Math.abs(a) < 1e-9) return `<div><strong>${escapeHtml(label)}: ₹ ${abs}</strong></div>`;
  const dc = a > 0 ? "Dr" : "Cr";
  return `<div><strong>${escapeHtml(label)}: ₹ ${abs} ${dc}</strong></div>`;
}

function kvRow(k, v) {
  if (!nz(v)) return "";
  return `<tr><td class="inv-k">${escapeHtml(k)}</td><td class="inv-kc">:</td><td class="inv-v">${escapeHtml(v)}</td></tr>`;
}

function buildPartyTable(p) {
  const rows = [
    `<tr><td colspan="3" class="inv-party-name"><strong>${escapeHtml(p.name || EMPTY_FIELD)}</strong></td></tr>`,
    `<tr><td colspan="3" class="inv-party-addr">${escapeHtml(p.address || "").replace(/\n/g, "<br />") || EMPTY_FIELD}</td></tr>`,
    kvRow("Phone No", p.phone),
    kvRow("Contact", p.contactExtra),
    kvRow("GSTIN/UIN", p.gstin),
    kvRow("PAN / IT No", p.pan),
    kvRow(
      "State Name",
      [nz(p.stateName), nz(p.stateCode) ? `Code: ${nz(p.stateCode)}` : ""].filter(Boolean).join(", ")
    ),
    kvRow("Place of supply", p.placeOfSupply),
    kvRow("Email", p.email),
  ]
    .filter(Boolean)
    .join("");

  return `<table class="inv-subtable inv-party-table" role="presentation"><colgroup><col class="inv-party-col-k" /><col class="inv-party-col-c" /><col class="inv-party-col-v" /></colgroup><tbody>${rows}</tbody></table>`;
}

function buildSellerTable(inv) {
  return buildPartyTable({
    name: inv.sellerName,
    address: inv.sellerAddress,
    phone: inv.sellerPhone,
    contactExtra: inv.sellerContactExtra,
    gstin: inv.sellerGstin,
    pan: inv.sellerPan,
    stateName: inv.sellerStateName,
    stateCode: inv.sellerStateCode,
    placeOfSupply: "",
    email: inv.sellerEmail,
  });
}

function buildBillToTable(inv) {
  return buildPartyTable({
    name: inv.customerName,
    address: inv.buyerAddress,
    phone: inv.buyerPhone,
    contactExtra: inv.buyerContact,
    gstin: inv.buyerGstin,
    pan: inv.buyerPan,
    stateName: inv.buyerStateName,
    stateCode: inv.buyerStateCode,
    placeOfSupply: inv.placeOfSupply,
    email: inv.buyerEmail,
  });
}

function buildShipToTable(inv) {
  if (inv.consigneeSameAsBuyer !== false) return buildBillToTable(inv);
  return buildPartyTable({
    name: inv.consigneeName,
    address: inv.consigneeAddress,
    phone: nz(inv.consigneePhone) ? inv.consigneePhone : inv.buyerPhone,
    contactExtra: inv.buyerContact,
    gstin: inv.consigneeGstin || inv.buyerGstin,
    pan: inv.buyerPan,
    stateName: inv.consigneeStateName || inv.buyerStateName,
    stateCode: inv.consigneeStateCode || inv.buyerStateCode,
    placeOfSupply: inv.placeOfSupply,
    email: nz(inv.consigneeEmail) ? inv.consigneeEmail : inv.buyerEmail,
  });
}

function metaCell(label, value) {
  return `<td><div class="inv-meta-label">${escapeHtml(label)}</div><div class="inv-meta-value">${escapeHtml(nz(value) || EMPTY_FIELD)}</div></td>`;
}

function metaInner(label, value) {
  return `<div class="inv-meta-label">${escapeHtml(label)}</div><div class="inv-meta-value">${escapeHtml(nz(value) || EMPTY_FIELD)}</div>`;
}

function metaCellSpan(label, value, colspan) {
  return `<td colspan="${colspan}">${metaInner(label, value)}</td>`;
}

function buildSellerInfoGrid(inv) {
  const dateStr = formatInvoiceDateDashed(inv.date);
  const refCombined = [nz(inv.referenceNo), nz(inv.referenceDate)].filter(Boolean).join(" dt ") || EMPTY_FIELD;

  return `<table class="inv-subtable inv-meta-grid inv-meta-grid-seller" role="presentation">
    <colgroup><col /><col /><col /><col /><col /><col /></colgroup>
    <tbody>
      <tr>${metaCellSpan("Invoice No.", inv.invoiceNumber || EMPTY_FIELD, 2)}${metaCellSpan("e-Way Bill No.", inv.ewayBillNo, 2)}${metaCellSpan("Dated", dateStr || EMPTY_FIELD, 2)}</tr>
      <tr>${metaCellSpan("Delivery Note", inv.deliveryNote, 3)}${metaCellSpan("Mode / Terms of Payment", inv.paymentTerms, 3)}</tr>
      <tr>${metaCellSpan("Reference No. & Date", refCombined, 3)}${metaCellSpan("Other References", inv.otherReferences, 3)}</tr>
    </tbody>
  </table>`;
}

function buildConsigneeInfoGrid(inv) {
  const bolCombined = [nz(inv.billOfLadingNo), nz(inv.billOfLadingDate) ? `Dt ${nz(inv.billOfLadingDate)}` : ""]
    .filter(Boolean)
    .join(" ") || EMPTY_FIELD;
  const r1 = `<tr><td>${metaInner("Buyer's Order No.", inv.buyerOrderNo)}</td><td class="inv-mid-sep" rowspan="4"></td><td>${metaInner("Dated", inv.buyerOrderDate)}</td></tr>`;
  const r2 = `<tr><td>${metaInner("Dispatch Doc No.", inv.dispatchDocNo)}</td><td>${metaInner("Delivery Note Date", inv.deliveryNoteDate)}</td></tr>`;
  const r3 = `<tr><td>${metaInner("Dispatched through", inv.dispatchedThrough)}</td><td>${metaInner("Destination", inv.destination)}</td></tr>`;
  const r4 = `<tr><td>${metaInner("Bill of Lading/LR-RR No. & Date", bolCombined)}</td><td>${metaInner("Motor Vehicle No.", inv.motorVehicleNo)}</td></tr>`;
  return `<table class="inv-subtable inv-meta-grid inv-meta-grid-2col" role="presentation"><colgroup><col /><col class="inv-mid-sep-col" /><col /></colgroup><tbody>${r1}${r2}${r3}${r4}</tbody></table>`;
}

function buildBuyerTermsOnlyGrid(inv) {
  const terms = nz(inv.termsOfDelivery);
  const termsHtml = terms ? escapeHtml(terms).replace(/\n/g, "<br />") : escapeHtml(EMPTY_FIELD);
  return `<table class="inv-subtable inv-meta-grid inv-meta-grid-1col" role="presentation"><tbody><tr><td><div class="inv-meta-label">Terms of Delivery</div><div class="inv-meta-value">${termsHtml}</div></td></tr></tbody></table>`;
}

function buildItemsTable(inv) {
  const items = inv.items || [];
  const rates = pct(inv);
  const cgstR = rates.cgst / 100;
  const sgstR = rates.sgst / 100;
  let totalQty = 0;
  let perUnit = "Kgs";

  const bodies = items.length
    ? items
        .map((it, i) => {
          const taxable = Number(it.amount) || 0;
          const cgst = Math.round(taxable * cgstR * 100) / 100;
          const sgst = Math.round(taxable * sgstR * 100) / 100;
          const qty = Number(it.quantity) || 0;
          totalQty += qty;
          if (nz(it.per)) perUnit = String(it.per).trim();
          return `<tbody>
<tr>
  <td rowspan="3" class="c-num">${i + 1}</td>
  <td rowspan="3" class="c-desc">
    <div class="inv-desc-cell-inner">
      <div class="inv-desc-product"><strong>${escapeHtml(it.name)}</strong></div>
      <div class="inv-desc-tax-labels">
        <span class="inv-tax-line">CGST @ ${rates.cgst}%</span><br />
        <span class="inv-tax-line">SGST @ ${rates.sgst}%</span>
      </div>
    </div>
  </td>
  <td rowspan="3" class="c-hsn">${escapeHtml(it.hsn || EMPTY_FIELD)}</td>
  <td rowspan="3" class="num">${escapeHtml(String(it.quantity))}</td>
  <td rowspan="3" class="num">${formatMoney(it.rate)}</td>
  <td rowspan="3" class="c-per">${escapeHtml(it.per || "Pcs")}</td>
  <td class="num">${formatMoney(it.amount)}</td>
</tr>
<tr><td class="num">${formatMoney(cgst)}</td></tr>
<tr><td class="num">${formatMoney(sgst)}</td></tr>
</tbody>`;
        })
        .join("")
    : `<tbody><tr><td colspan="7" class="num">${EMPTY_FIELD}</td></tr></tbody>`;

  const qtyLabel = `${totalQty} ${perUnit}`.trim();
  const wordsRaw = safeAmountToWords(inv.total);
  const wordsDisplay = wordsRaw ? `INR ${wordsRaw.toUpperCase()}` : EMPTY_FIELD;

  const prev = inv.previousBalanceSnapshot ?? inv.previousBalance;
  const curr = inv.currentBalanceSnapshot ?? inv.currentBalance;
  const hasPrev = typeof prev === "number" && !Number.isNaN(prev);
  const hasCurr = typeof curr === "number" && !Number.isNaN(curr);
  const paidRaw = Number(inv.amountPaidOnInvoice);
  const paid = Number.isFinite(paidRaw) ? paidRaw : 0;
  const payStatus = String(inv.paymentStatus ?? "").trim();
  const showPaymentReceived = paid > 0 && payStatus !== "unpaid";
  const methodLabel = paymentMethodDisplay(inv.paymentMethod);

  const balances = [
    `<div class="inv-eoe">E.&O.E</div>`,
    hasPrev ? formatBalanceLine("Previous Balance", prev) : "",
    showPaymentReceived
      ? `<div><strong>Payment received on this invoice:</strong> ₹ ${formatMoney(paid)}${methodLabel ? ` (${escapeHtml(methodLabel)})` : ""}</div>`
      : "",
    hasCurr ? formatBalanceLine("Current Balance", curr) : "",
  ]
    .filter(Boolean)
    .join("");

  return `<table class="inv-subtable inv-print-table inv-items" role="presentation">
    <colgroup>
      <col style="width:28px" />
      <col style="width:300px" />
      <col style="width:66px" />
      <col style="width:58px" />
      <col style="width:66px" />
      <col style="width:42px" />
      <col style="width:96px" />
    </colgroup>
    <thead>
      <tr>
        <th>Sl.No.</th>
        <th>Description of Goods</th>
        <th>HSN/SAC</th>
        <th class="num">Quantity</th>
        <th class="num">Rate</th>
        <th>Per</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    ${bodies}
    <tfoot>
      <tr>
        <td colspan="3" class="num"><strong>Total:</strong></td>
        <td class="num"><strong>${escapeHtml(qtyLabel)}</strong></td>
        <td colspan="2"></td>
        <td class="num"><strong>${formatMoney(inv.total)}</strong></td>
      </tr>
      <tr>
        <td colspan="7" class="inv-words-balance-wrap">
          <table class="inv-subtable inv-words-balance-split" role="presentation">
            <colgroup>
              <col style="width:70%" />
              <col style="width:30%" />
            </colgroup>
            <tbody>
              <tr>
                <td class="inv-words-cell inv-words-cell-70"><div class="inv-chargeable-in-words"><strong>Amount chargeable (in words):</strong><br /><strong>${escapeHtml(wordsDisplay)}</strong></div></td>
                <td class="inv-balance-cell inv-balance-cell-30">${balances || "&nbsp;"}</td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
    </tfoot>
  </table>`;
}

function hsnSummaryRows(inv) {
  const items = inv.items || [];
  const map = new Map();
  const rates = pct(inv);
  for (const it of items) {
    const hsn = nz(it.hsn) || EMPTY_FIELD;
    const taxable = Number(it.amount) || 0;
    if (!map.has(hsn)) map.set(hsn, { taxable: 0, hsn });
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

function buildTaxSummaryTable(inv) {
  const rows = hsnSummaryRows(inv);
  const bodyRows = rows
    .map(
      (r) => `<tr>
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

  const sumTaxable = rows.reduce((a, r) => a + r.taxable, 0);
  const sumCgst = rows.reduce((a, r) => a + r.cgstAmt, 0);
  const sumSgst = rows.reduce((a, r) => a + r.sgstAmt, 0);
  const sumTax = rows.reduce((a, r) => a + r.taxTot, 0);

  return `<table class="inv-subtable inv-print-table inv-tax-summary" role="presentation">
<thead>
  <tr>
    <th rowspan="2">HSN/SAC</th>
    <th rowspan="2" class="num">Taxable Value</th>
    <th colspan="2" class="num">CGST</th>
    <th colspan="2" class="num">SGST/UTGST</th>
    <th rowspan="2" class="num">Total Tax Amount</th>
  </tr>
  <tr>
    <th class="num">Rate</th>
    <th class="num">Amount</th>
    <th class="num">Rate</th>
    <th class="num">Amount</th>
  </tr>
</thead>
<tbody>${bodyRows || `<tr><td colspan="7" class="num">${EMPTY_FIELD}</td></tr>`}</tbody>
<tfoot>
  <tr>
    <td><strong>Total:</strong></td>
    <td class="num"><strong>${formatMoney(sumTaxable)}</strong></td>
    <td></td>
    <td class="num"><strong>${formatMoney(sumCgst)}</strong></td>
    <td></td>
    <td class="num"><strong>${formatMoney(sumSgst)}</strong></td>
    <td class="num"><strong>${formatMoney(sumTax)}</strong></td>
  </tr>
</tfoot>
</table>`;
}

function buildDeclarationBlock(inv) {
  const wordsRaw = safeAmountToWords(inv.total);
  const wordsDisplay = wordsRaw ? `INR ${wordsRaw.toUpperCase()}` : EMPTY_FIELD;
  const decl = nz(inv.invoiceTerms) || EMPTY_FIELD;
  return `<p class="inv-decl-words"><strong>Amount chargeable (in words):</strong><br /><strong>${escapeHtml(wordsDisplay)}</strong></p><div class="inv-decl-title">Declaration</div><pre class="inv-decl-text">${escapeHtml(decl)}</pre>`;
}

function buildBankBlock(inv) {
  const rows = [
    ["A/C Holder's Name", inv.accountHolderName],
    ["Bank Name", inv.bankName],
    ["A/C Number", inv.bankAccount],
    ["IFSC Code", inv.bankIfsc],
    ["Branch", inv.bankBranch],
  ]
    .filter(([, v]) => nz(v))
    .map(
      ([k, v]) =>
        `<div class="inv-bank-line"><span class="inv-bank-k">${escapeHtml(k)}</span><span class="inv-bank-colon">:</span><span class="inv-bank-v">${escapeHtml(String(v).trim())}</span></div>`
    )
    .join("");

  return `<div class="inv-bank-wrap">
  <div class="inv-bank-title">COMPANY'S BANK DETAILS</div>
  ${rows || `<div class="inv-bank-line">${EMPTY_FIELD}</div>`}
</div>`;
}

function buildSignatureTable(inv, options = {}) {
  const subForSig = inv.sellerSubtitle ? ` ${escapeHtml(inv.sellerSubtitle)}` : "";
  const includeStamp = options.includeStamp === true;

  const textBlock = `<div class="inv-sign-for">For <strong>${escapeHtml(inv.sellerName)}</strong>${subForSig}</div>
      <div class="inv-sign-auth">Authorised Signatory</div>`;

  const companyCell = includeStamp
    ? `<td class="inv-sign-company inv-sign-company--with-stamp">
      <div class="inv-sign-company-row">
        <div class="inv-sign-stamp-wrap" aria-hidden="true">
          <img class="inv-sign-stamp-img" src="${escapeHtml(resolveStampAssetUrl())}" alt="" width="150" height="235" decoding="sync" loading="eager" />
        </div>
        <div class="inv-sign-company-text">${textBlock}</div>
      </div>
    </td>`
    : `<td class="inv-sign-company">
      ${textBlock}
    </td>`;

  return `<table class="inv-subtable inv-sign-table${includeStamp ? " inv-sign-table--with-stamp" : ""}" role="presentation">
  <colgroup>
    <col class="inv-sign-col-customer" style="width:40%" />
    <col class="inv-sign-col-company" style="width:60%" />
  </colgroup>
<tbody>
  <tr>
    <td class="inv-sign-customer">Customer's Seal and Signature</td>
    ${companyCell}
  </tr>
</tbody>
</table>`;
}

function buildFooterNoteOutside(inv) {
  const footerNote = inv.jurisdictionFooter || "Subject to Madurai Jurisdiction";
  return `<div class="inv-outside-footer">
    <div class="inv-footer-jurisdiction">${escapeHtml(footerNote)}</div>
    <div class="inv-computer-gen">This is a Computer Generated Invoice</div>
  </div>`;
}

function buildMainInvoiceTable(inv, options = {}) {
  return `<table class="inv-root-table" role="presentation">
  <colgroup>
    <col style="width:45%" />
    <col style="width:55%" />
  </colgroup>
  <tbody>
    <tr>
      <td class="inv-cell-company">${buildSellerTable(inv)}</td>
      <td class="inv-cell-invoiceinfo">${buildSellerInfoGrid(inv)}</td>
    </tr>
    <tr>
      <td class="inv-cell-consignee"><div class="block-label">Consignee (Ship to)</div>${buildShipToTable(inv)}</td>
      <td class="inv-cell-consignee-info">${buildConsigneeInfoGrid(inv)}</td>
    </tr>
    <tr>
      <td class="inv-cell-buyer"><div class="block-label">Buyer (Bill to)</div>${buildBillToTable(inv)}</td>
      <td class="inv-cell-buyer-info">${buildBuyerTermsOnlyGrid(inv)}</td>
    </tr>
    <tr><td colspan="2" class="inv-cell-items">${buildItemsTable(inv)}</td></tr>
    <tr><td colspan="2" class="inv-cell-tax">${buildTaxSummaryTable(inv)}</td></tr>
    <tr>
      <td colspan="2" class="inv-cell-footer-split">
        <table class="inv-subtable inv-footer-split" role="presentation">
          <colgroup>
            <col style="width:70%" />
            <col style="width:30%" />
          </colgroup>
          <tbody>
            <tr>
              <td class="inv-cell-declaration">${buildDeclarationBlock(inv)}</td>
              <td class="inv-cell-bank">${buildBankBlock(inv)}</td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
    <tr><td colspan="2" class="inv-cell-signature">${buildSignatureTable(inv, options)}</td></tr>
  </tbody>
</table>`;
}

function buildHeaderOutside() {
  return `<div class="inv-outside-header">TAX INVOICE</div>`;
}

export function buildInvoiceHtml(inv, options = {}) {
  return `${buildHeaderOutside()}${buildMainInvoiceTable(inv, options)}${buildFooterNoteOutside(inv)}`;
}

export function renderInvoiceDocument(inv, options = {}) {
  const root = document.createElement("div");
  root.className = "invoice-doc gst-invoice invoice-a4-compact invoice-a4-single";
  root.innerHTML = buildInvoiceHtml(inv, options);
  root.querySelectorAll("img.inv-sign-stamp-img").forEach((img) => {
    img.src = resolveStampAssetUrl();
  });
  return root;
}

export function printInvoice() {
  window.print();
}
