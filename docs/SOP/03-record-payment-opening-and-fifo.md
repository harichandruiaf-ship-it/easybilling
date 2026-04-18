# SOP 03 — Record a payment (opening balance + invoices, FIFO)

## Goal

Record **money received** from a customer and have it applied to **opening / non-invoice debt** and/or **open invoices** in the correct order.

## Prerequisites

- Customer has a **non-zero outstanding** balance.
- You know the **amount received** and **date** of credit.

## Steps

1. Go to **Customers** (`#/customers`).
2. Find the customer and open **Record payment** (or the payment action your build exposes).
3. Enter **amount** (cannot exceed total outstanding).
4. Enter **date received**, **payment method**, and optional **note**.
5. **Choose allocation:**
   - **Leave nothing selected:** The system applies to **opening / non-invoice** portion first (if any), then remaining to **oldest open invoices** (FIFO by date, then invoice number).
   - **Select specific rows:** Include **opening / non-invoice outstanding** and/or specific **open invoices**. The amount must be **at least** the sum owed on everything you selected.
6. Submit **Save** / **Record**.

## Success criteria

- Customer **outstanding** decreases by the payment amount.
- Selected or FIFO-affected invoices show updated **paid** amounts and **paid / partial / unpaid** status.

## Common issues

- **“Amount received is less than the total outstanding on the rows you selected”:** Either increase the amount or **deselect** some rows so the selected total matches what you are recording.
- **“Payment cannot exceed outstanding balance”:** Verify the customer’s balance and that you are not double-counting an earlier payment.

See [Appendix A — Business logic](../APPENDIX_BUSINESS_LOGIC.md) for allocation order details.
