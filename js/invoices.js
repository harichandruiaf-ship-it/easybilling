import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";

import { round2, roundOffRupee } from "./invoice-math.js";

export { round2, roundOffRupee, computeTotals, computeTotalsInterState } from "./invoice-math.js";

/** Ensures we can read/update this customer doc. Lets Firestore permission-denied propagate (so the UI can offer delete-only). */
async function assertCustomerAccessibleForOwner(db, uid, customerId) {
  if (!customerId) return;
  const ref = doc(db, "customers", customerId);
  const snap = await getDoc(ref);
  if (snap.exists() && snap.data().userId !== uid) {
    throw new Error(
      "Customer record is not linked to your account. In Firebase Console, set this customer’s userId to match your login, or clear customerId on the invoice."
    );
  }
}

/**
 * India FY (Apr–Mar): label like "2026-2027" when subtitle / account period is not set in settings.
 */
export function defaultAccountPeriodLabelFromDate(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth();
  if (m >= 3) {
    return `${y}-${y + 1}`;
  }
  return `${y - 1}-${y}`;
}

/** Firestore `date` or Date → local Date, or null. */
export function invoiceDateToJs(dateField) {
  if (!dateField) return null;
  if (typeof dateField.toDate === "function") {
    const d = dateField.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (dateField instanceof Date) return Number.isNaN(dateField.getTime()) ? null : dateField;
  return null;
}

/**
 * India FY label (Apr–Mar) for PDF / filters — matches invoice number suffix.
 * Uses stored `accountPeriod` when present; else invoice date; else parses `invoiceNumber` (e.g. 12/2026-2027).
 */
export function accountPeriodLabelForInvoice(inv) {
  const stored = String(inv?.accountPeriod ?? "").trim();
  if (/^\d{4}-\d{4}$/.test(stored)) return stored;
  const d = invoiceDateToJs(inv?.date);
  if (d) return defaultAccountPeriodLabelFromDate(d);
  const n = String(inv?.invoiceNumber || "");
  const m = n.match(/\/(\d{4}-\d{4})$/);
  if (m) return m[1];
  return defaultAccountPeriodLabelFromDate();
}

/** Recent India FY labels for dropdowns (current first). */
export function enumerateIndiaFYLabels(backCount = 12) {
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  let startYear = mo >= 3 ? y : y - 1;
  const out = [];
  for (let i = 0; i < backCount; i++) {
    const sy = startYear - i;
    out.push(`${sy}-${sy + 1}`);
  }
  return out;
}

/**
 * Normalizes "Subtitle / account period" for invoice suffix (e.g. A/c 2026-2027 → 2026-2027).
 */
export function normalizeAccountPeriodLabel(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/^a\/c\.?\s*/i, "").trim();
  s = s.replace(/\s*[\\/]\s*/g, "-");
  s = s.replace(/\s+/g, "");
  return s;
}

/**
 * Calendar date used to pick India FY (Apr–Mar) for invoice numbering.
 * Prefer `payload.invoiceDateIso` (yyyy-mm-dd from the form); otherwise use "now".
 */
export function invoiceReferenceDateFromPayload(payload) {
  const raw = payload && payload.invoiceDateIso;
  if (typeof raw === "string" && raw.trim()) {
    const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]) - 1;
      const day = Number(m[3]);
      const d = new Date(y, mo, day);
      if (d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day) {
        return d;
      }
    }
  }
  return new Date();
}

/** FY label for sequence + suffix `n/2026-2027` — not driven by seller subtitle (that is display-only). */
function resolveAccountPeriodForNewInvoice(payload) {
  return defaultAccountPeriodLabelFromDate(invoiceReferenceDateFromPayload(payload));
}

/** One sequence per account period; doc id is safe for Firestore (no `/`). */
function invoiceCounterRef(db, uid, periodLabel) {
  const key = periodLabel.replace(/[^a-zA-Z0-9_-]/g, "_") || "period";
  return doc(db, "users", uid, "meta", `invSeq_${key}`);
}

function formatInvoiceNumber(seq, accountPeriodLabel) {
  const p = accountPeriodLabel || defaultAccountPeriodLabelFromDate();
  const n = Number(seq);
  const serial = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  return `${serial}/${p}`;
}

/**
 * Amount collected on this invoice from payment status + optional partial amount.
 * `previousBalance` is what the customer owed before this invoice (negative means they had advance credit).
 * Partial payments may exceed the invoice total to settle prior dues or create advance (negative balance).
 */
/** True when amount paid on invoice covers the invoice total (same 1e-6 tolerance as payment allocation). */
export function isInvoiceFullyPaidByAmounts(inv) {
  const t = round2(Number(inv?.total) ?? 0);
  if (!(t > 0)) return false;
  const paid = round2(Number(inv?.amountPaidOnInvoice) ?? 0);
  return paid >= t - 1e-6;
}

