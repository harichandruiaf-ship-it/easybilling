/**
 * Payment allocation helpers: oldest-dated open invoices, and selected-invoices-first + remainder FIFO.
 */
import {
  collection,
  doc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { round2 } from "./invoice-math.js";

/** Max open invoices considered for FIFO (after sort). */
export const MAX_INVOICES_TO_ALLOCATE = 2000;

export function isInvoiceOpen(data) {
  const total = round2(Number(data.total) || 0);
  if (total <= 0) return false;
  const paid = round2(Number(data.amountPaidOnInvoice) || 0);
  const st = String(data.paymentStatus || "unpaid").trim().toLowerCase();
  if (st === "paid" && paid >= total - 1e-6) return false;
  return paid < total - 1e-6;
}

export function invoiceDateMillis(data) {
  const d = data.date;
  if (d && typeof d.toMillis === "function") return d.toMillis();
  return 0;
}

function fifoSortKey(data) {
  return [invoiceDateMillis(data), String(data.invoiceNumber || "").trim()];
}

/** Sort two invoice data objects for FIFO (date asc, then invoice number). */
export function compareInvoiceDataForFifo(a, b) {
  const [ma, na] = fifoSortKey(a);
  const [mb, nb] = fifoSortKey(b);
  if (ma !== mb) return ma - mb;
  return na.localeCompare(nb, undefined, { numeric: true });
}

/**
 * Oldest-first open invoice ids. Date sort is done in memory.
 * @param {import('firebase/firestore').Firestore} db
 */
export async function listOpenInvoiceIdsOldestFirst(db, uid, customerId) {
  const q = query(
    collection(db, "invoices"),
    where("userId", "==", uid),
    where("customerId", "==", customerId)
  );
  const snap = await getDocs(q);
  const open = snap.docs
    .filter((d) => isInvoiceOpen(d.data()))
    .sort((a, b) => {
      const [ma, na] = fifoSortKey(a.data());
      const [mb, nb] = fifoSortKey(b.data());
      if (ma !== mb) return ma - mb;
      return na.localeCompare(nb, undefined, { numeric: true });
    });
  return open.slice(0, MAX_INVOICES_TO_ALLOCATE).map((d) => d.id);
}

/**
 * @returns {{ updates: Array<{ ref: import('firebase/firestore').DocumentReference, newPaid: number, newStatus: string, take: number, invoiceNumber: string }> }}
 */
export function fifoAllocatePayment(paymentAmount, rows) {
  let remaining = round2(paymentAmount);
  const updates = [];
  for (const { ref, snap } of rows) {
    if (remaining <= 0) break;
    if (!snap.exists()) continue;
    const data = snap.data();
    if (!isInvoiceOpen(data)) continue;
    const total = round2(Number(data.total) || 0);
    const paid = round2(Number(data.amountPaidOnInvoice) || 0);
    const owed = round2(total - paid);
    if (owed <= 0) continue;
    const take = round2(Math.min(remaining, owed));
    const newPaid = round2(paid + take);
    const newStatus = newPaid >= total - 1e-6 ? "paid" : "partial";
    remaining = round2(remaining - take);
    updates.push({
      ref,
      newPaid,
      newStatus,
      take,
      invoiceNumber: data.invoiceNumber || "",
    });
  }
  return { updates };
}

/**
 * Apply payment: first to `selectedInvoiceIds` (in order, each id once), then any leftover to
 * other open invoices by oldest date / invoice number.
 * `rows`: validated open `{ ref, snap }[]` for this customer.
 * @returns {{ updates: Array<{ ref: import('firebase/firestore').DocumentReference, newPaid: number, newStatus: string, take: number, invoiceNumber: string, invoiceId: string }>, totalApplied: number, remainingCash: number }}
 */
export function allocatePaymentSelectedThenFifo(paymentAmount, selectedInvoiceIds, rows) {
  const amount = round2(Number(paymentAmount) || 0);
  /** @type {Map<string, { ref: import('firebase/firestore').DocumentReference, data: object, startPaid: number, workingPaid: number, total: number }>} */
  const byId = new Map();
  for (const { ref, snap } of rows) {
    if (!snap.exists()) continue;
    const data = snap.data();
    if (!isInvoiceOpen(data)) continue;
    const id = ref.id;
    const total = round2(Number(data.total) || 0);
    const startPaid = round2(Number(data.amountPaidOnInvoice) || 0);
    byId.set(id, { ref, data, startPaid, workingPaid: startPaid, total });
  }

  let remaining = round2(amount);
  const updates = [];

  function applyToId(id) {
    if (remaining <= 0) return;
    const row = byId.get(id);
    if (!row) return;
    const owed = round2(row.total - row.workingPaid);
    if (owed <= 0) return;
    const take = round2(Math.min(remaining, owed));
    row.workingPaid = round2(row.workingPaid + take);
    remaining = round2(remaining - take);
  }

  const seen = new Set();
  for (const rawId of selectedInvoiceIds || []) {
    const id = String(rawId || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    applyToId(id);
  }

  const restIds = [...byId.keys()].filter((id) => {
    const row = byId.get(id);
    return round2(row.total - row.workingPaid) > 1e-6;
  });
  restIds.sort((a, b) => {
    const da = byId.get(a).data;
    const db = byId.get(b).data;
    return compareInvoiceDataForFifo(da, db);
  });
  for (const id of restIds) {
    if (remaining <= 0) break;
    applyToId(id);
  }

  for (const [id, row] of byId) {
    const take = round2(row.workingPaid - row.startPaid);
    if (take <= 0) continue;
    const newPaid = row.workingPaid;
    const newStatus = newPaid >= row.total - 1e-6 ? "paid" : "partial";
    updates.push({
      ref: row.ref,
      invoiceId: id,
      newPaid,
      newStatus,
      take,
      invoiceNumber: String(row.data.invoiceNumber || ""),
    });
  }

  const totalApplied = round2(amount - remaining);
  return { updates, totalApplied, remainingCash: remaining };
}
