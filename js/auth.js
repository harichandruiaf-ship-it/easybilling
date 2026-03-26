import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

let auth;
let db;

export function initAuthServices(app) {
  auth = getAuth(app);
  db = getFirestore(app);
  return { auth, db };
}

export function getAuthInstance() {
  return auth;
}

export function getDb() {
  return db;
}

export async function signUpUser(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await ensureUserDoc(cred.user.uid, cred.user.email);
  return cred.user;
}

export async function signInUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export function signOutUser() {
  return signOut(auth);
}

export function onUserChanged(cb) {
  return onAuthStateChanged(auth, cb);
}

const defaultSeller = {
  sellerName: "",
  sellerSubtitle: "",
  sellerAddress: "",
  sellerPhone: "",
  sellerGstin: "",
  sellerEmail: "",
  sellerStateName: "",
  sellerStateCode: "",
  sellerPan: "",
  sellerUdyam: "",
  sellerContactExtra: "",
  bankName: "",
  bankBranch: "",
  accountHolderName: "",
  bankAccount: "",
  bankIfsc: "",
  cgstPercent: 2.5,
  sgstPercent: 2.5,
  invoiceTerms: "",
  jurisdictionFooter: "",
};

export async function ensureUserDoc(uid, email) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    email: email || "",
    ...defaultSeller,
    createdAt: serverTimestamp(),
  });
}

export async function loadUserSettings(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ...defaultSeller, email: "" };
  const d = snap.data();
  return {
    email: d.email || "",
    sellerName: d.sellerName || "",
    sellerSubtitle: d.sellerSubtitle || "",
    sellerAddress: d.sellerAddress || "",
    sellerPhone: d.sellerPhone || "",
    sellerGstin: d.sellerGstin || "",
    sellerEmail: d.sellerEmail || "",
    sellerStateName: d.sellerStateName || "",
    sellerStateCode: d.sellerStateCode || "",
    sellerPan: d.sellerPan || "",
    sellerUdyam: d.sellerUdyam || "",
    sellerContactExtra: d.sellerContactExtra || "",
    bankName: d.bankName || "",
    bankBranch: d.bankBranch || "",
    accountHolderName: d.accountHolderName || "",
    bankAccount: d.bankAccount || "",
    bankIfsc: d.bankIfsc || "",
    cgstPercent: typeof d.cgstPercent === "number" ? d.cgstPercent : 2.5,
    sgstPercent: typeof d.sgstPercent === "number" ? d.sgstPercent : 2.5,
    invoiceTerms: d.invoiceTerms || "",
    jurisdictionFooter: d.jurisdictionFooter || "",
  };
}

export async function saveUserSettings(uid, settings) {
  const ref = doc(db, "users", uid);
  await setDoc(
    ref,
    {
      sellerName: settings.sellerName,
      sellerSubtitle: settings.sellerSubtitle || "",
      sellerAddress: settings.sellerAddress,
      sellerPhone: settings.sellerPhone,
      sellerGstin: settings.sellerGstin || "",
      sellerEmail: settings.sellerEmail || "",
      sellerStateName: settings.sellerStateName || "",
      sellerStateCode: settings.sellerStateCode || "",
      sellerPan: settings.sellerPan || "",
      sellerUdyam: settings.sellerUdyam || "",
      sellerContactExtra: settings.sellerContactExtra || "",
      bankName: settings.bankName || "",
      bankBranch: settings.bankBranch || "",
      accountHolderName: settings.accountHolderName || "",
      bankAccount: settings.bankAccount || "",
      bankIfsc: settings.bankIfsc || "",
      cgstPercent: Number(settings.cgstPercent) || 0,
      sgstPercent: Number(settings.sgstPercent) || 0,
      invoiceTerms: settings.invoiceTerms || "",
      jurisdictionFooter: settings.jurisdictionFooter || "",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}
