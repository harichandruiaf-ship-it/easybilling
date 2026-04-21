import { amountToWordsIn } from "./number-to-words-in.js";
import { accountPeriodLabelForInvoice, formatInvoiceDateDashed, round2, roundOffRupee } from "./invoices.js";

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

function isInterStateSupply(inv) {
  if (inv.supplyType === "inter") return true;
  if (inv.supplyType === "intra") return false;
  const ig = Number(inv.igst);
  const c = Number(inv.cgst);
  const s = Number(inv.sgst);
  return ig > 0 && c === 0 && s === 0;
}

/** Intra: CGST+SGST %; inter: combined IGST % (stored as `igstPercent` or sum of component rates). */
function pct(inv) {
  if (isInterStateSupply(inv)) {
    let ig = typeof inv.igstPercent === "number" ? inv.igstPercent : NaN;
    if (!Number.isFinite(ig) || ig <= 0) {
      ig = (Number(inv.cgstPercent) || 0) + (Number(inv.sgstPercent) || 0);
    }
    if (!(ig > 0)) return { kind: "inter", igst: null };
    return { kind: "inter", igst: ig };
  }
  const c = inv.cgstPercent;
  const s = inv.sgstPercent;
  if (typeof c === "number" && typeof s === "number") return { kind: "intra", cgst: c, sgst: s };
  return { kind: "intra", cgst: 2.5, sgst: 2.5 };
}

function nz(s) {
  return String(s ?? "").trim();
}

/** Printed value when a field is empty (avoids em dash; keeps cell height). */
const EMPTY_FIELD = "\u00A0";

/** Main invoice grid: 7 cols, sum 656px (Sl 40px). Tax HSN/SAC width uses nested table — see taxTableColgroup7(). */
function invoiceColgroup7() {
  return `<colgroup>
    <col class="inv-col-sl" style="width:40px" />
    <col class="inv-col-desc" style="width:288px" />
    <col class="inv-col-hsn" style="width:62px" />
    <col class="inv-col-qty" style="width:62px" />
    <col class="inv-col-rate" style="width:54px" />
    <col class="inv-col-per" style="width:54px" />
    <col class="inv-col-amt" style="width:96px" />
  </colgroup>`;
}

/** Nested GST tax table (full width of parent cell): 72px HSN/SAC; 256px taxable; CGST/SGST equal pairs; sum 656px. */
function taxTableColgroup7() {
  return `<colgroup>
    <col class="inv-tax-col-hsn" style="width:72px" />
    <col class="inv-tax-col-taxable" style="width:256px" />
    <col style="width:62px" />
    <col style="width:62px" />
    <col style="width:54px" />
    <col style="width:54px" />
    <col style="width:96px" />
  </colgroup>`;
}

/** Inter-state IGST summary: HSN | taxable | IGST rate | IGST amt | total tax — sum 656px. */
function taxTableColgroup5Igst() {
  return `<colgroup>
    <col class="inv-tax-col-hsn" style="width:72px" />
    <col class="inv-tax-col-taxable" style="width:256px" />
    <col style="width:116px" />
    <col style="width:116px" />
    <col style="width:96px" />
  </colgroup>`;
}

/** Receivable balance line: positive = Dr (due), negative = Cr (advance / credit). */
function formatBalanceLine(label, amount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return "";
  const abs = formatMoney(Math.abs(a));
  if (Math.abs(a) < 1e-9) {
    return `<div class="inv-bal-line"><span class="inv-bal-label">${escapeHtml(label)}:</span><span class="inv-bal-value-wrap"><strong class="inv-bal-val">₹ ${abs}</strong></span></div>`;
  }
  const dc = a > 0 ? "Dr" : "Cr";
  return `<div class="inv-bal-line"><span class="inv-bal-label">${escapeHtml(label)}:</span><span class="inv-bal-value-wrap"><strong class="inv-bal-val">₹ ${abs} ${dc}</strong></span></div>`;
}

function partyPhoneContactRow(p) {
  const phone = nz(p.phone);
  const contact = nz(p.contactExtra);
  let v = "";
  if (phone && contact) v = `${phone}, ${contact}`;
  else if (phone) v = phone;
  else if (contact) v = contact;
  return kvDiv("Phone", v);
}

