# Easy Billing — User manual

This manual describes **screens**, **primary actions**, and **outcomes**. For exact calculation rules, see [APPENDIX_BUSINESS_LOGIC.md](APPENDIX_BUSINESS_LOGIC.md). Step-by-step procedures are in [SOP/](SOP/).

---

## Introduction

**Easy Billing** is a web app for **Indian GST invoicing**, **customer balances**, and **payments**, with a **dashboard** and **reports**. It uses **Firebase** for sign-in and data storage.

**Who it’s for:** Small businesses that need GST invoices, payment tracking, and simple analytics.

**Administrators** deploying or configuring Firebase should read [FIREBASE_SETUP.md](../FIREBASE_SETUP.md) (technical).

---

## Account and first run

- **Login** (`#/login` redirects to dashboard when already signed in): use the credentials your administrator created.
- After login, the **main navigation** shows Dashboard, invoice creation, history, customers, quick orders, reports, and settings.

---

## Business settings

**Route:** `#/settings` (`view-settings`)

Configure:

- **Seller identity:** Name, address, **GSTIN**, contact details as they should appear on PDFs.
- **Default tax rates:** CGST/SGST percentages (used when creating invoices).
- **Bank and payment instructions:** Shown on invoices/PDFs.
- **Invoice numbering:** Prefix/suffix patterns so new invoices get correct official numbers and dates when generated.

**Impact:** New and generated invoices pull these values; changing settings does not rewrite old PDFs automatically.

---

## Customers

**Route:** `#/customers`

- **Customer list:** Search and open records.
- **Add / edit:** Name, billing address, **GSTIN**, **outstanding balance** (opening debt when first creating a customer — see appendix).
- **Consignee:** Can match buyer or differ (ship-to) per form fields.
- **Record payment:** Opens the payment flow for that customer (opening row + open invoices — see [APPENDIX_BUSINESS_LOGIC.md](APPENDIX_BUSINESS_LOGIC.md)).
- **View invoices:** Quick access to that customer’s invoices where implemented.

---

## Invoices — create and edit

**Route:** `#/create`

**New invoice**

- Choose **customer** (or add one from here).
- Add **line items:** description, HSN, quantities, rates; tax mode follows intra vs inter-state rules in the form.
- **Preview** then **Generate** to assign invoice number/date and save.

**Query helpers**

- `#/create?customer=<id>` — pre-selects a customer.
- `#/create?edit=<invoiceId>` — **edit** existing invoice (paid invoices trigger a confirmation warning).
- `#/create?quickOrder=<id>` — load a **quick order** draft into the form; may prompt to link or create a customer.

**Success:** Invoice appears in **Invoice register**; customer **outstanding** updates per business rules.

---

## Invoice register and single invoice view

**Register:** `#/history` — search/filter the full list.

**Single invoice:** `#/invoice/<invoiceId>`

- View totals, tax breakdown, payment status, **Print / PDF** where available.
- Links to customer and follow-up actions per UI.

**Deleted / archived invoice:** `#/invoice-deleted/<id>` — read-only view for archived records.

---

## Payments (standalone)

**Typical entry:** Customers → **Record payment** (or equivalent).

- Enter **amount**, **date received**, method, note.
- Optionally **select** specific open invoices and/or the **opening / non-invoice** row.
- Rules: amount cannot exceed total customer outstanding; if you tick **more than one** row, the amount must cover the **combined** due on those rows; a **single** ticked row allows partial payment (see appendix).

**Recent transactions:** List may allow **revoke** or **edit** on eligible standalone payments (revoked entries are excluded from edits).

---

## Quick orders

**Route:** `#/quick-orders`

- Create informal **draft** orders; convert to a full **GST invoice** via the create flow (`?quickOrder=`).

---

## Dashboard

**Route:** `#/dashboard`

- **KPIs and charts:** Revenue, GST split, receivables mix, trends.
- **Data window:** Invoice-based metrics use invoices loaded from the **last 36 months**; optional **India FY** filter narrows display within that window.
- **Customer outstanding** reflects **current** directory balances (not limited to 36 months).

See on-screen hints and [APPENDIX_BUSINESS_LOGIC.md](APPENDIX_BUSINESS_LOGIC.md).

---

## Reports

**Route:** `#/reports`

- Choose **period** (today, week, month, quarter, India FY, custom, etc.).
- View/export analytics scoped to that period — definitions align with `reports-analytics` logic.

---

## Related documents

| Document | Purpose |
|----------|---------|
| [TABLE_OF_CONTENTS.md](TABLE_OF_CONTENTS.md) | Full doc map |
| [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md) | Routes and views |
| [APPENDIX_BUSINESS_LOGIC.md](APPENDIX_BUSINESS_LOGIC.md) | Formulas and allocation order |
| [APPENDIX_GLOSSARY.md](APPENDIX_GLOSSARY.md) | Terms |
| [SOP/](SOP/) | Step-by-step playbooks |
