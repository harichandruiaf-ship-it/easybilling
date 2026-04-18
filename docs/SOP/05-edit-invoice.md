# SOP 05 — Edit an existing invoice

## Goal

Change line items, taxes, or buyer details on an invoice that was already saved.

## Prerequisites

- You know the **invoice id** or can find the invoice in **Invoice register**.

## Steps

1. Open **Invoice register** (`#/history`) and locate the invoice, or open the invoice detail page.
2. Use **Edit** (or navigate to `#/create?edit=<invoiceId>` if that is how your UI exposes it).
3. If the invoice is **fully paid**, read the **confirmation** carefully — only proceed if corrections are authorized.
4. Change the necessary fields; use **Preview** to verify.
5. **Save changes** / **Generate** as prompted so balances update.

## Success criteria

- Invoice totals and taxes match expectations.
- **Customer outstanding** matches the correction (the app reverses old net receivable and applies the new net).

## Common issues

- **Blocked or warned edit on paid invoices:** This is intentional — coordinate with finance before forcing changes.
- **Wrong customer after edit:** If you change the assigned customer, outstanding moves between customers per system rules — verify both accounts.