/** Always render label + value row; empty value uses EMPTY_FIELD (not omitting the line). */
function kvDiv(k, v) {
  const val = nz(v);
  const valueInner = val ? escapeHtml(val) : EMPTY_FIELD;
  return `<div class="inv-party-kv"><span class="inv-party-k">${escapeHtml(k)}</span><span class="inv-party-sep"> : </span><span class="inv-party-v">${valueInner}</span></div>`;
}

/**
 * Party block as stacked divs (no nested table).
 * @param {{ name?: string, address?: string, phone?: string, contactExtra?: string, gstin?: string, pan?: string, stateName?: string, stateCode?: string, placeOfSupply?: string, email?: string }} p
 * @param {{ omitEmail?: boolean, omitPlaceOfSupply?: boolean }} [opts]
 */
function buildPartyStack(p, opts = {}) {
  const omitEmail = opts.omitEmail === true;
  const omitPlaceOfSupply = opts.omitPlaceOfSupply === true;
  const parts = [
    `<div class="inv-party-name"><strong>${escapeHtml(p.name || EMPTY_FIELD)}</strong></div>`,
    `<div class="inv-party-addr">${escapeHtml(p.address || "").replace(/\n/g, "<br />") || EMPTY_FIELD}</div>`,
    partyPhoneContactRow(p),
    kvDiv("GSTIN/UIN", p.gstin),
    kvDiv("PAN / IT No", p.pan),
    kvDiv(
      "State Name",
      [nz(p.stateName), nz(p.stateCode) ? `Code: ${nz(p.stateCode)}` : ""].filter(Boolean).join(", ")
    ),
  ];
  if (!omitPlaceOfSupply) parts.push(kvDiv("Place of supply", p.placeOfSupply));
  if (!omitEmail) parts.push(kvDiv("Email", p.email));
  return `<div class="inv-party-stack inv-party-table">${parts.join("")}</div>`;
}

function buildSellerStack(inv) {
  return buildPartyStack(
    {
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
    },
    { omitPlaceOfSupply: true }
  );
}

function buildBillToStack(inv) {
  return buildPartyStack(
    {
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
    },
    { omitEmail: true }
  );
}

function buildShipToStack(inv) {
  if (inv.consigneeSameAsBuyer !== false) return buildBillToStack(inv);
  return buildPartyStack(
    {
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
    },
    { omitEmail: true }
  );
}

function metaInner(label, value) {
  return `<div class="inv-meta-label">${escapeHtml(label)}</div><div class="inv-meta-value">${escapeHtml(nz(value) || EMPTY_FIELD)}</div>`;
}

function metaTileSpan6(label, value, spanCols) {
  return `<div class="inv-meta-tile inv-meta-tile-span${spanCols}">${metaInner(label, value)}</div>`;
}

function buildSellerInfoGridFlat(inv) {
  const dateStr = formatInvoiceDateDashed(inv.date);
  const refCombined = [nz(inv.referenceNo), nz(inv.referenceDate)].filter(Boolean).join(" dt ") || EMPTY_FIELD;

  return `<div class="inv-meta-seller-right-fill">
    <div class="inv-meta-grid inv-meta-grid-seller inv-meta-flat inv-meta-flat-6" role="presentation">
    ${metaTileSpan6("Invoice No.", inv.invoiceNumber || EMPTY_FIELD, 2)}
    ${metaTileSpan6("e-Way Bill No.", inv.ewayBillNo, 2)}
    ${metaTileSpan6("Dated", dateStr || EMPTY_FIELD, 2)}
    ${metaTileSpan6("Delivery Note", inv.deliveryNote, 3)}
    ${metaTileSpan6("Mode / Terms of Payment", inv.paymentTerms, 3)}
    ${metaTileSpan6("Reference No. & Date", refCombined, 3)}
    ${metaTileSpan6("Other References", inv.otherReferences, 3)}
    </div>
  </div>`;
}