export function computeInvoicePaymentAmounts(total, paymentStatus, amountPaidRaw, previousBalance = 0) {
  const t = round2(Number(total) || 0);
  const prev = round2(Number(previousBalance) || 0);
  const st = String(paymentStatus || "unpaid").trim().toLowerCase();
  if (st === "paid") return { amountPaidOnInvoice: t, normalizedStatus: "paid" };
  if (st === "partial") {
    const p = round2(Math.max(0, Number(amountPaidRaw) || 0));
    if (p <= 0) return { amountPaidOnInvoice: 0, normalizedStatus: "unpaid" };
    const afterPayment = round2(prev + t - p);
    if (p < t) return { amountPaidOnInvoice: p, normalizedStatus: "partial" };
    if (afterPayment <= 0) return { amountPaidOnInvoice: p, normalizedStatus: "paid" };
    return { amountPaidOnInvoice: p, normalizedStatus: "partial" };
  }
  return { amountPaidOnInvoice: 0, normalizedStatus: "unpaid" };
}

/** All invoice document fields except `date` / `updatedAt` (caller adds timestamps). */
function invoiceFieldsFromPayload(uid, invoiceId, invoiceNumber, payload, snap) {
  const prev = snap.previousBalanceSnapshot;
  const curr = snap.currentBalanceSnapshot;
  return {
    invoiceId,
    userId: uid,
    invoiceNumber,
    customerId: snap.customerId || "",
    customerName: payload.customerName,
    buyerAddress: payload.buyerAddress,
    buyerPhone: payload.buyerPhone,
    buyerGstin: payload.buyerGstin || "",
    buyerStateName: payload.buyerStateName || "",
    buyerStateCode: payload.buyerStateCode || "",
    buyerPan: payload.buyerPan || "",
    placeOfSupply: payload.placeOfSupply || "",
    buyerContact: payload.buyerContact || "",
    buyerEmail: payload.buyerEmail || "",
    consigneeSameAsBuyer: payload.consigneeSameAsBuyer !== false,
    consigneeName: payload.consigneeName || "",
    consigneeAddress: payload.consigneeAddress || "",
    consigneeGstin: payload.consigneeGstin || "",
    consigneeStateName: payload.consigneeStateName || "",
    consigneeStateCode: payload.consigneeStateCode || "",
    consigneePhone: payload.consigneePhone || "",
    consigneeEmail: payload.consigneeEmail || "",
    ewayBillNo: payload.ewayBillNo || "",
    deliveryNote: payload.deliveryNote || "",
    paymentTerms: payload.paymentTerms || "",
    referenceNo: payload.referenceNo || "",
    referenceDate: payload.referenceDate || "",
    otherReferences: payload.otherReferences || "",
    buyerOrderNo: payload.buyerOrderNo || "",
    buyerOrderDate: payload.buyerOrderDate || "",
    dispatchDocNo: payload.dispatchDocNo || "",
    deliveryNoteDate: payload.deliveryNoteDate || "",
    dispatchedThrough: payload.dispatchedThrough || "",
    destination: payload.destination || "",
    billOfLadingNo: payload.billOfLadingNo || "",
    billOfLadingDate: payload.billOfLadingDate || "",
    motorVehicleNo: payload.motorVehicleNo || "",
    termsOfDelivery: payload.termsOfDelivery || "",
    vesselFlightNo: payload.vesselFlightNo || "",
    placeReceiptShipper: payload.placeReceiptShipper || "",
    portLoading: payload.portLoading || "",
    portDischarge: payload.portDischarge || "",
    eInvoiceIrn: payload.eInvoiceIrn || "",
    eInvoiceAckNo: payload.eInvoiceAckNo || "",
    eInvoiceAckDate: payload.eInvoiceAckDate || "",
    eInvoiceQrUrl: payload.eInvoiceQrUrl || "",
    paymentStatus: snap.paymentStatus,
    paymentMethod: snap.paymentMethod,
    amountPaidOnInvoice: snap.amountPaidOnInvoice,
    previousBalanceSnapshot: prev,
    currentBalanceSnapshot: curr,
    previousBalance: prev,
    currentBalance: curr,
    sellerName: payload.sellerName,
    sellerSubtitle: payload.sellerSubtitle || "",
    sellerAddress: payload.sellerAddress,
    sellerPhone: payload.sellerPhone,
    sellerGstin: payload.sellerGstin || "",
    sellerEmail: payload.sellerEmail || "",
    sellerStateName: payload.sellerStateName || "",
    sellerStateCode: payload.sellerStateCode || "",
    sellerPan: payload.sellerPan || "",
    sellerUdyam: payload.sellerUdyam || "",
    sellerContactExtra: payload.sellerContactExtra || "",
    bankName: payload.bankName || "",
    bankBranch: payload.bankBranch || "",
    accountHolderName: payload.accountHolderName || "",
    bankAccount: payload.bankAccount || "",
    bankIfsc: payload.bankIfsc || "",
    invoiceTerms: payload.invoiceTerms || "",
    jurisdictionFooter: payload.jurisdictionFooter || "",
    cgstPercent: payload.cgstPercent,
    sgstPercent: payload.sgstPercent,
    supplyType: payload.supplyType === "inter" ? "inter" : "intra",
    igstPercent: typeof payload.igstPercent === "number" && !Number.isNaN(payload.igstPercent) ? payload.igstPercent : 0,
    items: payload.items,
    subtotal: payload.subtotal,
    cgst: payload.cgst,
    sgst: payload.sgst,
    igst: typeof payload.igst === "number" && !Number.isNaN(payload.igst) ? payload.igst : 0,
    total: payload.total,
  };
}

