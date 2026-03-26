/**
 * Wipe Firestore test data for Easy Billing (invoices, customers, ledger, invoice counter).
 *
 * Why a script: app security rules do not allow deleting `moneyTransactions` from the browser.
 *
 * Setup:
 *   1. Firebase Console → Project settings → Service accounts → Generate new private key → save JSON (never commit it).
 *   2. In this folder: npm install
 *   3. Run (from scripts/), either:
 *        node clear-firestore-test-data.mjs "C:\path\to\serviceAccount.json" --yes
 *   Or set GOOGLE_APPLICATION_CREDENTIALS to that file path, then:
 *        node clear-firestore-test-data.mjs --yes
 *
 * Without --yes, the script exits (safety).
 */

import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const args = process.argv.slice(2).filter((a) => a !== "--yes");
const confirmed = process.argv.includes("--yes");
const saPath = args[0] || process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!confirmed) {
  console.error(`
Usage:
  node clear-firestore-test-data.mjs <path-to-service-account.json> --yes
  node clear-firestore-test-data.mjs --yes
    (second form uses env var GOOGLE_APPLICATION_CREDENTIALS)

This DELETES every document in:
  - invoices
  - customers
  - moneyTransactions

And resets users/{uid}/meta/invoiceCounter to { nextNumber: 1 } for each user.

Seller settings in users/{uid} are NOT deleted.
`);
  process.exit(1);
}

if (!saPath) {
  console.error("Missing service account path: pass it as the first argument or set GOOGLE_APPLICATION_CREDENTIALS.");
  process.exit(1);
}

const sa = JSON.parse(readFileSync(saPath, "utf8"));
admin.initializeApp({
  credential: admin.credential.cert(sa),
});

const db = admin.firestore();

async function deleteCollectionInBatches(collectionName) {
  const ref = db.collection(collectionName);
  let total = 0;
  while (true) {
    const snap = await ref.limit(500).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const d of snap.docs) {
      batch.delete(d.ref);
    }
    await batch.commit();
    total += snap.size;
    console.log(`  ${collectionName}: deleted ${snap.size} (running total ${total})`);
  }
  if (total === 0) {
    console.log(`  ${collectionName}: (empty)`);
  }
}

async function resetInvoiceCounters() {
  const usersSnap = await db.collection("users").get();
  for (const userDoc of usersSnap.docs) {
    const counterRef = userDoc.ref.collection("meta").doc("invoiceCounter");
    const c = await counterRef.get();
    if (c.exists) {
      await counterRef.set({ nextNumber: 1 });
      console.log(`  Reset invoice counter for user ${userDoc.id}`);
    }
  }
}

async function main() {
  console.log("Deleting collections…");
  await deleteCollectionInBatches("invoices");
  await deleteCollectionInBatches("customers");
  await deleteCollectionInBatches("moneyTransactions");
  console.log("Resetting invoice counters…");
  await resetInvoiceCounters();
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
