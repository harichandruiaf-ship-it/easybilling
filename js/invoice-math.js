/**
 * Pure invoice tax / rounding helpers (no Firebase). Used by invoices.js and tests.
 */

/**
 * Round to nearest whole rupee: fractional part &lt; 0.5 → floor, ≥ 0.5 → ceil.
 */
export function roundOffRupee(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const a = Math.abs(x);
  const intPart = Math.floor(a);
  const frac = a - intPart;
  const rounded = frac < 0.5 ? intPart : intPart + 1;
  return x < 0 ? -rounded : rounded;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeTotals(subtotal, cgstPercent, sgstPercent) {
  const s = roundOffRupee(round2(subtotal));
  const cgstR = (Number(cgstPercent) || 0) / 100;
  const sgstR = (Number(sgstPercent) || 0) / 100;
  const cgst = roundOffRupee(round2(s * cgstR));
  const sgst = roundOffRupee(round2(s * sgstR));
  const total = s + cgst + sgst;
  return {
    subtotal: s,
    cgst,
    sgst,
    igst: 0,
    igstPercent: 0,
    total,
    cgstPercent: Number(cgstPercent) || 0,
    sgstPercent: Number(sgstPercent) || 0,
    supplyType: "intra",
  };
}

/** Inter-state: IGST = subtotal × (CGST% + SGST%) from settings. */
export function computeTotalsInterState(subtotal, cgstPercent, sgstPercent) {
  const s = roundOffRupee(round2(subtotal));
  const c = Number(cgstPercent) || 0;
  const g = Number(sgstPercent) || 0;
  const igstPct = c + g;
  const igst = roundOffRupee(round2(s * (igstPct / 100)));
  const total = s + igst;
  return {
    subtotal: s,
    cgst: 0,
    sgst: 0,
    igst,
    igstPercent: igstPct,
    total,
    cgstPercent: c,
    sgstPercent: g,
    supplyType: "inter",
  };
}
