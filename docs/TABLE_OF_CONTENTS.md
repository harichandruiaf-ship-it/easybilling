# Easy Billing documentation — table of contents

This TOC ties together the **user manual**, **SOP playbooks**, and **appendices**. File paths are relative to the repository `docs/` folder.

## 1. Introduction and setup

| Doc | Description |
|-----|-------------|
| [README.md](README.md) | How this documentation is organized, format choice, maintenance |
| [USER_MANUAL.md](USER_MANUAL.md) § Introduction | What Easy Billing is, audience, India GST context |
| [USER_MANUAL.md](USER_MANUAL.md) § Account and first run | Login; admins see [FIREBASE_SETUP.md](../FIREBASE_SETUP.md) |

## 2. User manual (screen-by-screen)

| Chapter in [USER_MANUAL.md](USER_MANUAL.md) | Topics |
|---------------------------------------------|--------|
| Business settings | GSTIN, bank, terms, invoice numbering, tax rates |
| Customers | Directory, add/edit, opening outstanding, consignee |
| Invoices (create) | Line items, intra vs inter-state tax, preview, generate |
| Invoice register & invoice view | Search, print/PDF, payment status, deleted/archived |
| Payments | Record payment, opening balance, FIFO, revoke |
| Quick orders | Drafts, convert to GST invoice |
| Dashboard | KPIs, charts, 36-month data window, India FY filter |
| Reports | Period presets, definitions, exports |

## 3. SOP playbooks ([SOP/](SOP/))

| SOP | File |
|-----|------|
| First run: settings and verification | [SOP/01-first-run-and-settings.md](SOP/01-first-run-and-settings.md) |
| Create and generate a GST invoice | [SOP/02-create-and-generate-invoice.md](SOP/02-create-and-generate-invoice.md) |
| Record a payment (opening + invoices, FIFO) | [SOP/03-record-payment-opening-and-fifo.md](SOP/03-record-payment-opening-and-fifo.md) |
| Convert quick order to invoice | [SOP/04-convert-quick-order-to-invoice.md](SOP/04-convert-quick-order-to-invoice.md) |
| Edit an invoice (including paid-invoice warning) | [SOP/05-edit-invoice.md](SOP/05-edit-invoice.md) |
| Month-end / GST review using Reports | [SOP/06-month-end-gst-review-reports.md](SOP/06-month-end-gst-review-reports.md) |
| Revoke a payment | [SOP/07-revoke-payment.md](SOP/07-revoke-payment.md) |
| Set or adjust customer opening balance | [SOP/08-customer-opening-balance.md](SOP/08-customer-opening-balance.md) |

## 4. Appendices

| Appendix | File |
|----------|------|
| A — Business rules (balances, allocation, revoke) | [APPENDIX_BUSINESS_LOGIC.md](APPENDIX_BUSINESS_LOGIC.md) |
| B — Glossary | [APPENDIX_GLOSSARY.md](APPENDIX_GLOSSARY.md) |
| Screen/route inventory | [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md) |

## 5. Process

| Doc | Description |
|-----|-------------|
| [REVIEW_CHECKLIST.md](REVIEW_CHECKLIST.md) | Non-technical review before publishing or major releases |

---

**Approved structure:** User manual (single narrative file) + SOP folder + appendices + inventory + review checklist — matches the documentation plan.
