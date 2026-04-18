# SOP 02 — Create and generate a GST invoice

## Goal

Create a **new GST invoice**, preview it, and **generate** it so it receives an official number and updates balances.

## Prerequisites

- **Customer** exists or you can add one during the flow.
- **Settings** (SOP 01) are complete.

## Steps

1. Click **New GST invoice** or go to `#/create`.
2. **Select a customer** (or add a new customer if prompted).
3. Confirm **billing/consignee** details and place of supply if shown.
4. Add **line items:** description, HSN, quantity, rate; confirm **CGST/SGST vs IGST** is correct for the supply.
5. Click **Preview invoice** (or equivalent) and verify totals, tax, and wording.
6. Click **Generate invoice** (or **Save changes** when editing) to finalize.
7. Note the **invoice number** shown after generation.
8. Optional: open the invoice from **Invoice register** (`#/history`) and **print or download PDF**.

## Success criteria

- Invoice appears in **Invoice register** with correct number and date.
- **Customer outstanding** increases by the **net receivable** of that invoice (total minus any payment recorded on the invoice), per system rules.

## Common issues

- **Paid invoice edit warning:** If editing an invoice already marked paid, the app asks for confirmation — only proceed if you intend to change historical data.
- **Validation errors:** Fix highlighted fields (missing GSTIN, zero totals, etc.) before preview.
