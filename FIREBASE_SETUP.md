# Easy Billing — Firebase and run guide

This app uses **Firebase Authentication (Email/Password)** and **Cloud Firestore**. It must be opened over **http://localhost** or **https://** (not `file://`) so Firebase and the PWA service worker work correctly.

## Run on your PC (localhost)

**You do not need Python.** `START.bat` runs a small static file server using **PowerShell** (included with Windows).

1. Double‑click **`START.bat`** in the project folder.  
   - A **blue PowerShell** window stays open — **leave it open** while you use the app.  
   - Your browser should open **`http://127.0.0.1:8080/`**. If not, type that URL (same as `http://localhost:8080/`).
2. **Stop the server** (use whichever works):  
   - **Easiest:** double‑click **`STOP.bat`** in the project folder (ends the process on port 8080).  
   - Or click the **PowerShell** window and press **Ctrl+C** (sometimes twice).  
   - Or run: `powershell -ExecutionPolicy Bypass -File .\stop-server.ps1`  
   If you changed the port in **`start-no-python.ps1`**, set the same port in **`STOP.bat`** (and in **`stop-server.ps1`**).
3. If **`START.bat` is blocked** or PowerShell won’t run scripts: right‑click **`start-no-python.ps1`** → **Run with PowerShell**, or run:  
   `powershell -ExecutionPolicy Bypass -File .\start-no-python.ps1`
4. If port **8080** is busy, edit **`start-no-python.ps1`** and change the line `$port = 8080` to another port (e.g. `8081`), then open **`http://127.0.0.1:8081/`**.
5. **Optional — Python instead:** double‑click **`START-python.bat`** (requires Python 3 on PATH).
6. If HttpListener fails with a permission error, run PowerShell **as Administrator** once, or try another port.

## 1. Create a Firebase project

1. Go to [Firebase Console](https://console.firebase.google.com/) and click **Add project**.
2. Follow the wizard (Google Analytics optional).

## 2. Enable Authentication

1. In the project, open **Build → Authentication**.
2. Click **Get started**.
3. Under **Sign-in method**, enable **Email/Password**.

## 3. Create a Firestore database

1. Open **Build → Firestore Database**.
2. Click **Create database**.
3. Choose **Start in production mode** (you will replace rules below) or **test mode** for quick local tests only.
4. Pick a location close to your users.

## 4. Register a web app and copy config

1. Open **Project settings** (gear icon) → **Your apps** → **Web** (`</>`).
2. Register the app and copy the `firebaseConfig` object.
3. Paste the values into [`firebase-config.js`](firebase-config.js) (replace every `YOUR_*` placeholder).

## 5. Authorized domains

1. In **Authentication → Settings → Authorized domains**, ensure **localhost** is listed (it usually is by default).
2. If you deploy to Firebase Hosting or another domain, add that domain here.

## 6. Firestore security rules

**If you see “Missing or insufficient permissions” or “Firestore blocked this (permission denied)”** when saving settings, invoices, payments, or deleting an invoice, your rules are still the default (everything blocked) or not published for **this** project (`firebase-config.js` → `projectId`).

Do this:

1. Open the **Rules** tab for **Cloud Firestore** (not Realtime Database). Fast link (replace if your project id differs):  
   `https://console.firebase.google.com/project/<your-project-id>/firestore/rules`
2. Replace the entire editor contents with [`firestore.rules`](firestore.rules) from this project folder (must include the **`moneyTransactions`** block).
3. Click **Publish** and wait until it finishes (a few seconds).
4. Refresh the app and try again.

**Optional (Firebase CLI):** With [`firebase.json`](firebase.json) in this folder, after `firebase login` and `firebase use <project-id>`, you can run:  
`firebase deploy --only firestore:rules`

In **Firestore → Rules**, paste the **entire** contents of [`firestore.rules`](firestore.rules) from this project (kept in sync with the app). The block below matches that file — **include the `moneyTransactions` section** or saving invoices, payments, and balance updates will be denied.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Seller profile + invoice counter: only the signed-in user may access their own docs
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      match /meta/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }

    match /invoices/{invoiceId} {
      allow read: if request.auth != null && resource.data.userId == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.userId == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.userId == request.auth.uid;
    }

    match /customers/{customerId} {
      allow read: if request.auth != null && resource.data.userId == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.userId == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.userId == request.auth.uid;
    }

    match /moneyTransactions/{transactionId} {
      allow read: if request.auth != null && resource.data.userId == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.userId == request.auth.uid;
      allow update, delete: if false;
    }
  }
}
```

For `create`, `request.resource` is the new document. For `update`/`delete`, `resource` is the existing document — the rules above ensure users cannot reassign data to another account.

Click **Publish** after editing.

## 7. Composite index for invoice history

The **Invoice history** query uses `userId` **and** `date` together, so Firestore needs a **composite index**. Without it you see: *“The query requires an index”* with a long `create_composite=…` link.

**Fastest fix:** click the link Firebase shows in the error (or in the browser console). It opens the index editor with the right fields pre-filled — click **Create index**. Wait until status is **Enabled** (often 1–5 minutes; can be longer). Then refresh the app and open **History** again.

**Manual path:** **Firestore → Indexes → Composite → Add index** — collection `invoices`:

- `userId` — Ascending  
- `date` — Descending  

**Using Firebase CLI (optional):** this repo includes [`firestore.indexes.json`](firestore.indexes.json). From the project folder, after `firebase init firestore` (or with an existing `firebase.json`), run:

`firebase deploy --only firestore:indexes`

## 8. Run the app locally (recommended)

1. Edit `firebase-config.js` with your project keys.
2. **Windows:** double-click **`START.bat`**. It starts a small local web server and opens the app in your browser.
3. **macOS/Linux:** in a terminal, run `chmod +x START.sh && ./START.sh`, or use `python3 -m http.server 8080` and open `http://127.0.0.1:8080/`.

