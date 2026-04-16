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
  Timestamp,
} from "firebase/firestore";
import { round2 } from "./invoices.js";
import {
  allocatePaymentSelectedThenFifo,
  isInvoiceOpen,
  listOpenInvoiceIdsOldestFirst,
  MAX_INVOICES_TO_ALLOCATE,
} from "./payment-fifo.js";

/** yyyy-mm-dd → Date (local noon, stable in TZ). */
export function parsePaymentDateIso(iso) {
  const s = String(iso || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date();
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(y, mo, day, 12, 0, 0);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function timestampFromPaymentDateIso(iso) {
  return Timestamp.fromDate(parsePaymentDateIso(iso));
}

/** Today as yyyy-mm-dd for date inputs. */
export function todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fakeSnap(data) {
  return {
    exists: () => true,
    data: () => data,
  };
}

/**
 * If the user ticked specific invoices, the payment must be at least the sum of those invoices' outstanding balances.
 */
function assertPaymentCoversSelectedInvoices(amt, selectedInvoiceIds, validated) {
  const ids = (selectedInvoiceIds || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (!ids.length) return;
  const seen = new Set();
  let sumOwed = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = validated.find((r) => r.ref.id === id);
    if (!row || !row.snap.exists()) {
      throw new Error(
        "One or more selected invoices are missing or invalid. Refresh the page and try again."
      );
    }
    const inv = row.snap.data();
    if (!isInvoiceOpen(inv)) {
      throw new Error(
        "One or more selected invoices are already fully paid. Refresh the page and try again."
      );
    }
    const total = round2(Number(inv.total) || 0);
    const paid = round2(Number(inv.amountPaidOnInvoice) || 0);
    sumOwed = round2(sumOwed + round2(total - paid));
  }
  if (amt < sumOwed - 1e-6) {
    throw new Error(
      "The amount received is less than the total outstanding on the invoices you selected. Untick one or more invoices, or enter a higher amount."
    );
  }
}

function assertAllocationTotalsMatch(amt, allocResult) {
  const { updates, totalApplied, remainingCash } = allocResult;
  const sumTakes = updates.reduce((s, u) => round2(s + u.take), 0);
  if (Math.abs(round2(sumTakes - totalApplied)) > 0.02) {
    throw new Error("Payment allocation did not balance; try again or adjust the amount slightly.");
  }
  if (Math.abs(round2(totalApplied + remainingCash - amt)) > 0.02) {
    throw new Error("Payment allocation did not balance; try again or adjust the amount slightly.");
  }
}

function mapAllocatedInvoiceRows(updates, before) {
  return updates.map((u) => {
    const b = before[u.invoiceId];
    if (!b) {
      throw new Error("Internal error: missing invoice state for allocation.");
    }
    return {
      invoiceId: u.invoiceId,
      invoiceNumber: u.invoiceNumber,
      amountApplied: u.take,
      paidBefore: b.paid,
      paidAfter: u.newPaid,
      statusBefore: b.status,
      statusAfter: u.newStatus,
    };
  });
}

/**
 * Open + unpaid/partial invoices for dropdown (label includes owed).
 * @param {import('firebase/firestore').Firestore} db
 */
export async function listOpenInvoicesForPaymentSelect(db, uid, customerId) {
  const q = query(
    collection(db, "invoices"),
    where("userId", "==", uid),
    where("customerId", "==", customerId)
  );
  const snap = await getDocs(q);
  const rows = [];
  for (const d of snap.docs) {
    const inv = d.data();
    if (!isInvoiceOpen(inv)) continue;
    const total = round2(Number(inv.total) || 0);
    const paid = round2(Number(inv.amountPaidOnInvoice) || 0);
    const owed = round2(total - paid);
    const num = String(inv.invoiceNumber || "").trim() || d.id;
    const st = String(inv.paymentStatus || "unpaid").toLowerCase();
    rows.push({
      id: d.id,
      invoiceNumber: inv.invoiceNumber || "",
      total,
      paid,
      owed,
      paymentStatus: st,
      label: `${num} — ₹${owed.toFixed(2)} owed (${st})`,
      date: inv.date,
    });
  }
  rows.sort((a, b) => {
    const ma = a.date && typeof a.date.toMillis === "function" ? a.date.toMillis() : 0;
    const mb = b.date && typeof b.date.toMillis === "function" ? b.date.toMillis() : 0;
    if (ma !== mb) return ma - mb;
    return String(a.invoiceNumber || "").localeCompare(String(b.invoiceNumber || ""), undefined, {
      numeric: true,
    });
  });
  return rows;
}

async function collectInvoiceIdsForAllocation(db, uid, customerId, selectedInvoiceIds) {
  let openIds;
  try {
    openIds = await listOpenInvoiceIdsOldestFirst(db, uid, customerId);
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
  const set = new Set(openIds);
  for (const raw of selectedInvoiceIds || []) {
    const id = String(raw || "").trim();
    if (id) set.add(id);
  }
  return [...set].slice(0, MAX_INVOICES_TO_ALLOCATE);
}

/**
 * Record payment: applies to selected invoices first (in order), then remainder to oldest-dated opens.
 * @param {import('firebase/firestore').Firestore} db
 */
export async function recordCustomerPayment(
  db,
  uid,
  { customerId, amount, paymentMethod, note, amountReceivedDateIso, selectedInvoiceIds }
) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) {
    throw new Error("Payment amount must be greater than zero.");
  }
  const custRef = doc(db, "customers", customerId);
  const txRef = doc(collection(db, "moneyTransactions"));
  const receivedTs = timestampFromPaymentDateIso(amountReceivedDateIso);

  const invoiceIds = await collectInvoiceIdsForAllocation(db, uid, customerId, selectedInvoiceIds);

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
    const before = {};
    for (const id of invoiceIds) {
      const iref = doc(db, "invoices", id);
      const isp = await transaction.get(iref);
      rows.push({ ref: iref, snap: isp });
      if (isp.exists()) {
        const inv = isp.data();
        if (inv.userId !== uid || (inv.customerId || "") !== customerId) continue;
        before[id] = {
          paid: round2(Number(inv.amountPaidOnInvoice) || 0),
          status: inv.paymentStatus || "unpaid",
        };
      }
    }

    const validated = [];
    for (const row of rows) {
      if (!row.snap.exists()) continue;
      const inv = row.snap.data();
      if (inv.userId !== uid || (inv.customerId || "") !== customerId) continue;
      if (!isInvoiceOpen(inv)) continue;
      validated.push({ ref: row.ref, snap: row.snap });
    }

    assertPaymentCoversSelectedInvoices(amt, selectedInvoiceIds, validated);

    const allocResult = allocatePaymentSelectedThenFifo(amt, selectedInvoiceIds || [], validated);
    assertAllocationTotalsMatch(amt, allocResult);
    const { updates } = allocResult;
    const allocatedInvoices = mapAllocatedInvoiceRows(updates, before);

    transaction.set(txRef, {
      userId: uid,
      customerId,
      type: "PAYMENT_STANDALONE",
      amount: amt,
      paymentMethod: (paymentMethod || "other").trim() || "other",
      note: (note || "").trim(),
      invoiceId: null,
      invoiceNumber: null,
      amountReceivedDate: receivedTs,
      recordedAt: serverTimestamp(),
      selectedInvoiceIds: (selectedInvoiceIds || [])
        .map((x) => String(x || "").trim())
        .filter(Boolean),
      allocatedInvoices,
      ledgerStatus: "active",
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
 * Revoke a standalone payment and restore invoices + customer balance.
 */
export async function revokeCustomerPayment(db, uid, { customerId, transactionId }) {
  const txRef = doc(db, "moneyTransactions", transactionId);
  const custRef = doc(db, "customers", customerId);

  await runTransaction(db, async (transaction) => {
    const txSnap = await transaction.get(txRef);
    if (!txSnap.exists()) throw new Error("Transaction not found.");
    const t = txSnap.data();
    if (t.userId !== uid) throw new Error("Invalid transaction.");
    if (t.type !== "PAYMENT_STANDALONE") throw new Error("Only payment entries can be revoked.");
    if (t.customerId !== customerId) throw new Error("Wrong customer.");
    if (t.ledgerStatus === "revoked") throw new Error("Already revoked.");
    if (!Array.isArray(t.allocatedInvoices) || t.allocatedInvoices.length === 0) {
      throw new Error("This payment cannot be revoked (missing allocation details).");
    }

    const custSnap = await transaction.get(custRef);
    if (!custSnap.exists()) throw new Error("Customer not found.");
    if (custSnap.data().userId !== uid) throw new Error("Invalid customer.");

    const cur = round2(Number(custSnap.data().outstandingBalance) || 0);
    const amt = round2(Number(t.amount) || 0);
    const next = round2(cur + amt);

    for (const line of t.allocatedInvoices || []) {
      if (!line.invoiceId) continue;
      const invRef = doc(db, "invoices", line.invoiceId);
      transaction.update(invRef, {
        amountPaidOnInvoice: line.paidBefore,
        paymentStatus: line.statusBefore,
      });
    }

    transaction.update(custRef, {
      outstandingBalance: next,
      balanceUpdatedAt: serverTimestamp(),
    });
    transaction.update(txRef, {
      ledgerStatus: "revoked",
      revokedAt: serverTimestamp(),
    });
  });
}

/**
 * Edit an active standalone payment: reverse its effect and apply new amount / date / selection.
 */
export async function editCustomerPayment(
  db,
  uid,
  {
    customerId,
    transactionId,
    amount,
    paymentMethod,
    note,
    amountReceivedDateIso,
    selectedInvoiceIds,
  }
) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) {
    throw new Error("Payment amount must be greater than zero.");
  }
  const txRef = doc(db, "moneyTransactions", transactionId);
  const custRef = doc(db, "customers", customerId);
  const receivedTs = timestampFromPaymentDateIso(amountReceivedDateIso);

  const invoiceIdsPre = await collectInvoiceIdsForAllocation(db, uid, customerId, selectedInvoiceIds);

  await runTransaction(db, async (transaction) => {
    const txSnap = await transaction.get(txRef);
    if (!txSnap.exists()) throw new Error("Transaction not found.");
    const oldTx = txSnap.data();
    if (oldTx.userId !== uid) throw new Error("Invalid transaction.");
    if (oldTx.type !== "PAYMENT_STANDALONE") throw new Error("Only payment entries can be edited.");
    if (oldTx.customerId !== customerId) throw new Error("Wrong customer.");
    if (oldTx.ledgerStatus === "revoked") throw new Error("Revoked payments cannot be edited.");
    if (!Array.isArray(oldTx.allocatedInvoices) || oldTx.allocatedInvoices.length === 0) {
      throw new Error("This payment cannot be edited (missing allocation details).");
    }

    const custSnap = await transaction.get(custRef);
    if (!custSnap.exists()) throw new Error("Customer not found.");
    if (custSnap.data().userId !== uid) throw new Error("Invalid customer.");

    const cur = round2(Number(custSnap.data().outstandingBalance) || 0);
    const oldAmt = round2(Number(oldTx.amount) || 0);
    const restoredCust = round2(cur + oldAmt);
    if (amt > restoredCust) {
      throw new Error(`Payment cannot exceed outstanding balance (₹ ${restoredCust.toFixed(2)}).`);
    }
    const nextCust = round2(restoredCust - amt);

    const invoiceIds = [...new Set([...invoiceIdsPre, ...(oldTx.allocatedInvoices || []).map((l) => l.invoiceId)])]
      .filter(Boolean)
      .slice(0, MAX_INVOICES_TO_ALLOCATE);

    const rows = [];
    const before = {};
    for (const id of invoiceIds) {
      const iref = doc(db, "invoices", id);
      const isp = await transaction.get(iref);
      if (!isp.exists()) continue;
      const inv = isp.data();
      if (inv.userId !== uid || (inv.customerId || "") !== customerId) continue;

      const line = (oldTx.allocatedInvoices || []).find((l) => l.invoiceId === id);
      const restored = line
        ? {
            ...inv,
            amountPaidOnInvoice: line.paidBefore,
            paymentStatus: line.statusBefore,
          }
        : inv;

      rows.push({ ref: iref, snap: fakeSnap(restored) });
      before[id] = {
        paid: round2(Number(restored.amountPaidOnInvoice) || 0),
        status: restored.paymentStatus || "unpaid",
      };
    }

    const validated = [];
    for (const row of rows) {
      const data = row.snap.data();
      if (!isInvoiceOpen(data)) continue;
      validated.push({ ref: row.ref, snap: row.snap });
    }

    assertPaymentCoversSelectedInvoices(amt, selectedInvoiceIds, validated);

    const allocResult = allocatePaymentSelectedThenFifo(amt, selectedInvoiceIds || [], validated);
    assertAllocationTotalsMatch(amt, allocResult);
    const { updates } = allocResult;
    const allocatedInvoices = mapAllocatedInvoiceRows(updates, before);

    const updateById = new Map(updates.map((u) => [u.invoiceId, u]));
    for (const line of oldTx.allocatedInvoices || []) {
      if (!line.invoiceId || updateById.has(line.invoiceId)) continue;
      const invRef = doc(db, "invoices", line.invoiceId);
      transaction.update(invRef, {
        amountPaidOnInvoice: line.paidBefore,
        paymentStatus: line.statusBefore,
      });
    }

    transaction.update(txRef, {
      amount: amt,
      paymentMethod: (paymentMethod || "other").trim() || "other",
      note: (note || "").trim(),
      amountReceivedDate: receivedTs,
      recordedAt: serverTimestamp(),
      selectedInvoiceIds: (selectedInvoiceIds || [])
        .map((x) => String(x || "").trim())
        .filter(Boolean),
      allocatedInvoices,
      lastEditedAt: serverTimestamp(),
    });

    transaction.update(custRef, {
      outstandingBalance: nextCust,
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

/** Newest active standalone payment in a list (expects `createdAt` desc). */
export function findLatestActiveStandalonePayment(transactions) {
  for (const t of transactions || []) {
    if (t.type !== "PAYMENT_STANDALONE") continue;
    if (t.ledgerStatus === "revoked") continue;
    return t;
  }
  return null;
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
