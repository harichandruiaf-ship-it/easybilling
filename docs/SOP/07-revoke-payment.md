# SOP 07 — Revoke a standalone payment

## Goal

**Undo** a mistakenly recorded **standalone payment** and restore **customer balance** and **invoice paid** amounts.

## Prerequisites

- The payment appears in **recent transactions** for the customer (or equivalent list).
- The payment is **standalone** (`PAYMENT_STANDALONE`) and **not already revoked**.
- The stored transaction includes **allocation details** (opening and/or invoice lines). If revoke is disabled, the record may lack this history.

## Steps

1. Open **Customers** and select the customer.
2. Find **recent payments** / **transactions**.
3. Locate the incorrect payment and choose **Revoke** (if available).
4. Confirm the action if prompted.
5. Verify **customer outstanding** increased by the payment amount.
6. Verify each affected **invoice** returned to its prior **paid** amount and **status**.

## Success criteria

- Customer balance matches expectations after reversal.
- Invoice payment lines match pre-payment state.

## Common issues

- **“This payment cannot be revoked (missing allocation details)”:** Older or malformed records may not support revoke — contact support or enter an offsetting adjustment per policy.
- **“Already revoked”:** No further action on that row.

Technical detail: [Appendix A — Business logic](../APPENDIX_BUSINESS_LOGIC.md) § Revoke.