If Python is not installed, install [Python 3](https://www.python.org/downloads/) or use VS Code **Live Server**, or deploy static files to **Firebase Hosting**.

## 9. Optional: Firebase Hosting

1. Install [Firebase CLI](https://firebase.google.com/docs/cli) and run `firebase login`.
2. In this folder, run `firebase init hosting` and point the public directory to this project root (where `index.html` lives).
3. Run `firebase deploy`.

After deployment, add your Hosting domain under **Authentication → Authorized domains**.

## 10. Clear Firestore test data (fresh testing)

To remove **all invoices, customers, and money transaction rows** and reset the **invoice number counter** (seller settings under `users/{uid}` are kept):

1. In Firebase Console → **Project settings** → **Service accounts** → **Generate new private key**. Save the JSON file somewhere safe and **do not commit it** to git.
2. In a terminal, from the project’s **`scripts`** folder: `npm install` (once).
3. Run (adjust the path to your key file):

   `node clear-firestore-test-data.mjs "C:\path\to\your-service-account.json" --yes`

   Alternatively, set the environment variable `GOOGLE_APPLICATION_CREDENTIALS` to the full path of that JSON file, then run `node clear-firestore-test-data.mjs --yes`.

The `--yes` flag is required so the script only runs when you mean it.

**Manual option (small data):** In **Firestore → Data**, you can delete documents in `invoices`, `customers`, and `moneyTransactions` by hand. Invoice sequences live under `users/{yourUid}/meta/` as `invSeq_2026-2027` (one doc per account period) with `{ "nextNumber": <next> }`. The legacy `invoiceCounter` doc is unused for newly created invoices. For many rows, use the script above.

## Troubleshooting

- **Blank page / module errors:** Ensure you are not opening `index.html` as `file://`. Use `START.bat` or another local server.
- **“Missing or insufficient permissions” (Settings / Save invoice / payments):** Almost always **Firestore rules**. Follow **section 6** — copy from [`firestore.rules`](firestore.rules) (or the full block in this doc), paste into **Firestore Database → Rules**, click **Publish**. If you only pasted an older snippet without `moneyTransactions`, ledger writes will fail. If you use **production mode** without updating rules, all reads/writes are denied until you publish.
- **Permission denied on Firestore:** Confirm you are signed in (Auth) and rules match section 6. `request.auth.uid` must match the `users/{uid}` path.
- **“The query requires an index”** (often on **History**): Normal. Use the link in the error, create the index, wait until it is **Enabled**, then reload (see section 7).
