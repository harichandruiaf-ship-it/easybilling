# Screen and route inventory

This document maps **URL hash routes** (see `parseHash` / `route()` in `js/app.js`) to **DOM view containers** in `index.html` and primary user actions.

## Hash routing rules

- Default route when hash is empty or `#/` is **`dashboard`**.
- Path format: `#/<route>` or `#/<route>/<id>?query=params`.
- Query string (where used): `?customer=<customerId>`, `?edit=<invoiceId>`, `?quickOrder=<quickOrderId>`.

| Hash route | Example | View `id` | Loader / behaviour |
|------------|---------|-----------|---------------------|
| `dashboard` | `#/dashboard` | `view-dashboard` | `mountDashboard` — KPIs, charts, quick order modal hooks |
| `settings` | `#/settings` | `view-settings` | `fillSettingsForm` — business profile, GST %, bank, terms |
| `customers` | `#/customers` | `view-customers` | `renderCustomersPage` — directory, add/edit, payment modal |
| `quick-orders` | `#/quick-orders` | `view-quick-orders` | `renderQuickOrdersPage` — list, create, convert |
| `create` | `#/create` | `view-create` | Invoice form: new invoice, or `?edit=` edit, or `?customer=` preselect, or `?quickOrder=` from draft |
| `history` | `#/history` | `view-history` | `renderHistory` — invoice register (search/filter) |
| `reports` | `#/reports` | `view-reports` | Reports module `mountReports` — period analytics, exports |
| `invoice` | `#/invoice/<invoiceId>` | `view-invoice` | `renderInvoicePage` — single invoice detail, print/PDF |
| `invoice-deleted` | `#/invoice-deleted/<id>` | `view-invoice` | `renderDeletedInvoicePage` — archived/deleted invoice read-only |
| `login` | `#/login` | `view-login` | Redirects to `#/dashboard` when already authenticated |

**Note:** `invoice` and `invoice-deleted` share the same view container; content differs by route.

## View sections in `index.html` (order of appearance)

| Section `id` | Purpose (summary) |
|--------------|-------------------|
| `view-login` | Email/password sign-in |
| `view-dashboard` | Summary cards, charts, FY filter, links to create/history |
| `view-reports` | Report period controls, tables/charts, export |
| `view-quick-orders` | Quick order list and actions |
| `view-settings` | Seller GSTIN, address, CGST/SGST %, bank, invoice prefix/suffix |
| `view-create` | Full GST invoice form (buyer, lines, tax, preview modal) |
| `view-customers` | Customer table, modals for add/edit, payments, invoice list per customer |
| `view-history` | Invoice register grid, filters |
| `view-invoice` | Single invoice page (active or deleted) |

## Modals and overlays (not separate routes)

Referenced from multiple screens:

- **Invoice preview / generate** — on Create flow (`closeInvoicePreviewModal` on route change).
- **Customer add/edit** — Customers and Create (e.g. quick order new buyer).
- **Record payment** — Customers (`closeCustomerPaymentModal`).
- **Customer invoices list** — `closeCustomerInvoicesModal`.
- **Dashboard quick order** — `closeDashboardQuickOrderModal`.

## Navigation entry points

- Main nav (after login): links to Dashboard, Create, History, Customers, Quick orders, Reports, Settings (see `index.html` nav + `syncAppChrome` in `app.js`).

---

*Source of truth for routes: `parseHash`, `route`, `showView` in `js/app.js`; view IDs in `index.html`.*
