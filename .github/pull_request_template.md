## What and why
<!-- One or two sentences. Link the issue: Closes #123 -->

## Type
- [ ] Feature (app/ or web/)
- [ ] Bug fix
- [ ] Tests (tests/ — QA engineer reviews)
- [ ] Infrastructure (infra/ — shows a what-if in the CD run)
- [ ] Pipeline (.github/ — lead + QA review)

## Checklist (Definition of Done)
- [ ] Unit / component tests added or updated (`npm test` in app/ and web/)
- [ ] Database change is **expand-only** (new table / nullable column / index), never drop or rename in the same release
- [ ] No secrets, keys or card data in code, logs or settings
- [ ] Screenshots attached for UI changes
- [ ] QA notes below tell the tester what to verify on the **test** environment

## QA notes for the tester
<!-- Steps to verify on https://<test-environment>/ after CD deploys this to test -->