function buildConsigneeInfoGridFlat(inv) {
  const bolCombined = [nz(inv.billOfLadingNo), nz(inv.billOfLadingDate) ? `Dt ${nz(inv.billOfLadingDate)}` : ""]
    .filter(Boolean)
    .join(" ") || EMPTY_FIELD;
  /* 4 rows × 2 cols (6-column grid, span 3 + 3); wrapper fills td height like seller-right meta */
  return `<div class="inv-meta-ship-right-fill">
    <div class="inv-meta-grid inv-meta-flat inv-meta-flat-ship inv-meta-flat-ship-6" role="presentation">
    ${metaTileSpan6("Buyer's Order No.", inv.buyerOrderNo, 3)}
    ${metaTileSpan6("Dated", inv.buyerOrderDate, 3)}
    ${metaTileSpan6("Dispatch Doc No.", inv.dispatchDocNo, 3)}
    ${metaTileSpan6("Delivery Note Date", inv.deliveryNoteDate, 3)}
    ${metaTileSpan6("Dispatched through", inv.dispatchedThrough, 3)}
    ${metaTileSpan6("Destination", inv.destination, 3)}
    ${metaTileSpan6("Bill of Lading/LR-RR No. & Date", bolCombined, 3)}
    ${metaTileSpan6("Motor Vehicle No.", inv.motorVehicleNo, 3)}
    </div>
  </div>`;
}

function buildBuyerTermsOnlyFlat(inv) {
  const terms = nz(inv.termsOfDelivery);
  const termsHtml = terms ? escapeHtml(terms).replace(/\n/g, "<br />") : escapeHtml(EMPTY_FIELD);
  return `<div class="inv-meta-grid inv-meta-grid-1col inv-meta-flat inv-meta-flat-terms" role="presentation">
    <div class="inv-meta-tile inv-meta-tile-full"><div class="inv-meta-label">Terms of Delivery</div><div class="inv-meta-value">${termsHtml}</div></div>
  </div>`;
}

