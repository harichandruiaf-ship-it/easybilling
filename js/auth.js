import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updateProfile,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
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

export async function signUpUser(email, password, profile = {}) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await ensureUserDoc(cred.user.uid, cred.user.email, profile);
  return cred.user;
}

export async function signInUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export function signOutUser() {
  return signOut(auth);
}

export async function sendPasswordResetToEmail(email) {
  await sendPasswordResetEmail(auth, email);
}

/** True if the signed-in user can change password via re-auth (email/password provider). */
export function userSupportsPasswordChange() {
  const u = auth?.currentUser;
  if (!u || !u.email) return false;
  return u.providerData.some((p) => p.providerId === "password");
}

/**
 * Updates Firebase Auth display name and `users/{uid}.fullName` (merge).
 * @param {string} uid
 * @param {string} fullName
 */
export async function updateUserFullName(uid, fullName) {
  const name = String(fullName || "").trim();
  const ref = doc(db, "users", uid);
  await setDoc(ref, { fullName: name, updatedAt: serverTimestamp() }, { merge: true });
  const u = auth.currentUser;
  if (u && u.uid === uid) {
    await updateProfile(u, { displayName: name });
  }
}

/**
 * @param {string} currentPassword
 * @param {string} newPassword
 */
export async function changePasswordWithReauth(currentPassword, newPassword) {
  const u = auth.currentUser;
  if (!u?.email) throw new Error("Not signed in.");
  const cred = EmailAuthProvider.credential(u.email, currentPassword);
  await reauthenticateWithCredential(u, cred);
  await updatePassword(u, newPassword);
}

export function onUserChanged(cb) {
  return onAuthStateChanged(auth, cb);
}

const defaultSeller = {
  fullName: "",
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

export async function ensureUserDoc(uid, email, profile = {}) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  const p = profile || {};
  const fullName = String(p.fullName || "").trim();
  const sellerEmail = String(p.sellerEmail || email || "").trim();
  await setDoc(ref, {
    email: email || "",
    ...defaultSeller,
    fullName,
    sellerEmail,
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
    fullName: d.fullName || "",
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