/**
 * Saves invoice, allocates number, updates customer balance and writes ledger rows in one transaction.
 * `payload.customerId` must be set when the buyer exists in `customers` (after add/update customer).
 * Payment status (unpaid / partial / paid) applies only to this invoice; use Record payment on the customer for allocations.
 */
export async function saveInvoice(db, uid, payload) {
  const invoiceRef = doc(collection(db, "invoices"));
  const invoiceId = invoiceRef.id;
  const accountPeriod = resolveAccountPeriodForNewInvoice(payload);
  const cRef = invoiceCounterRef(db, uid, accountPeriod);
  const customerId = (payload.customerId || "").trim();
  const total = round2(Number(payload.total) || 0);
  const paymentMethod = String(payload.paymentMethod || "credit_sale").trim() || "credit_sale";

  return runTransaction(db, async (transaction) => {
    const custRef = customerId ? doc(db, "customers", customerId) : null;

    // All reads before any writes (Firestore transaction requirement).
    const counterSnap = await transaction.get(cRef);
    const custSnap = custRef ? await transaction.get(custRef) : null;

    let next = 1;
    if (counterSnap.exists()) {
      const v = counterSnap.data().nextNumber;
      next = typeof v === "number" && v >= 1 ? v : 1;
    }
    const invoiceNumber = formatInvoiceNumber(next, accountPeriod);

    let prev = 0;
    if (custRef && custSnap) {
      if (!custSnap.exists()) {
        throw new Error("Customer not found. Refresh and try again.");
      }
      const cd = custSnap.data();
      if (cd.userId !== uid) {
        throw new Error("Invalid customer.");
      }
      prev = round2(Number(cd.outstandingBalance) || 0);
    }

    const { amountPaidOnInvoice, normalizedStatus } = computeInvoicePaymentAmounts(
      total,
      payload.paymentStatus,
      payload.amountPaidOnInvoice,
      prev
    );

    const afterInvoice = round2(prev + total);
    const afterPayment = round2(afterInvoice - amountPaidOnInvoice);
    const snap = {
      customerId,
      paymentStatus: normalizedStatus,
      paymentMethod,
      amountPaidOnInvoice,
      previousBalanceSnapshot: prev,
      currentBalanceSnapshot: afterPayment,
    };

    const invData = {
      ...invoiceFieldsFromPayload(uid, invoiceId, invoiceNumber, payload, snap),
      accountPeriod,
      date: Timestamp.fromDate(invoiceReferenceDateFromPayload(payload)),
      /** Actual save time (distinct from `date`, which is the invoice / tax date on the document). */
      createdAt: serverTimestamp(),
    };

    transaction.set(cRef, { nextNumber: next + 1 }, { merge: true });
    transaction.set(invoiceRef, invData);

    if (customerId && custRef) {
      const txInv = doc(collection(db, "moneyTransactions"));
      transaction.set(txInv, {
        userId: uid,
        customerId,
        type: "INVOICE_TOTAL",
        amount: total,
        invoiceId,
        invoiceNumber,
        paymentStatus: normalizedStatus,
        createdAt: serverTimestamp(),
      });
      if (amountPaidOnInvoice > 0) {
        const txPay = doc(collection(db, "moneyTransactions"));
        transaction.set(txPay, {
          userId: uid,
          customerId,
          type: "PAYMENT_ON_INVOICE",
          amount: amountPaidOnInvoice,
          paymentMethod,
          invoiceId,
          invoiceNumber,
          createdAt: serverTimestamp(),
        });
      }
      transaction.update(custRef, {
        outstandingBalance: afterPayment,
        balanceUpdatedAt: serverTimestamp(),
      });
    }

    return { id: invoiceId, invoiceNumber };
  });
}

/**
 * Updates an existing invoice: reverses this invoice's prior effect on receivables, applies new totals/payment,
 * and updates customer outstandingBalance in one transaction. Appends INVOICE_ADJUSTMENT ledger rows (append-only).
 * Original `date` and `invoiceNumber` are preserved.
 */
