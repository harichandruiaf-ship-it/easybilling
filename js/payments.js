import {
  collection,
  doc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { round2 } from "./invoices.js";

/** Max open invoices considered for FIFO (after sort). */
const MAX_INVOICES_TO_ALLOCATE = 2000;

function isInvoiceOpen(data) {
  const total = round2(Number(data.total) || 0);
  if (total <= 0) return false;
  const paid = round2(Number(data.amountPaidOnInvoice) || 0);
  const st = data.paymentStatus || "unpaid";
  if (st === "paid" && paid >= total - 1e-6) return false;
  return paid < total - 1e-6;
}

function invoiceDateMillis(data) {
  const d = data.date;
  if (d && typeof d.toMillis === "function") return d.toMillis();
  return 0;
}

/**
 * Oldest-first open invoice ids. Uses only userId + customerId equality (no orderBy)
 * so Firestore needs a small composite index — date sort is done in memory.
 */
async function listOpenInvoiceIdsOldestFirst(db, uid, customerId) {
  const q = query(
    collection(db, "invoices"),
    where("userId", "==", uid),
    where("customerId", "==", customerId)
  );
  const snap = await getDocs(q);
  const open = snap.docs
    .filter((d) => isInvoiceOpen(d.data()))
    .sort((a, b) => invoiceDateMillis(a.data()) - invoiceDateMillis(b.data()));
  return open.slice(0, MAX_INVOICES_TO_ALLOCATE).map((d) => d.id);
}

/**
 * @returns {{ updates: Array<{ ref: import('firebase/firestore').DocumentReference, newPaid: number, newStatus: string, take: number, invoiceNumber: string }> }}
 */
function fifoAllocatePayment(paymentAmount, rows) {
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
 * Record a standalone payment against a customer (reduces outstanding balance).
 * Allocates to unpaid/partial invoices oldest-first and marks them paid when covered.
 * @param {import('firebase/firestore').Firestore} db
 */
export async function recordCustomerPayment(db, uid, { customerId, amount, paymentMethod, note }) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) {
    throw new Error("Payment amount must be greater than zero.");
  }
  const custRef = doc(db, "customers", customerId);
  const txRef = doc(collection(db, "moneyTransactions"));

  let invoiceIds;
  try {
    invoiceIds = await listOpenInvoiceIdsOldestFirst(db, uid, customerId);
  } catch (e) {
    const code = e && e.code;
    const msg = (e && e.message) || "";
    if (code === "failed-precondition" || msg.includes("index")) {
      const err = new Error(
        "Database index is missing or still building. Wait a few minutes after creating the index, then try again. Deploy firestore.indexes.json if you have not."
      );
      err.code = code || "failed-precondition";
      throw err;
    }
    throw e;
  }

  await runTransaction(db, async (transaction) => {
    const custSnap = await transaction.get(custRef);
    if (!custSnap.exists()) throw new Error("Customer not found.");
    const d = custSnap.data();
    if (d.userId !== uid) throw new Error("Invalid customer.");
    const cur = round2(Number(d.outstandingBalance) || 0);
    if (amt > cur) {
      throw new Error(`Payment cannot exceed outstanding balance (₹ ${cur.toFixed(2)}).`);
    }
    const next = round2(cur - amt);

    const rows = [];
    for (const id of invoiceIds) {
      const iref = doc(db, "invoices", id);
      const isp = await transaction.get(iref);
      rows.push({ id, ref: iref, snap: isp });
    }

    rows.sort((a, b) => {
      if (!a.snap.exists()) return 1;
      if (!b.snap.exists()) return -1;
      return invoiceDateMillis(a.snap.data()) - invoiceDateMillis(b.snap.data());
    });

    const validated = [];
    for (const row of rows) {
      if (!row.snap.exists()) continue;
      const data = row.snap.data();
      if (data.userId !== uid || (data.customerId || "") !== customerId) continue;
      validated.push({ ref: row.ref, snap: row.snap });
    }

    const { updates } = fifoAllocatePayment(amt, validated);

    const allocationPayload = updates.map((u) => ({
      invoiceId: u.ref.id,
      invoiceNumber: u.invoiceNumber,
      amount: u.take,
    }));

    transaction.set(txRef, {
      userId: uid,
      customerId,
      type: "PAYMENT_STANDALONE",
      amount: amt,
      paymentMethod: (paymentMethod || "other").trim() || "other",
      note: (note || "").trim(),
      invoiceId: null,
      invoiceNumber: null,
      allocatedInvoices: allocationPayload,
      createdAt: serverTimestamp(),
    });

    transaction.update(custRef, {
      outstandingBalance: next,
      balanceUpdatedAt: serverTimestamp(),
    });

    for (const u of updates) {
      transaction.update(u.ref, {
        paymentStatus: u.newStatus,
        amountPaidOnInvoice: u.newPaid,
      });
    }
  });
}

/**
 * @param {import('firebase/firestore').Firestore} db
 */
export async function listMoneyTransactionsForCustomer(db, uid, customerId, maxRows = 50) {
  const q = query(
    collection(db, "moneyTransactions"),
    where("userId", "==", uid),
    where("customerId", "==", customerId),
    orderBy("createdAt", "desc"),
    limit(maxRows)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
