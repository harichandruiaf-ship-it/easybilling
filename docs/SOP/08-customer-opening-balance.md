# SOP 08 — Set or adjust customer opening balance

## Goal

Record **legacy debt** (amount the customer already owed before you started using Easy Billing) so **collections** and **payment allocation** behave correctly.

## Prerequisites

- You agree how **opening debt** should appear vs **new invoices** (finance policy).

## Steps

1. Go to **Customers** → **Add** or **Edit** customer.
2. Set **outstanding balance** to the **opening receivable** you want to track (amount they owe you).
3. Save the customer.
4. When recording payments, understand that **non-invoice** portion shows as **Opening / non-invoice outstanding** in the payment selector when it does not match open invoice dues (see appendix).
5. Optionally create a **starting invoice** instead of only opening balance — pick one consistent approach for your books.

## Success criteria

- **Dashboard** / customer directory shows expected **outstanding**.
- **Record payment** (SOP 03) applies cash to opening and/or invoices as you intend.

## Common issues

- **Double counting:** If you both set opening balance **and** recreate old invoices, totals can be wrong — keep one source of truth.
- For formulas, read [Appendix A — Business logic](../APPENDIX_BUSINESS_LOGIC.md) § “Opening / non-invoice outstanding”.
