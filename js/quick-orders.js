import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";

/** @typedef {{ productName?: string, quantity?: number|string, unit?: string }} QuickOrderLine */

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} uid
 * @returns {Promise<Array<{ id: string } & Record<string, unknown>>>}
 */
export async function listQuickOrdersForUser(db, uid) {
  const q = query(collection(db, "quickOrders"), where("userId", "==", uid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Open items only, sorted by send date then created.
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} uid
 */
export async function listOpenQuickOrders(db, uid) {
  const rows = await listQuickOrdersForUser(db, uid);
  const open = rows.filter((r) => (r.status || "open") === "open");
  open.sort((a, b) => {
    const sd = String(a.sendDate || "").localeCompare(String(b.sendDate || ""));
    if (sd !== 0) return sd;
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return tb - ta;
  });
  return open;
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} id
 */
export async function getQuickOrderById(db, id) {
  const snap = await getDoc(doc(db, "quickOrders", id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} uid
 * @param {{
 *   customerName: string,
 *   customerPhone?: string,
 *   sendDate?: string,
 *   lines: QuickOrderLine[],
 *   memo?: string,
 * }} data
 */
export async function addQuickOrder(db, uid, data) {
  const lines = normalizeLines(data.lines);
  const ref = await addDoc(collection(db, "quickOrders"), {
    userId: uid,
    customerName: (data.customerName || "").trim(),
    customerPhone: (data.customerPhone || "").trim(),
    sendDate: (data.sendDate || "").trim(),
    lines,
    memo: (data.memo || "").trim(),
    status: "open",
    linkedInvoiceId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} orderId
 * @param {string} uid
 * @param {{
 *   customerName: string,
 *   customerPhone?: string,
 *   sendDate?: string,
 *   lines: QuickOrderLine[],
 *   memo?: string,
 * }} data
 */
export async function updateQuickOrder(db, orderId, uid, data) {
  const ref = doc(db, "quickOrders", orderId);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().userId !== uid) throw new Error("NOT_FOUND");
  const lines = normalizeLines(data.lines);
  await updateDoc(ref, {
    customerName: (data.customerName || "").trim(),
    customerPhone: (data.customerPhone || "").trim(),
    sendDate: (data.sendDate || "").trim(),
    lines,
    memo: (data.memo || "").trim(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} orderId
 * @param {string} uid
 */
export async function deleteQuickOrder(db, orderId, uid) {
  const ref = doc(db, "quickOrders", orderId);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().userId !== uid) throw new Error("NOT_FOUND");
  await deleteDoc(ref);
}

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} orderId
 * @param {string} uid
 * @param {string} [invoiceId]
 */
export async function markQuickOrderDone(db, orderId, uid, invoiceId = "") {
  const ref = doc(db, "quickOrders", orderId);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().userId !== uid) throw new Error("NOT_FOUND");
  await updateDoc(ref, {
    status: "done",
    linkedInvoiceId: invoiceId || null,
    updatedAt: serverTimestamp(),
  });
}

/** @param {QuickOrderLine[]|unknown} lines */
function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [{ productName: "", quantity: 1, unit: "Pcs" }];
  const out = lines
    .map((row) => ({
      productName: String(row?.productName ?? "").trim(),
      quantity: Math.max(0.001, Number(row?.quantity) || 1),
      unit: String(row?.unit ?? "Pcs").trim() || "Pcs",
    }))
    .filter((r) => r.productName.length > 0);
  return out.length ? out : [{ productName: "Item", quantity: 1, unit: "Pcs" }];
}
