# eURC POS — Delivery team and way of working

Team: **2 developers** and **1 tester (QA engineer)**. The repository owner
(`GITHUB_OWNER`) is the team lead and is usually Developer 1.

## Roles and responsibilities (RACI)

R = does the work · A = accountable / approves · C = consulted · I = informed

| Activity | Developer 1 (lead) | Developer 2 | Tester (QA) |
|---|---|---|---|
| User stories and acceptance criteria | A | C | R |
| React front end (`web/`) | R | R | C |
| Node.js API and database migrations (`app/`) | R | R | C |
| Infrastructure as code (`infra/`) | A / R | R | I |
| Code review of `app/`, `web/`, `infra/` | R (reviews Dev 2) | R (reviews Dev 1) | C |
| Test suites: smoke, integration, load, Playwright (`tests/`) | C | C | A / R |
| Pipeline (`.github/`) | A / R | C | R (reviews) |
| Exploratory testing on the **test** environment | I | I | R |
| **QA sign-off → production** (approve `prod`) | backup approver | — | A / R |
| Rollback decision | A | C | R (raises S1) |
| Release notes / GitHub release | automatic (CD) | — | I |

## Branching and reviews (GitHub flow)

```
main ──●────────────●──────────────●───────────►  (protected: PR only)
        \          / \            /
         feature/pos-12-refunds    test/e2e-refund-flow
         (Developer 2)             (Tester)
```

1. One short-lived branch per story: `feature/<id>-<slug>`, `fix/<id>-<slug>`, `test/<slug>`.
2. Open a pull request early. CI runs **app · web · infra · scripts**.
3. **Review rules** (ruleset *protect-main* + `CODEOWNERS`):
   - at least **1 approval**, never by the author, and the approval must come after the last push;
   - `app/`, `web/`, `infra/`, `scripts/` → one of the developers (so Dev 1 and Dev 2 review each other);
   - `tests/` → the tester;
   - `.github/` (the pipeline itself) → the lead or the tester;
   - all review threads resolved, all 4 checks green, branch up to date.
4. Squash-merge. CD deploys the merge to **dev**, then **test** automatically.
5. The tester verifies the story on **test** (the CD run's E2E report + the PR's QA notes), then
   approves **prod** in GitHub (*Review deployments*). The person who triggered the run cannot approve it.

## Definition of Done

- Acceptance criteria covered by an automated test (unit, component, integration or E2E).
- CI green; coverage gates held (API ≥ 80 %, React ≥ 80 % lines).
- Database changes are expand-only in this release.
- Deployed to test by CD; E2E (desktop + tablet) green; tester signed off.
- Live in production via staging-slot swap; post-deployment gate green.

## Environments and who uses them

| Environment | Who | Data |
|---|---|---|
| local (`npm run dev`) | developers | in-memory, demo store `demo` / `manager@demo.test` / `Password123` |
| dev | developers | test data; reset freely |
| test | tester (+ stakeholder demos) | test data; E2E creates and deletes its own stores |
| prod | real stores | real data; only reached through the approved pipeline |

## Severity and response

| Severity | Example | Response |
|---|---|---|
| S1 | sales cannot be completed | tester raises; lead runs **Rollback production** (≈ 1–2 min) |
| S2 | wrong totals, stock or receipts | fix-forward within the day through the normal pipeline |
| S3 / S4 | workaround exists / cosmetic | next sprint |
