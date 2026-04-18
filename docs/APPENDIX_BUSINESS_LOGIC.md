# Appendix A — Business rules (source: application code)

Plain-language rules for **balances**, **invoices**, **payments**, **allocation**, and **analytics**. When behaviour changes in code, update this appendix and the relevant SOP.

## Rounding

Amounts use **two decimal places** (`round2`) in financial logic (`js/invoices.js`, `js/payment-fifo.js`, `js/payments.js`).

## Customer outstanding balance (`customers.outstandingBalance`)

- Represents how much the customer **owes the business** after all recorded movements the app applies.
- **New invoice (create):** In `saveInvoice`, the customer’s balance moves from `prev` to `prev + invoice total − amount paid on that invoice` (payment-on-invoice reduces what is added to receivables).
- **Invoice edit:** `updateInvoiceWithCustomerBalance` recomputes balance by reversing the **old** invoice’s net receivable (total − paid on invoice) and applying the **new** net; customer may change if the invoice is reassigned.
- **Standalone payment:** `recordCustomerPayment` subtracts the payment amount from `outstandingBalance` (cannot pay more than current outstanding).
- **Revoke payment:** `revokeCustomerPayment` adds the payment amount back to `outstandingBalance` and restores each affected invoice’s `amountPaidOnInvoice` and `paymentStatus` from stored “before” values on the transaction.

## “Opening” / non-invoice outstanding

- **Definition (code):** `computeNonInvoiceOutstanding(customerBalance, invoiceRowsWithOwed)` =  
  `max(0, customer outstanding − sum of (invoice total − paid) for open invoice lines shown)`.
- This is the portion of the customer balance **not** explained by current open invoice dues — e.g. legacy opening balance or other non-invoice debt.
- In the payment UI it appears as a synthetic row id `OPENING_BALANCE_ROW_ID` (`__opening_outstanding__`) with label like “Opening / non-invoice outstanding” (`js/payments.js`, `js/payment-fifo.js`).

## Open invoice

- An invoice is **open** if total &gt; 0, and either status is not fully “paid” or paid amount is below total within a small tolerance (`isInvoiceOpen` in `js/payment-fifo.js`).

## Standalone payment allocation (`allocatePaymentSelectedThenFifo`)

Order of application for a given payment amount:

1. If the user **selected** rows: process selections **in order**. Selections can include the opening row (`__opening_outstanding__`) and specific invoice ids.
2. If **nothing** is selected: apply to **opening** bucket first (if any), then apply remainder **FIFO** across other open invoices.
3. **FIFO** for remaining cash: invoices sorted by **invoice date ascending**, then **invoice number** (`compareInvoiceDataForFifo`).
4. At most **2000** open invoices participate (`MAX_INVOICES_TO_ALLOCATE`).

**Validation when rows are selected:** The payment amount must be **at least** the sum of outstanding on the selected rows (including opening row if selected). Otherwise the app shows an error (amount less than selected total) — see `assertPaymentCoversSelectedInvoices` in `js/payments.js`.

**Hard caps:** Payment cannot exceed the customer’s **current** `outstandingBalance`. Allocation must balance internally (`assertAllocationTotalsMatch`).

## Money transaction record (`moneyTransactions`)

- Standalone payments store `type: "PAYMENT_STANDALONE"`, `allocatedInvoices` (per-invoice before/after), `openingBalanceApplied`, `ledgerStatus: "active"` (or `"revoked"` after revoke), `amountReceivedDate`, etc.
- Revoke requires allocation details (opening and/or invoices); otherwise revoke is rejected.

## Dashboard analytics (`js/dashboard-analytics.js`, `js/dashboard.js`)

- Dashboard loads invoices from the **last 36 months** only (`DASHBOARD_INVOICE_LOOKBACK_MONTHS` in `js/invoices.js` via `listInvoicesForUserSince`).
- **Customer outstanding** on the dashboard is **live** from the customer directory (not limited to the 36-month invoice window) — see dashboard lead copy in `js/dashboard.js`.
- **India FY filter** (optional): limits KPIs/charts to one financial year (Apr–Mar) but still only within that **same loaded 36-month** invoice set.
- **Daily chart window:** Last **30 days** of billing by invoice date (local calendar), see `computeAnalytics` day bucket logic.

## Reports analytics (`js/reports-analytics.js`)

- Uses period presets: today, yesterday, this week (Mon–Sun local), this month, quarter, year, India FY, custom range.
- Figures are **period-scoped** per selected filters; definitions align with `accountPeriodLabelForInvoice` / invoice date from `js/invoices.js` where applicable.

## Invoice totals and tax

- Line totals and GST splits are computed in the invoice math layer (`invoice-math.js`, used from `invoice-form.js` / `invoices.js`): intra-state CGST+SGST vs inter-state IGST per business rules encoded there.

## Deleted / archived invoices

- **Full delete** (`deleteInvoice`): Writes an archive document to `deletedInvoices`, removes the live `invoices` doc, and **reverses customer balance** when the invoice was linked to a customer (see `js/invoices.js`).
- **Document-only delete** (`deleteInvoiceDocumentOnly`): If rules block a full delete, the app may still archive to `deletedInvoices` and remove the invoice doc without full ledger updates (`skippedLedger` path).
- The UI can open archived rows at `#/invoice-deleted/<id>` for read-only viewing.

---

*Maintain this document when changing `saveInvoice`, `updateInvoiceWithCustomerBalance`, `recordCustomerPayment`, `revokeCustomerPayment`, `allocatePaymentSelectedThenFifo`, or analytics date windows.*
