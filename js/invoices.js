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
  setDoc,
  Timestamp,
} from "firebase/firestore";

export function computeTotals(subtotal, cgstPercent, sgstPercent) {
  const s = round2(subtotal);
  const cgstR = (Number(cgstPercent) || 0) / 100;
  const sgstR = (Number(sgstPercent) || 0) / 100;
  const cgst = round2(s * cgstR);
  const sgst = round2(s * sgstR);
  const total = round2(s + cgst + sgst);
  return { subtotal: s, cgst, sgst, total, cgstPercent: Number(cgstPercent) || 0, sgstPercent: Number(sgstPercent) || 0 };
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function counterRef(db, uid) {
  return doc(db, "users", uid, "meta", "invoiceCounter");
}

function formatInvoiceNumber(seq) {
  return `INV-${String(seq).padStart(4, "0")}`;
}

export async function allocateInvoiceNumber(db, uid) {
  const cRef = counterRef(db, uid);
  const seq = await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(cRef);
    let next = 1;
    if (snap.exists()) {
      const v = snap.data().nextNumber;
      next = typeof v === "number" && v >= 1 ? v : 1;
    }
    transaction.set(cRef, { nextNumber: next + 1 }, { merge: true });
    return next;
  });
  return formatInvoiceNumber(seq);
}

export async function saveInvoice(db, uid, payload) {
  const invoiceNumber = await allocateInvoiceNumber(db, uid);
  const newRef = doc(collection(db, "invoices"));
  await setDoc(newRef, {
    invoiceId: newRef.id,
    userId: uid,
    invoiceNumber,
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
    previousBalance:
      typeof payload.previousBalance === "number" && !Number.isNaN(payload.previousBalance)
        ? payload.previousBalance
        : null,
    currentBalance:
      typeof payload.currentBalance === "number" && !Number.isNaN(payload.currentBalance)
        ? payload.currentBalance
        : null,
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
    items: payload.items,
    subtotal: payload.subtotal,
    cgst: payload.cgst,
    sgst: payload.sgst,
    total: payload.total,
    date: serverTimestamp(),
  });
  return { id: newRef.id, invoiceNumber };
}

export async function listInvoicesForUser(db, uid) {
  const q = query(
    collection(db, "invoices"),
    where("userId", "==", uid),
    orderBy("date", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      invoiceNumber: x.invoiceNumber,
      customerName: x.customerName,
      total: x.total,
      date: x.date,
    };
  });
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

export function formatInvoiceDateNumeric(date) {
  if (!date) return "—";
  const d = date instanceof Timestamp ? date.toDate() : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
