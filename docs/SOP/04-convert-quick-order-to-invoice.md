# SOP 04 — Convert a quick order to a GST invoice

## Goal

Turn a **quick order** draft into a formal **GST invoice** with correct customer linkage.

## Prerequisites

- A **quick order** exists in **open** status (not already completed).

## Steps

1. Go to **Quick orders** (`#/quick-orders`).
2. Open or select the order you want to convert.
3. Use the action that **creates an invoice** or navigates to create with the quick order (the app opens `#/create?quickOrder=<id>`).
4. If prompted to **link an existing customer**, confirm the match or **add a new customer** with address/GSTIN.
5. Review **all line items, rates, and tax mode** — quick orders may not set every field.
6. Follow **SOP 02** from preview through **Generate invoice**.
7. Confirm the quick order shows as **completed** or no longer open in the quick order list.

## Success criteria

- A new invoice exists in **Invoice register** with correct totals.
- Customer outstanding reflects the new invoice per normal rules.

## Common issues

- **“Quick order not found or already completed”:** The draft was deleted or already converted — create a new quick order or invoice from scratch.
- **New customer:** Complete the **add customer** popup before generating the invoice if the app requires a registered buyer.
