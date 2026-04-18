# Non-technical documentation review

Use this checklist before treating the manual as **published** or before a **major release**. The reviewer should be someone who **uses the app** but does not maintain the codebase.

## Environment

- [ ] Use a **staging** or **clean test account** if possible, or production with non-sensitive data only.
- [ ] Sign in with a normal user (not Firebase console).

## Accuracy pass

- [ ] Open [TABLE_OF_CONTENTS.md](TABLE_OF_CONTENTS.md) and confirm every linked file opens.
- [ ] For each **SOP** in [SOP/](SOP/), perform the steps **without reading the code**; note anything unclear or wrong.
- [ ] Confirm **screen names** and **menu labels** match what you see (wording may differ slightly — flag mismatches).

## Business language

- [ ] Terms like **GSTIN**, **HSN**, **opening balance**, **FIFO** make sense with [APPENDIX_GLOSSARY.md](APPENDIX_GLOSSARY.md) nearby.
- [ ] No unexplained internal ids (e.g. synthetic row ids) in user-facing SOP text — they should stay in the appendix only.

## Gaps

- [ ] List **missing flows** (e.g. a report export you use weekly but is not documented).
- [ ] List **error messages** users often hit that deserve a bullet in an SOP.

## Sign-off

| Reviewer | Date | Notes |
|----------|------|-------|
|          |      |       |

After review, update [USER_MANUAL.md](USER_MANUAL.md) and the relevant SOPs, then re-run the checklist items you changed.