function buildGoodsTbodyHtml(inv) {
  const items = inv.items || [];
  let totalQty = 0;
  let perUnit = "Kgs";

  const itemRows = items.length
    ? items
        .map((it, i) => {
          const qty = Number(it.quantity) || 0;
          totalQty += qty;
          if (nz(it.per)) perUnit = String(it.per).trim();
          return `<tr class="inv-item-line">
  <td class="c-num inv-cell-c">${i + 1}</td>
  <td class="c-desc">
    <div class="inv-desc-product"><strong>${escapeHtml(it.name)}</strong></div>
  </td>
  <td class="c-hsn inv-cell-c">${escapeHtml(it.hsn || EMPTY_FIELD)}</td>
  <td class="num inv-cell-c"><strong>${escapeHtml(String(it.quantity))}</strong></td>
  <td class="num inv-cell-c">${formatMoney(it.rate)}</td>
  <td class="c-per inv-cell-c">${escapeHtml(it.per || "Kgs")}</td>
  <td class="num"><strong>${formatMoney(it.amount)}</strong></td>
</tr>`;
        })
        .join("")
    : `<tr class="inv-item-line inv-item-empty"><td colspan="7" class="num">${EMPTY_FIELD}</td></tr>`;

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
      ? `<div class="inv-bal-line inv-pay-received-line"><span class="inv-bal-label">Payment received on this invoice:</span><span class="inv-bal-value-wrap inv-bal-value-wrap--stack"><strong class="inv-bal-val">₹ ${formatMoney(paid)}</strong>${methodLabel ? `<span class="inv-pay-method">(${escapeHtml(methodLabel)})</span>` : ""}</span></div>`
      : "",
    hasCurr ? formatBalanceLine("Current Balance", curr) : "",
  ]
    .filter(Boolean)
    .join("");

  const rates = pct(inv);
  let sumAmounts = 0;
  for (const it of items) {
    sumAmounts += Number(it.amount) || 0;
  }
  sumAmounts = roundOffRupee(round2(sumAmounts));
  const taxableSum =
    typeof inv.subtotal === "number" && !Number.isNaN(inv.subtotal)
      ? roundOffRupee(round2(inv.subtotal))
      : sumAmounts;
  const spacerRow =
    items.length > 0
      ? `<tr class="inv-goods-spacer-row">${Array.from({ length: 7 }, () => `<td class="inv-goods-spacer-cell">${EMPTY_FIELD}</td>`).join("")}</tr>`
      : "";

  let goodsTaxRows = "";
  if (items.length > 0) {
    if (rates.kind === "inter") {
      const igstAll =
        typeof inv.igst === "number" && !Number.isNaN(inv.igst)
          ? roundOffRupee(round2(inv.igst))
          : rates.igst != null && rates.igst > 0
            ? roundOffRupee(round2(taxableSum * (rates.igst / 100)))
            : 0;
      const igstPctLabel = rates.igst == null ? "—" : `${rates.igst}%`;
      goodsTaxRows = `<tr class="inv-goods-tax-agg">
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="c-desc inv-goods-tax-desc"><span class="inv-tax-line">IGST @ ${igstPctLabel}</span></td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="num"><strong>${formatMoney(igstAll)}</strong></td>
</tr>`;
    } else {
      const cgstAll =
        typeof inv.cgst === "number" && !Number.isNaN(inv.cgst)
          ? roundOffRupee(round2(inv.cgst))
          : roundOffRupee(round2(taxableSum * (rates.cgst / 100)));
      const sgstAll =
        typeof inv.sgst === "number" && !Number.isNaN(inv.sgst)
          ? roundOffRupee(round2(inv.sgst))
          : roundOffRupee(round2(taxableSum * (rates.sgst / 100)));
      goodsTaxRows = `<tr class="inv-goods-tax-agg">
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="c-desc inv-goods-tax-desc"><span class="inv-tax-line">CGST @ ${rates.cgst}%</span></td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="num"><strong>${formatMoney(cgstAll)}</strong></td>
</tr>
<tr class="inv-goods-tax-agg">
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="c-desc inv-goods-tax-desc"><span class="inv-tax-line">SGST @ ${rates.sgst}%</span></td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="inv-goods-filler">${EMPTY_FIELD}</td>
  <td class="num"><strong>${formatMoney(sgstAll)}</strong></td>
</tr>`;
    }
  }

  const goodsHeadRow = `<tr class="inv-goods-head-row">
        <th class="inv-th-sl">Sl.No.</th>
        <th>Description of Goods</th>
        <th>HSN/SAC</th>
        <th class="num">Quantity</th>
        <th class="num">Rate</th>
        <th>Per</th>
        <th class="num">Amount</th>
      </tr>`;

  const totalRow = `<tr class="inv-goods-total-row">
        <td colspan="2" class="inv-total-label-cell"><span class="inv-ft-label inv-ft-total">Total:</span></td>
        <td class="inv-goods-filler">${EMPTY_FIELD}</td>
        <td class="num inv-cell-c"><strong>${escapeHtml(qtyLabel)}</strong></td>
        <td class="inv-goods-filler">${EMPTY_FIELD}</td>
        <td class="inv-goods-filler">${EMPTY_FIELD}</td>
        <td class="num"><strong>${formatMoney(inv.total)}</strong></td>
      </tr>`;

  /* 4 + 3 cols: narrower words band, wider balance (Rate+Per+Amount) so Prev./Current balance stay one line */
  const wordsBalanceRow = `<tr class="inv-words-balance-row">
        <td colspan="4" class="inv-words-cell"><div class="inv-chargeable-in-words"><span class="inv-words-label">Amount chargeable (in words):</span><br /><strong class="inv-words-amount">${escapeHtml(wordsDisplay)}</strong></div></td>
        <td colspan="3" class="inv-balance-cell">${balances || "&nbsp;"}</td>
      </tr>`;

  return `<tbody class="inv-tbody-goods inv-items">
${goodsHeadRow}
${itemRows}
${spacerRow}
${goodsTaxRows}
${totalRow}
${wordsBalanceRow}
</tbody>`;
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
    row.taxable = roundOffRupee(round2(row.taxable + taxable));
  }
  const rows = [];
  for (const [, row] of map) {
    const tv = row.taxable;
    if (rates.kind === "inter") {
      const igstR = rates.igst != null && rates.igst > 0 ? rates.igst / 100 : 0;
      const igstAmt = roundOffRupee(round2(tv * igstR));
      rows.push({
        kind: "inter",
        hsn: row.hsn,
        taxable: tv,
        igstRate: rates.igst,
        igstAmt,
        taxTot: igstAmt,
      });
    } else {
      const cgstAmt = roundOffRupee(round2(tv * (rates.cgst / 100)));
      const sgstAmt = roundOffRupee(round2(tv * (rates.sgst / 100)));
      rows.push({
        kind: "intra",
        hsn: row.hsn,
        taxable: tv,
        cgstRate: rates.cgst,
        cgstAmt,
        sgstRate: rates.sgst,
        sgstAmt,
        taxTot: cgstAmt + sgstAmt,
      });
    }
  }
  return rows;
}