export async function updateInvoice(db, uid, invoiceId, payload) {
  const invRef = doc(db, "invoices", invoiceId);
  const preSnap = await getDoc(invRef);
  if (!preSnap.exists()) {
    throw new Error("Invoice not found.");
  }
  const preInv = preSnap.data();
  if (preInv.userId !== uid) {
    throw new Error("Invalid invoice.");
  }
  const oldCustomerIdPre = (preInv.customerId || "").trim();
  const newCustomerIdPre = (payload.customerId || "").trim();
  if (oldCustomerIdPre) {
    await assertCustomerAccessibleForOwner(db, uid, oldCustomerIdPre);
  }
  if (newCustomerIdPre && newCustomerIdPre !== oldCustomerIdPre) {
    await assertCustomerAccessibleForOwner(db, uid, newCustomerIdPre);
  }

  const total = round2(Number(payload.total) || 0);
  const paymentMethod = String(payload.paymentMethod || "credit_sale").trim() || "credit_sale";
  const newCustomerId = (payload.customerId || "").trim();

  return runTransaction(db, async (transaction) => {
    const invSnap = await transaction.get(invRef);
    if (!invSnap.exists()) {
      throw new Error("Invoice not found.");
    }
    const oldInv = invSnap.data();
    if (oldInv.userId !== uid) {
      throw new Error("Invalid invoice.");
    }

    const oldCustomerId = (oldInv.customerId || "").trim();
    const oldTotal = round2(Number(oldInv.total) || 0);
    const oldPaid = round2(Number(oldInv.amountPaidOnInvoice) || 0);
    const oldNet = round2(oldTotal - oldPaid);
    const invoiceNumber = oldInv.invoiceNumber || "";

    const oldCustRef = oldCustomerId ? doc(db, "customers", oldCustomerId) : null;
    const newCustRef = newCustomerId ? doc(db, "customers", newCustomerId) : null;

    let oldCustSnap = null;
    let newCustSnap = null;
    if (oldCustRef && newCustRef && oldCustomerId === newCustomerId) {
      oldCustSnap = await transaction.get(oldCustRef);
      newCustSnap = oldCustSnap;
    } else {
      if (oldCustRef) oldCustSnap = await transaction.get(oldCustRef);
      if (newCustRef) newCustSnap = await transaction.get(newCustRef);
    }

    if (oldCustomerId && oldCustRef) {
      if (!oldCustSnap.exists()) {
        throw new Error("Linked customer was removed. Refresh and try again.");
      }
      if (oldCustSnap.data().userId !== uid) {
        throw new Error("Invalid customer.");
      }
    }
    if (newCustomerId && newCustRef) {
      if (!newCustSnap.exists()) {
        throw new Error("Customer not found. Refresh and try again.");
      }
      if (newCustSnap.data().userId !== uid) {
        throw new Error("Invalid customer.");
      }
    }

    let amountPaidOnInvoice = 0;
    let normalizedStatus = "unpaid";
    let prevSnap = 0;
    let currSnap = 0;

    const sameCustomer = Boolean(oldCustomerId && newCustomerId && oldCustomerId === newCustomerId);

    if (sameCustomer) {
      const b0 = round2(Number(oldCustSnap.data().outstandingBalance) || 0);
      prevSnap = round2(b0 - oldNet);
      ({ amountPaidOnInvoice, normalizedStatus } = computeInvoicePaymentAmounts(
        total,
        payload.paymentStatus,
        payload.amountPaidOnInvoice,
        prevSnap
      ));
      currSnap = round2(prevSnap + total - amountPaidOnInvoice);
      const newNet = round2(total - amountPaidOnInvoice);
      transaction.update(newCustRef, {
        outstandingBalance: currSnap,
        balanceUpdatedAt: serverTimestamp(),
      });
      const delta = round2(newNet - oldNet);
      if (delta !== 0) {
        const txAdj = doc(collection(db, "moneyTransactions"));
        transaction.set(txAdj, {
          userId: uid,
          customerId: newCustomerId,
          type: "INVOICE_ADJUSTMENT",
          receivableDelta: delta,
          invoiceId,
          invoiceNumber,
          createdAt: serverTimestamp(),
        });
      }
    } else {
      if (oldCustomerId && oldCustRef) {
        const bOld = round2(Number(oldCustSnap.data().outstandingBalance) || 0);
        const afterOld = round2(bOld - oldNet);
        transaction.update(oldCustRef, {
          outstandingBalance: afterOld,
          balanceUpdatedAt: serverTimestamp(),
        });
        if (oldNet !== 0) {
          const txOld = doc(collection(db, "moneyTransactions"));
          transaction.set(txOld, {
            userId: uid,
            customerId: oldCustomerId,
            type: "INVOICE_ADJUSTMENT",
            receivableDelta: round2(-oldNet),
            invoiceId,
            invoiceNumber,
            createdAt: serverTimestamp(),
          });
        }
      }

      if (newCustomerId && newCustRef) {
        const bNew = round2(Number(newCustSnap.data().outstandingBalance) || 0);
        prevSnap = bNew;
        ({ amountPaidOnInvoice, normalizedStatus } = computeInvoicePaymentAmounts(
          total,
          payload.paymentStatus,
          payload.amountPaidOnInvoice,
          prevSnap
        ));
        currSnap = round2(prevSnap + total - amountPaidOnInvoice);
        const newNet = round2(total - amountPaidOnInvoice);
        transaction.update(newCustRef, {
          outstandingBalance: currSnap,
          balanceUpdatedAt: serverTimestamp(),
        });
        if (newNet !== 0) {
          const txNew = doc(collection(db, "moneyTransactions"));
          transaction.set(txNew, {
            userId: uid,
            customerId: newCustomerId,
            type: "INVOICE_ADJUSTMENT",
            receivableDelta: newNet,
            invoiceId,
            invoiceNumber,
            createdAt: serverTimestamp(),
          });
        }
      } else {
        prevSnap = 0;
        ({ amountPaidOnInvoice, normalizedStatus } = computeInvoicePaymentAmounts(
          total,
          payload.paymentStatus,
          payload.amountPaidOnInvoice,
          0
        ));
        currSnap = 0;
      }
    }

    const snap = {
      customerId: newCustomerId,
      paymentStatus: normalizedStatus,
      paymentMethod,
      amountPaidOnInvoice,
      previousBalanceSnapshot: prevSnap,
      currentBalanceSnapshot: currSnap,
    };

    const preservedPeriod =
      String(oldInv.accountPeriod || "").trim() ||
      accountPeriodLabelForInvoice({ date: oldInv.date, invoiceNumber: oldInv.invoiceNumber });

    const mergeFields = {
      ...invoiceFieldsFromPayload(uid, invoiceId, invoiceNumber, payload, snap),
      accountPeriod: preservedPeriod,
      updatedAt: serverTimestamp(),
    };

    transaction.update(invRef, mergeFields);

    return { id: invoiceId, invoiceNumber };
  });
}

