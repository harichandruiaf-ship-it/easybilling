# SOP 01 — First run: settings and verification

## Goal

Configure your **business profile** and **defaults** so new invoices and PDFs are correct.

## Prerequisites

- You can sign in to Easy Billing.
- You know your **GSTIN**, **default intra-state tax rates**, and **bank details** for invoices.

## Steps

1. Go to **Settings** (`#/settings` from the main menu).
2. Enter **seller legal name**, **address**, **GSTIN**, and contact details as they should appear on invoices.
3. Set **CGST and SGST** default percentages (intra-state defaults).
4. Enter **bank name, account, IFSC**, and any **payment terms** text you want on PDFs.
5. Configure **invoice numbering** (prefix/suffix) per your practice.
6. **Save** if the screen provides a save action.
7. Open **Dashboard** and confirm no error toasts appear.

## Success criteria

- Settings persist after refresh.
- Creating a **test invoice** (see SOP 02) shows your business details and tax split as expected.

## Common issues

- **Wrong tax type on a line:** Check buyer vs seller state (intra vs inter-state) on the invoice form.
- **Firebase / permission errors:** Administrators should verify project setup per [FIREBASE_SETUP.md](../../FIREBASE_SETUP.md).