function buildTaxTbodyHtml(inv) {
  if (isInterStateSupply(inv)) return buildTaxTbodyHtmlInter(inv);
  return buildTaxTbodyHtmlIntra(inv);
}

function buildTaxTbodyHtmlIntra(inv) {
  const rows = hsnSummaryRows(inv);
  const sumTaxable = rows.reduce((a, r) => a + r.taxable, 0);
  const sumCgst = rows.reduce((a, r) => a + r.cgstAmt, 0);
  const sumSgst = rows.reduce((a, r) => a + r.sgstAmt, 0);
  const sumTax = rows.reduce((a, r) => a + r.taxTot, 0);

  const bodyRows =
    rows.length === 0
      ? `<tr class="inv-tax-hsn-row"><td colspan="7" class="num">${EMPTY_FIELD}</td></tr>`
      : rows
          .map(
            (r) => `<tr class="inv-tax-hsn-row">
<td class="inv-tax-hsn-cell">${escapeHtml(r.hsn)}</td>
<td class="num"><strong>${formatMoney(r.taxable)}</strong></td>
<td class="num"><strong>${r.cgstRate}%</strong></td>
<td class="num"><strong>${formatMoney(r.cgstAmt)}</strong></td>
<td class="num"><strong>${r.sgstRate}%</strong></td>
<td class="num"><strong>${formatMoney(r.sgstAmt)}</strong></td>
<td class="num"><strong>${formatMoney(r.taxTot)}</strong></td>
</tr>`
          )
          .join("");

  const headRows = `<tr class="inv-tax-head inv-tax-head-r1">
    <th rowspan="2">HSN/SAC</th>
    <th rowspan="2" class="num inv-tax-th-stacked">Taxable<br />Value</th>
    <th colspan="2" class="num">CGST</th>
    <th colspan="2" class="num">SGST/UTGST</th>
    <th rowspan="2" class="num inv-tax-th-stacked">Total<br />Tax Amount</th>
  </tr>
  <tr class="inv-tax-head inv-tax-head-r2">
    <th class="num">Rate</th>
    <th class="num">Amount</th>
    <th class="num">Rate</th>
    <th class="num">Amount</th>
  </tr>`;

  const footRow = `<tr class="inv-tax-total-row">
    <td class="inv-tax-total-cell"><strong class="inv-tax-total-label">Total</strong></td>
    <td class="num"><strong>${formatMoney(sumTaxable)}</strong></td>
    <td></td>
    <td class="num"><strong>${formatMoney(sumCgst)}</strong></td>
    <td></td>
    <td class="num"><strong>${formatMoney(sumSgst)}</strong></td>
    <td class="num"><strong>${formatMoney(sumTax)}</strong></td>
  </tr>`;

  const innerBody = `${headRows}
${bodyRows}
${footRow}`;

  return `<tbody class="inv-tbody-tax">
<tr class="inv-tax-embed-outer">
<td colspan="7" class="inv-tax-embed-wrap">
<table class="inv-tax-embed-table inv-tax-summary inv-print-table" role="presentation">
${taxTableColgroup7()}
<tbody>
${innerBody}
</tbody>
</table>
</td>
</tr>
</tbody>`;
}

