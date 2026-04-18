# Appendix B — Glossary

| Term | Meaning in Easy Billing |
|------|-------------------------|
| **GSTIN** | Goods and Services Tax Identification Number — seller and buyer tax IDs on invoices. |
| **HSN** | Harmonized System of Nomenclature — product/service classification for GST line items. |
| **CGST / SGST** | Central and State GST components for **intra-state** supplies. |
| **IGST** | Integrated GST for **inter-state** supplies. |
| **Place of supply** | Location used to determine intra vs inter-state tax treatment (see form and settings). |
| **Outstanding balance** | Amount the customer still owes per `customers.outstandingBalance` — includes invoice-backed dues and non-invoice (“opening”) portions. |
| **Opening / non-invoice outstanding** | Part of outstanding not matched to open invoice lines in the payment screen; paid first when no rows are selected, or when explicitly selected. |
| **FIFO allocation** | Applying payment to the **oldest** open invoices by date (then invoice number) after optional opening and selected rows. |
| **Payment status** | On an invoice: typically `unpaid`, `partial`, or `paid` based on `amountPaidOnInvoice` vs `total`. |
| **Standalone payment** | A payment recorded against the customer (not only embedded in invoice creation), stored in `moneyTransactions`. |
| **India FY** | Financial year Apr 1 – Mar 31 — used for dashboard FY filter and report presets. |
| **Invoice register** | History list at `#/history` — full invoice list (not limited to dashboard’s 36-month window for loading analytics). |
