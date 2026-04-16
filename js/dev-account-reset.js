/**
 * Dev-only: wipe transactional data for the signed-in user while keeping seller profile (users/{uid}).
 *
 * Toggle `DEV_ACCOUNT_RESET_ENABLED` to `false` and remove UI wiring from `app.js` before production.
 * Requires Firestore rules that allow the owner to delete their own `moneyTransactions` and `deletedInvoices`
 * (see `firestore.rules` in this repo).
 */
import {
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  doc,
  serverTimestamp,
} from "firebase/firestore";
import { round2 } from "./invoices.js";
import { withLoading } from "./loading.js";
import { showToast } from "./toast.js";

/** Set to `true` only in local/dev. Must be `false` for production builds. */
export const DEV_ACCOUNT_RESET_ENABLED = true;

const BATCH_SIZE = 450;

async function commitDeletes(db, refs) {
  let n = 0;
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const r of refs.slice(i, i + BATCH_SIZE)) {
      batch.delete(r);
      n += 1;
    }
    await batch.commit();
  }
  return n;
}

async function collectRefs(db, collName, uid) {
  const q = query(collection(db, collName), where("userId", "==", uid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => doc(db, collName, d.id));
}

/**
 * Deletes all invoices, ledger rows, deleted-invoice archives, quick orders, and invoice counter meta.
 * Keeps `users/{uid}` seller fields unchanged.
 * Customers: removes anyone with non-zero outstanding; zeros balance on the rest.
 */
export async function runDevAccountReset(db, uid) {
  if (!uid) throw new Error("Not signed in.");

  const counts = {
    invoices: 0,
    moneyTransactions: 0,
    deletedInvoices: 0,
    quickOrders: 0,
    metaDocs: 0,
    customersRemoved: 0,
    customersKeptZeroed: 0,
  };

  const invRefs = await collectRefs(db, "invoices", uid);
  counts.invoices = await commitDeletes(db, invRefs);

  const txRefs = await collectRefs(db, "moneyTransactions", uid);
  counts.moneyTransactions = await commitDeletes(db, txRefs);

  const delRefs = await collectRefs(db, "deletedInvoices", uid);
  counts.deletedInvoices = await commitDeletes(db, delRefs);

  const qoRefs = await collectRefs(db, "quickOrders", uid);
  counts.quickOrders = await commitDeletes(db, qoRefs);

  const metaCol = collection(db, "users", uid, "meta");
  const metaSnap = await getDocs(metaCol);
  const metaRefs = metaSnap.docs.map((d) => doc(db, "users", uid, "meta", d.id));
  counts.metaDocs = await commitDeletes(db, metaRefs);

  const custQ = query(collection(db, "customers"), where("userId", "==", uid));
  const custSnap = await getDocs(custQ);
  const toDelete = [];
  const toZero = [];
  for (const d of custSnap.docs) {
    const ob = round2(Number(d.data().outstandingBalance) || 0);
    if (Math.abs(ob) > 0.005) {
      toDelete.push(d.ref);
    } else {
      toZero.push(d.ref);
    }
  }

  counts.customersRemoved = await commitDeletes(db, toDelete);

  for (let i = 0; i < toZero.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const r of toZero.slice(i, i + BATCH_SIZE)) {
      batch.update(r, {
        outstandingBalance: 0,
        balanceUpdatedAt: serverTimestamp(),
      });
      counts.customersKeptZeroed += 1;
    }
    await batch.commit();
  }

  return counts;
}

/**
 * Wires the settings-page panel (must exist in DOM). No-op if disabled.
 * @param {{ db: import('firebase/firestore').Firestore, getUid: () => string | undefined, onAfterReset?: () => void }} opts
 */
export function setupDevAccountResetUI({ db, getUid, onAfterReset }) {
  if (!DEV_ACCOUNT_RESET_ENABLED) return;

  const panel = document.getElementById("settings-dev-reset-panel");
  const btn = document.getElementById("btn-dev-account-reset");
  if (!panel || !btn) return;

  panel.classList.remove("hidden");
  panel.setAttribute("aria-hidden", "false");
  btn.addEventListener("click", async () => {
    const uid = getUid?.();
    if (!uid) return;

    const ok = window.confirm(
      "DEV ONLY: This will permanently delete all invoices, payment ledger entries, deleted-invoice archives, quick orders, and invoice number counters for this account.\n\n" +
        "Seller (business) settings are kept.\n\n" +
        "Customers with any non-zero outstanding balance will be removed. Other customers are kept with balance set to ₹0.\n\n" +
        "Continue?"
    );
    if (!ok) return;

    const ok2 = window.confirm("This cannot be undone. Delete all transactional data now?");
    if (!ok2) return;

    try {
      const counts = await withLoading(() => runDevAccountReset(db, uid), "Resetting account data…");
      const msg = [
        `Invoices ${counts.invoices}`,
        `ledger ${counts.moneyTransactions}`,
        `archives ${counts.deletedInvoices}`,
        `quick orders ${counts.quickOrders}`,
        `meta ${counts.metaDocs}`,
        `customers removed ${counts.customersRemoved}`,
        `customers kept (₹0) ${counts.customersKeptZeroed}`,
      ].join(" · ");
      showToast(`Dev reset complete: ${msg}`, { type: "success" });
      onAfterReset?.();
    } catch (e) {
      const m =
        e?.code === "permission-denied"
          ? "Permission denied. Deploy Firestore rules that allow deleting your own moneyTransactions and deletedInvoices (see dev-account-reset.js / firestore.rules)."
          : e?.message || "Reset failed.";
      showToast(m, { type: "error" });
    }
  });
}