function buildTaxTbodyHtmlInter(inv) {
  const rows = hsnSummaryRows(inv);
  const sumTaxable = rows.reduce((a, r) => a + r.taxable, 0);
  const sumIgst = rows.reduce((a, r) => a + r.igstAmt, 0);
  const sumTax = rows.reduce((a, r) => a + r.taxTot, 0);

  const bodyRows =
    rows.length === 0
      ? `<tr class="inv-tax-hsn-row"><td colspan="5" class="num">${EMPTY_FIELD}</td></tr>`
      : rows
          .map(
            (r) => `<tr class="inv-tax-hsn-row">
<td class="inv-tax-hsn-cell">${escapeHtml(r.hsn)}</td>
<td class="num"><strong>${formatMoney(r.taxable)}</strong></td>
<td class="num"><strong>${
              r.igstRate != null && r.igstRate > 0 ? `${escapeHtml(String(r.igstRate))}%` : EMPTY_FIELD
            }</strong></td>
<td class="num"><strong>${formatMoney(r.igstAmt)}</strong></td>
<td class="num"><strong>${formatMoney(r.taxTot)}</strong></td>
</tr>`
          )
          .join("");

  const headRows = `<tr class="inv-tax-head inv-tax-head-r1">
    <th rowspan="2">HSN/SAC</th>
    <th rowspan="2" class="num inv-tax-th-stacked">Taxable<br />Value</th>
    <th colspan="2" class="num">IGST</th>
    <th rowspan="2" class="num inv-tax-th-stacked">Total<br />Tax Amount</th>
  </tr>
  <tr class="inv-tax-head inv-tax-head-r2">
    <th class="num">Rate</th>
    <th class="num">Amount</th>
  </tr>`;

  const footRow = `<tr class="inv-tax-total-row">
    <td class="inv-tax-total-cell"><strong class="inv-tax-total-label">Total</strong></td>
    <td class="num"><strong>${formatMoney(sumTaxable)}</strong></td>
    <td></td>
    <td class="num"><strong>${formatMoney(sumIgst)}</strong></td>
    <td class="num"><strong>${formatMoney(sumTax)}</strong></td>
  </tr>`;

  const innerBody = `${headRows}
${bodyRows}
${footRow}`;

  return `<tbody class="inv-tbody-tax">
<tr class="inv-tax-embed-outer">
<td colspan="7" class="inv-tax-embed-wrap">
<table class="inv-tax-embed-table inv-tax-summary inv-tax-summary--igst inv-print-table" role="presentation">
${taxTableColgroup5Igst()}
<tbody>
${innerBody}
</tbody>
</table>
</td>
</tr>
</tbody>`;
}

function buildDeclarationBlock(inv) {
  const wordsRaw = safeAmountToWords(inv.total);
  const wordsDisplay = wordsRaw ? `INR ${wordsRaw.toUpperCase()}` : EMPTY_FIELD;
  const decl = nz(inv.invoiceTerms) || EMPTY_FIELD;
  return `<p class="inv-decl-words"><span class="inv-words-label">Amount chargeable (in words):</span><br /><strong class="inv-words-amount">${escapeHtml(wordsDisplay)}</strong></p><div class="inv-decl-title">Declaration</div><pre class="inv-decl-text">${escapeHtml(decl)}</pre>`;
}

function buildBankBlock(inv) {
  const rowPairs = [
    ["A/C Holder's Name", inv.accountHolderName],
    ["Bank Name", inv.bankName],
    ["A/C Number", inv.bankAccount],
    ["IFSC Code", inv.bankIfsc],
    ["Branch", inv.bankBranch],
  ].filter(([, v]) => nz(v));

  const rows = rowPairs
    .map(
      ([k, v]) =>
        `<tr class="inv-bank-line"><td class="inv-bank-k">${escapeHtml(k)}</td><td class="inv-bank-colon">:</td><td class="inv-bank-v">${escapeHtml(String(v).trim())}</td></tr>`
    )
    .join("");

  const bodyRows =
    rows ||
    `<tr class="inv-bank-line"><td class="inv-bank-empty" colspan="3">${EMPTY_FIELD}</td></tr>`;

  return `<div class="inv-bank-wrap">
  <div class="inv-bank-title">COMPANY'S BANK DETAILS</div>
  <table class="inv-bank-kv-table" role="presentation"><tbody>${bodyRows}</tbody></table>
</div>`;
}

function buildSignatureRow(inv, options = {}) {
  const fy = accountPeriodLabelForInvoice(inv);
  const acSuffix = fy ? ` A/c ${escapeHtml(fy)}` : "";
  const includeStamp = options.includeStamp === true;

  const forLine = `<div class="inv-sign-for">For <strong>${escapeHtml(inv.sellerName)}</strong>${acSuffix}</div>`;
  const authLine = `<div class="inv-sign-auth">Authorised Signatory</div>`;
  const textBlock = `${forLine}
      ${authLine}`;

  const companyCell = includeStamp
    ? `<td colspan="5" class="inv-sign-company inv-sign-company--with-stamp">
      <div class="inv-sign-company-stack">
        ${forLine}
        <div class="inv-sign-stamp-wrap" aria-hidden="true">
          <img class="inv-sign-stamp-img" src="${escapeHtml(resolveStampAssetUrl())}" alt="" width="150" height="235" decoding="sync" loading="eager" />
        </div>
        ${authLine}
      </div>
    </td>`
    : `<td colspan="5" class="inv-sign-company">
      <div class="inv-sign-company-inner">${textBlock}</div>
    </td>`;

  return `<tr class="inv-sign-row inv-sign-table${includeStamp ? " inv-sign-table--with-stamp" : ""}">
    <td colspan="2" class="inv-sign-customer">Customer's Seal and Signature</td>
    ${companyCell}
  </tr>`;
}

