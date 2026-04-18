# Easy Billing — documentation

This folder contains the **user manual**, **SOP playbooks**, **appendices**, and **screen inventory** for the Easy Billing product.

## Documentation map

Start with [TABLE_OF_CONTENTS.md](TABLE_OF_CONTENTS.md).

## Format and tooling (chosen)

**Format:** **Markdown in the repository** (`docs/`). This keeps documentation versioned with the app, reviewable in pull requests, and easy to open in Cursor or any editor.

**Alternatives considered:** Google Docs / Notion — faster for non-developers but easier to drift from the codebase; not selected as the primary store.

**Single PDF of all docs (recommended):**

From the repository root (requires `npm install` once):

```bash
npm run docs:pdf
```

This merges every Markdown file under `docs/` (manual, SOPs, appendices, inventory) into **`docs/EasyBilling_Documentation.pdf`** using [md-to-pdf](https://github.com/simonhaenisch/md-to-pdf) (headless Chromium). The generated PDF is listed in `.gitignore`; regenerate after doc edits.

**Other options:** Install [Pandoc](https://pandoc.org/) and convert individual files, or print from VS Code / Typora for a one-off.

**Publishing later:** The same Markdown can be fed into VitePress, Docusaurus, or MkDocs if you add a doc site.

## Maintenance rule

When you change **balance logic**, **payment allocation**, or **analytics windows**, update:

1. The relevant **SOP** in `docs/SOP/`, and  
2. **Appendix A** — [APPENDIX_BUSINESS_LOGIC.md](APPENDIX_BUSINESS_LOGIC.md).

## Admin / Firebase setup

Technical setup is documented separately: [FIREBASE_SETUP.md](../FIREBASE_SETUP.md).
