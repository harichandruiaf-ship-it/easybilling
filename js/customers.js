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

/**
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} uid
 */
export async function listCustomers(db, uid) {
  const q = query(collection(db, "customers"), where("userId", "==", uid));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
  return rows;
}

/**
 * @returns {Promise<string>} new doc id
 */
export async function addCustomer(db, uid, data) {
  const ref = await addDoc(collection(db, "customers"), {
    userId: uid,
    name: data.name.trim(),
    address: data.address.trim(),
    phone: data.phone.trim(),
    gstin: (data.gstin || "").trim().toUpperCase(),
    stateName: (data.stateName || "").trim(),
    stateCode: (data.stateCode || "").trim(),
    buyerPan: (data.buyerPan || "").trim().toUpperCase(),
    placeOfSupply: (data.placeOfSupply || "").trim(),
    buyerContact: (data.buyerContact || "").trim(),
    buyerEmail: (data.buyerEmail || "").trim(),
    consigneeAddress: (data.consigneeAddress || "").trim(),
    consigneeName: (data.consigneeName || "").trim(),
    consigneeGstin: (data.consigneeGstin || "").trim().toUpperCase(),
    consigneeStateName: (data.consigneeStateName || "").trim(),
    consigneeStateCode: (data.consigneeStateCode || "").trim(),
    consigneePhone: (data.consigneePhone || "").trim(),
    consigneeEmail: (data.consigneeEmail || "").trim(),
    consigneeSameAsBuyer: Boolean(data.consigneeSameAsBuyer),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateCustomer(db, customerId, data) {
  const ref = doc(db, "customers", customerId);
  await updateDoc(ref, {
    name: data.name.trim(),
    address: data.address.trim(),
    phone: data.phone.trim(),
    gstin: (data.gstin || "").trim().toUpperCase(),
    stateName: (data.stateName || "").trim(),
    stateCode: (data.stateCode || "").trim(),
    buyerPan: (data.buyerPan || "").trim().toUpperCase(),
    placeOfSupply: (data.placeOfSupply || "").trim(),
    buyerContact: (data.buyerContact || "").trim(),
    buyerEmail: (data.buyerEmail || "").trim(),
    consigneeAddress: (data.consigneeAddress || "").trim(),
    consigneeName: (data.consigneeName || "").trim(),
    consigneeGstin: (data.consigneeGstin || "").trim().toUpperCase(),
    consigneeStateName: (data.consigneeStateName || "").trim(),
    consigneeStateCode: (data.consigneeStateCode || "").trim(),
    consigneePhone: (data.consigneePhone || "").trim(),
    consigneeEmail: (data.consigneeEmail || "").trim(),
    consigneeSameAsBuyer: Boolean(data.consigneeSameAsBuyer),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteCustomer(db, customerId) {
  await deleteDoc(doc(db, "customers", customerId));
}

export async function getCustomerById(db, id) {
  const snap = await getDoc(doc(db, "customers", id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}