function buildFooterNoteOutside(inv) {
  const footerNote = inv.jurisdictionFooter || "Subject to Madurai Jurisdiction";
  /* Sibling of inv-a4-sheet-frame (not inside the <table>) so borders belong only to the table; spacing via CSS. */
  return `<div class="inv-outside-footer inv-outside-footer--below-table inv-a4-bottom-band">
    <div class="inv-footer-jurisdiction">${escapeHtml(footerNote)}</div>
    <div class="inv-computer-gen">This is a Computer Generated Invoice</div>
  </div>`;
}

function buildMainInvoiceTable(inv, options = {}) {
  /* One <table>: 7 columns (Sl + Desc | HSN … Amount); party rows use colspan 2 + 5 to match the former 50/50 split. */
  return `<div class="inv-a4-sheet-frame">
  <div class="inv-a4-sheet-grow">
  <table class="inv-root-table inv-root-invoice inv-invoice-one-table inv-print-table" role="presentation">
  ${invoiceColgroup7()}
  <tbody class="inv-tbody-party">
    <tr>
      <td colspan="2" class="inv-cell-company">${buildSellerStack(inv)}</td>
      <td colspan="5" class="inv-cell-invoiceinfo">${buildSellerInfoGridFlat(inv)}</td>
    </tr>
    <tr>
      <td colspan="2" class="inv-cell-consignee"><div class="block-label">Consignee (ship to)</div>${buildShipToStack(inv)}</td>
      <td colspan="5" class="inv-cell-consignee-info">${buildConsigneeInfoGridFlat(inv)}</td>
    </tr>
    <tr>
      <td colspan="2" class="inv-cell-buyer"><div class="block-label">Buyer (bill to)</div>${buildBillToStack(inv)}</td>
      <td colspan="5" class="inv-cell-buyer-info">${buildBuyerTermsOnlyFlat(inv)}</td>
    </tr>
  </tbody>
  ${buildGoodsTbodyHtml(inv)}
  ${buildTaxTbodyHtml(inv)}
  <tbody class="inv-tbody-footer">
    <tr class="inv-footer-decl-bank-row">
      <td colspan="4" class="inv-cell-declaration">${buildDeclarationBlock(inv)}</td>
      <td colspan="3" class="inv-cell-bank">${buildBankBlock(inv)}</td>
    </tr>
    ${buildSignatureRow(inv, options)}
  </tbody>
  </table>
  </div>
</div>`;
}

function buildHeaderOutside(_inv, options = {}) {
  const label = String(options.invoiceTypeLabel || "").trim();
  const typeLine = label
    ? `<div class="inv-outside-header-type">${escapeHtml(label)}</div>`
    : "";
  return `<div class="inv-outside-header-wrap">
    <div class="inv-outside-header">TAX INVOICE</div>${typeLine}
  </div>`;
}

export function buildInvoiceHtml(inv, options = {}) {
  /* Footer is outside inv-a4-sheet-frame so it is not part of the bordered table box. */
  return `<div class="inv-a4-page">
  <div class="inv-a4-top-band">${buildHeaderOutside(inv, options)}</div>
  <div class="inv-a4-sheet">${buildMainInvoiceTable(inv, options)}${buildFooterNoteOutside(inv)}</div>
</div>`;
}

export function renderInvoiceDocument(inv, options = {}) {
  const root = document.createElement("div");
  root.className = "invoice-doc gst-invoice invoice-a4-compact invoice-a4-single inv-a4-layout";
  root.innerHTML = buildInvoiceHtml(inv, options);
  root.querySelectorAll("img.inv-sign-stamp-img").forEach((img) => {
    img.src = resolveStampAssetUrl();
  });
  return root;
}

export function printInvoice() {
  window.print();
}