/**
 * Deletes only the invoice document (no customer balance or ledger updates).
 * Use when full delete fails with permission-denied (e.g. rules block moneyTransactions or bad customer userId).
 * Still writes `deletedInvoices` so the register and read-only archived view behave like a full delete.
 */
export async function deleteInvoiceDocumentOnly(db, uid, invoiceId) {
  const invRef = doc(db, "invoices", invoiceId);
  return runTransaction(db, async (transaction) => {
    const invSnap = await transaction.get(invRef);
    if (!invSnap.exists()) {
      throw new Error("Invoice not found.");
    }
    const oldInv = invSnap.data();
    if (oldInv.userId !== uid) {
      throw new Error("Invalid invoice.");
    }
    const delRef = doc(collection(db, "deletedInvoices"));
    const archivePayload = buildDeletedInvoiceArchivePayload(uid, invoiceId, oldInv);
    transaction.set(delRef, {
      ...archivePayload,
      deletedAt: serverTimestamp(),
    });
    transaction.delete(invRef);
    return { deleted: true, skippedLedger: true };
  });
}

/**
 * Deletes an invoice: writes an archive row (`deletedInvoices`), reverses customer balance when linked,
 * appends a money transaction (`INVOICE_DELETED`), then removes the invoice document.
 */
export async function deleteInvoice(db, uid, invoiceId) {
  const invRef = doc(db, "invoices", invoiceId);
  const preSnap = await getDoc(invRef);
  if (!preSnap.exists()) {
    throw new Error("Invoice not found.");
  }
  const preInv = preSnap.data();
  if (preInv.userId !== uid) {
    throw new Error("Invalid invoice.");
  }
  const preCust = (preInv.customerId || "").trim();
  if (preCust) {
    await assertCustomerAccessibleForOwner(db, uid, preCust);
  }

  return runTransaction(db, async (transaction) => {
    const invSnap = await transaction.get(invRef);
    if (!invSnap.exists()) {
      throw new Error("Invoice not found.");
    }
    const oldInv = invSnap.data();
    if (oldInv.userId !== uid) {
      throw new Error("Invalid invoice.");
    }

    const oldCustomerId = (oldInv.customerId || "").trim();
    const oldTotal = round2(Number(oldInv.total) || 0);
    const oldPaid = round2(Number(oldInv.amountPaidOnInvoice) || 0);
    const oldNet = round2(oldTotal - oldPaid);
    const invoiceNumber = oldInv.invoiceNumber || "";

    /** @type {import('firebase/firestore').DocumentReference | null} */
    let custRef = null;
    /** @type {import('firebase/firestore').DocumentSnapshot | null} */
    let custSnap = null;
    if (oldCustomerId) {
      custRef = doc(db, "customers", oldCustomerId);
      custSnap = await transaction.get(custRef);
    }

    const delRef = doc(collection(db, "deletedInvoices"));
    const archivePayload = buildDeletedInvoiceArchivePayload(uid, invoiceId, oldInv);
    transaction.set(delRef, {
      ...archivePayload,
      deletedAt: serverTimestamp(),
    });

    if (oldCustomerId && custRef && custSnap) {
      if (!custSnap.exists()) {
        transaction.delete(invRef);
        return { deleted: true };
      }
      if (custSnap.data().userId !== uid) {
        throw new Error("Invalid customer.");
      }
      const b = round2(Number(custSnap.data().outstandingBalance) || 0);
      const rawAfter = round2(b - oldNet);
      const after = rawAfter < 0 ? 0 : rawAfter;
      const receivableDelta = round2(after - b);
      transaction.update(custRef, {
        outstandingBalance: after,
        balanceUpdatedAt: serverTimestamp(),
      });
      const txDel = doc(collection(db, "moneyTransactions"));
      transaction.set(txDel, {
        userId: uid,
        customerId: oldCustomerId,
        type: "INVOICE_DELETED",
        invoiceId,
        invoiceNumber,
        receivableDelta,
        total: oldTotal,
        amountPaidOnInvoice: oldPaid,
        netReceivableRemoved: oldNet,
        reason: "invoice_deleted",
        createdAt: serverTimestamp(),
      });
    }

    transaction.delete(invRef);
    return { deleted: true };
  });
}

/** Months of invoice history included in dashboard analytics (reduces Firestore read size). History / reports use full list or range queries. */
export const DASHBOARD_INVOICE_LOOKBACK_MONTHS = 36;

export function defaultDashboardInvoiceSinceDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - DASHBOARD_INVOICE_LOOKBACK_MONTHS);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Extra fields needed to re-render the GST layout from an archive (PDF/screen). */
function invoiceRenderSnapshotFromInv(inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  return {
    items,
    sellerName: inv.sellerName ?? "",
    sellerSubtitle: inv.sellerSubtitle ?? "",
    sellerAddress: inv.sellerAddress ?? "",
    sellerPhone: inv.sellerPhone ?? "",
    sellerGstin: inv.sellerGstin ?? "",
    sellerEmail: inv.sellerEmail ?? "",
    sellerStateName: inv.sellerStateName ?? "",
    sellerStateCode: inv.sellerStateCode ?? "",
    sellerPan: inv.sellerPan ?? "",
    sellerUdyam: inv.sellerUdyam ?? "",
    sellerContactExtra: inv.sellerContactExtra ?? "",
    bankName: inv.bankName ?? "",
    bankBranch: inv.bankBranch ?? "",
    accountHolderName: inv.accountHolderName ?? "",
    bankAccount: inv.bankAccount ?? "",
    bankIfsc: inv.bankIfsc ?? "",
    invoiceTerms: inv.invoiceTerms ?? "",
    jurisdictionFooter: inv.jurisdictionFooter ?? "",
    cgstPercent: inv.cgstPercent,
    sgstPercent: inv.sgstPercent,
    supplyType: inv.supplyType === "inter" ? "inter" : inv.supplyType ? inv.supplyType : "intra",
    igstPercent: typeof inv.igstPercent === "number" && !Number.isNaN(inv.igstPercent) ? inv.igstPercent : 0,
    buyerPhone: inv.buyerPhone ?? "",
    buyerStateName: inv.buyerStateName ?? "",
    buyerStateCode: inv.buyerStateCode ?? "",
    buyerContact: inv.buyerContact ?? "",
    buyerEmail: inv.buyerEmail ?? "",
    consigneeSameAsBuyer: inv.consigneeSameAsBuyer !== false,
    referenceDate: inv.referenceDate ?? "",
    otherReferences: inv.otherReferences ?? "",
    buyerOrderNo: inv.buyerOrderNo ?? "",
    buyerOrderDate: inv.buyerOrderDate ?? "",
    dispatchDocNo: inv.dispatchDocNo ?? "",
    deliveryNoteDate: inv.deliveryNoteDate ?? "",
    termsOfDelivery: inv.termsOfDelivery ?? "",
    vesselFlightNo: inv.vesselFlightNo ?? "",
    placeReceiptShipper: inv.placeReceiptShipper ?? "",
    portLoading: inv.portLoading ?? "",
    portDischarge: inv.portDischarge ?? "",
    eInvoiceIrn: inv.eInvoiceIrn ?? "",
    eInvoiceAckNo: inv.eInvoiceAckNo ?? "",
    eInvoiceAckDate: inv.eInvoiceAckDate ?? "",
    eInvoiceQrUrl: inv.eInvoiceQrUrl ?? "",
    previousBalanceSnapshot: inv.previousBalanceSnapshot,
    currentBalanceSnapshot: inv.currentBalanceSnapshot,
    previousBalance: inv.previousBalance,
    currentBalance: inv.currentBalance,
    customerName: inv.customerName ?? "",
    consigneeName: inv.consigneeName ?? "",
    consigneeAddress: inv.consigneeAddress ?? "",
    consigneePhone: inv.consigneePhone ?? "",
    consigneeGstin: inv.consigneeGstin ?? "",
    consigneeStateName: inv.consigneeStateName ?? "",
    consigneeStateCode: inv.consigneeStateCode ?? "",
    consigneeEmail: inv.consigneeEmail ?? "",
    accountPeriod: inv.accountPeriod ?? "",
    billOfLadingDate: inv.billOfLadingDate ?? "",
  };
}

/**
 * Builds a Firestore payload for `deletedInvoices` (full register snapshot at delete time).
 * @param {string} uid
 * @param {string} invoiceId
 * @param {object} inv raw invoice fields from `invSnap.data()`
 */
export function buildDeletedInvoiceArchivePayload(uid, invoiceId, inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  const hsnBlob = items
    .map((it) => [it.hsn, it.name].filter(Boolean).join(" "))
    .join(" ");
  const itemsSummary = items
    .filter((it) => (it.name || "").trim())
    .slice(0, 8)
    .map((it) => `${String(it.name || "").trim()} × ${it.quantity ?? "—"}`)
    .join("; ")
    .slice(0, 480);
  const total = typeof inv.total === "number" && !Number.isNaN(inv.total) ? inv.total : 0;
  const subtotal = typeof inv.subtotal === "number" && !Number.isNaN(inv.subtotal) ? inv.subtotal : 0;
  return {
    userId: uid,
    originalInvoiceId: invoiceId,
    invoiceNumber: inv.invoiceNumber || "",
    customerName: inv.customerName || "",
    consigneeName: inv.consigneeName || "",
    total,
    subtotal,
    cgst: typeof inv.cgst === "number" && !Number.isNaN(inv.cgst) ? inv.cgst : 0,
    sgst: typeof inv.sgst === "number" && !Number.isNaN(inv.sgst) ? inv.sgst : 0,
    igst: typeof inv.igst === "number" && !Number.isNaN(inv.igst) ? inv.igst : 0,
    amountPaidOnInvoice:
      typeof inv.amountPaidOnInvoice === "number" && !Number.isNaN(inv.amountPaidOnInvoice)
        ? inv.amountPaidOnInvoice
        : 0,
    // Always persist a Timestamp so register queries/sorts never see a missing `date`
    date:
      inv.date != null
        ? inv.date
        : Timestamp.fromMillis(Date.now()),
    buyerGstin: inv.buyerGstin || "",
    buyerPan: inv.buyerPan || "",
    placeOfSupply: inv.placeOfSupply || "",
    buyerAddress: inv.buyerAddress || "",
    destination: inv.destination || "",
    dispatchedThrough: inv.dispatchedThrough || "",
    motorVehicleNo: inv.motorVehicleNo || "",
    ewayBillNo: inv.ewayBillNo || "",
    billOfLadingNo: inv.billOfLadingNo || "",
    sellerGstin: inv.sellerGstin || "",
    sellerPan: inv.sellerPan || "",
    referenceNo: inv.referenceNo || "",
    deliveryNote: inv.deliveryNote || "",
    paymentTerms: inv.paymentTerms || "",
    hsnSearchBlob: hsnBlob,
    itemsSummary,
    paymentStatus: inv.paymentStatus || "",
    paymentMethod: inv.paymentMethod || "",
    customerId: inv.customerId || "",
    supplyType: inv.supplyType || "",
    accountPeriod: inv.accountPeriod || "",
    accountPeriodLabel: accountPeriodLabelForInvoice({
      date: inv.date,
      accountPeriod: inv.accountPeriod,
      invoiceNumber: inv.invoiceNumber,
    }),
    ...invoiceRenderSnapshotFromInv(inv),
  };
}

/** Shape expected by `renderInvoiceDocument` from a `deletedInvoices` document. */
export function invoiceViewModelFromDeletedArchive(arch) {
  if (!arch) return null;
  const { deletedAt: _del, ...rest } = arch;
  return {
    ...rest,
    id: rest.originalInvoiceId || rest.id,
  };
}

export async function getDeletedInvoiceArchiveById(db, uid, archiveId) {
  const ref = doc(db, "deletedInvoices", archiveId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data();
  if (data.userId !== uid) return null;
  return { id: snap.id, ...data };
}

/** Maps a deleted-invoice archive doc to the same list row shape as live invoices + `isDeleted` / `deletedAt`. */
export function mapDeletedInvoiceDocSnapshot(d) {
  const x = d.data();
  const items = Array.isArray(x.items) ? x.items : [];
  const hsnBlob =
    (x.hsnSearchBlob && String(x.hsnSearchBlob)) ||
    items
      .map((it) => [it.hsn, it.name].filter(Boolean).join(" "))
      .join(" ");
  return {
    id: d.id,
    originalInvoiceId: x.originalInvoiceId || "",
    isDeleted: true,
    invoiceNumber: x.invoiceNumber || "",
    customerName: x.customerName || "",
    consigneeName: x.consigneeName || "",
    total: typeof x.total === "number" && !Number.isNaN(x.total) ? x.total : 0,
    subtotal: typeof x.subtotal === "number" && !Number.isNaN(x.subtotal) ? x.subtotal : 0,
    cgst: typeof x.cgst === "number" && !Number.isNaN(x.cgst) ? x.cgst : 0,
    sgst: typeof x.sgst === "number" && !Number.isNaN(x.sgst) ? x.sgst : 0,
    igst: typeof x.igst === "number" && !Number.isNaN(x.igst) ? x.igst : 0,
    amountPaidOnInvoice:
      typeof x.amountPaidOnInvoice === "number" && !Number.isNaN(x.amountPaidOnInvoice)
        ? x.amountPaidOnInvoice
        : 0,
    date: x.date,
    deletedAt: x.deletedAt,
    itemsSummary: x.itemsSummary || "",
    buyerGstin: x.buyerGstin || "",
    buyerPan: x.buyerPan || "",
    placeOfSupply: x.placeOfSupply || "",
    buyerAddress: x.buyerAddress || "",
    destination: x.destination || "",
    dispatchedThrough: x.dispatchedThrough || "",
    motorVehicleNo: x.motorVehicleNo || "",
    ewayBillNo: x.ewayBillNo || "",
    billOfLadingNo: x.billOfLadingNo || "",
    sellerGstin: x.sellerGstin || "",
    sellerPan: x.sellerPan || "",
    referenceNo: x.referenceNo || "",
    deliveryNote: x.deliveryNote || "",
    paymentTerms: x.paymentTerms || "",
    hsnSearchBlob: hsnBlob,
    paymentStatus: x.paymentStatus || "",
    paymentMethod: x.paymentMethod || "",
    customerId: x.customerId || "",
    supplyType: x.supplyType || "",
    accountPeriod: x.accountPeriod || "",
    accountPeriodLabel: x.accountPeriodLabel || "",
  };
}

/** Maps a Firestore invoice document to the list row shape (history, dashboard, customers). */
export function mapInvoiceDocSnapshot(d) {
  const x = d.data();
  const items = Array.isArray(x.items) ? x.items : [];
  const itemsSummary = items
    .filter((it) => (it.name || "").trim())
    .slice(0, 8)
    .map((it) => `${String(it.name || "").trim()} × ${it.quantity ?? "—"}`)
    .join("; ")
    .slice(0, 480);
  const hsnBlob = items
    .map((it) => [it.hsn, it.name].filter(Boolean).join(" "))
    .join(" ");
  return {
    id: d.id,
    invoiceNumber: x.invoiceNumber || "",
    customerName: x.customerName || "",
    consigneeName: x.consigneeName || "",
    total: typeof x.total === "number" && !Number.isNaN(x.total) ? x.total : 0,
    subtotal: typeof x.subtotal === "number" && !Number.isNaN(x.subtotal) ? x.subtotal : 0,
    cgst: typeof x.cgst === "number" && !Number.isNaN(x.cgst) ? x.cgst : 0,
    sgst: typeof x.sgst === "number" && !Number.isNaN(x.sgst) ? x.sgst : 0,
    igst: typeof x.igst === "number" && !Number.isNaN(x.igst) ? x.igst : 0,
    amountPaidOnInvoice:
      typeof x.amountPaidOnInvoice === "number" && !Number.isNaN(x.amountPaidOnInvoice)
        ? x.amountPaidOnInvoice
        : 0,
    date: x.date,
    buyerGstin: x.buyerGstin || "",
    buyerPan: x.buyerPan || "",
    placeOfSupply: x.placeOfSupply || "",
    buyerAddress: x.buyerAddress || "",
    destination: x.destination || "",
    dispatchedThrough: x.dispatchedThrough || "",
    motorVehicleNo: x.motorVehicleNo || "",
    ewayBillNo: x.ewayBillNo || "",
    billOfLadingNo: x.billOfLadingNo || "",
    sellerGstin: x.sellerGstin || "",
    sellerPan: x.sellerPan || "",
    referenceNo: x.referenceNo || "",
    deliveryNote: x.deliveryNote || "",
    paymentTerms: x.paymentTerms || "",
    hsnSearchBlob: hsnBlob,
    itemsSummary,
    paymentStatus: x.paymentStatus || "",
    paymentMethod: x.paymentMethod || "",
    customerId: x.customerId || "",
    supplyType: x.supplyType || "",
    accountPeriod: x.accountPeriod || "",
    accountPeriodLabel: accountPeriodLabelForInvoice({
      date: x.date,
      accountPeriod: x.accountPeriod,
      invoiceNumber: x.invoiceNumber,
    }),
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
  };
}

/** One row for history list + client-side filters (all fields optional for filtering). */
export async function listInvoicesForUser(db, uid) {
  const q = query(
    collection(db, "invoices"),
    where("userId", "==", uid),
    orderBy("date", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(mapInvoiceDocSnapshot);
}

function millisFromFirestoreDateField(v) {
  if (!v) return 0;
  if (typeof v.toDate === "function") {
    const d = v.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  }
  return 0;
}

/** Sort key: invoice date first, then deleted time (newest first). */
function deletedArchiveSortMillis(row) {
  const byInv = millisFromFirestoreDateField(row.date);
  if (byInv) return byInv;
  return millisFromFirestoreDateField(row.deletedAt);
}

/**
 * Archived invoice rows (deleted). Uses only `userId` equality (no composite index).
 * Sorted client-side so the list works even if indexes are not deployed yet.
 */
export async function listDeletedInvoicesForUser(db, uid) {
  const q = query(collection(db, "deletedInvoices"), where("userId", "==", uid));
  const snap = await getDocs(q);
  const rows = snap.docs.map(mapDeletedInvoiceDocSnapshot);
  rows.sort((a, b) => deletedArchiveSortMillis(b) - deletedArchiveSortMillis(a));
  return rows;
}

/**
 * Invoices with `date` on or after `sinceDate` (dashboard KPIs / charts). Uses composite index userId + date.
 * Customer **outstanding** in `computeAnalytics` still uses full `customers` collection.
 */
export async function listInvoicesForUserSince(db, uid, sinceDate) {
  const since = sinceDate instanceof Date ? sinceDate : new Date(sinceDate);
  const q = query(
    collection(db, "invoices"),
    where("userId", "==", uid),
    where("date", ">=", Timestamp.fromDate(since)),
    orderBy("date", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(mapInvoiceDocSnapshot);
}

export async function getInvoiceById(db, id) {
  const ref = doc(db, "invoices", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export function formatInvoiceDate(date) {
  if (!date) return "—";
  const d = date instanceof Timestamp ? date.toDate() : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Date + time when the invoice was saved (Firestore `date` field). */
export function formatInvoiceDateTime(date) {
  if (!date) return "—";
  const d = date instanceof Timestamp ? date.toDate() : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch (_) {
    return d.toLocaleString("en-IN");
  }
}

export function formatInvoiceDateNumeric(date) {
  if (!date) return "—";
  const d = date instanceof Timestamp ? date.toDate() : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Tally-style display on printed invoice (e.g. 14-03-2026). */
export function formatInvoiceDateDashed(date) {
  if (!date) return "—";
  const d = date instanceof Timestamp ? date.toDate() : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}
