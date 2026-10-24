# eURC Point of Sale — Hands-on Project 02 Runbook

A React + Node.js Point of Sale delivered to Dev, Test and Production on Azure
by a GitHub Actions CI/CD pipeline, built by **2 developers** and verified by
**1 tester**. Everything below runs from **Azure Cloud Shell (Bash)** and the
GitHub website. Roles and review rules are in [`TEAM.md`](TEAM.md).

Plan about 2 hours for parts A–C and 1–2 hours for the team exercises.

---

## Part A — Prepare (15 min)

1. **Azure** (lead): sign in at <https://portal.azure.com> with your Azure for
   Students account and open **Cloud Shell → Bash**. If Project 01 is still
   deployed, tear it down first to save credit.
2. **GitHub** (everyone): each team member needs a GitHub account. Collect the
   three user names. A **public** repository gets reviews, CODEOWNERS and the
   production approval gate on GitHub Free; a private one needs GitHub Pro /
   Team (free with the GitHub Student Developer Pack).
3. Upload `eurc-p02-cicd-kit.zip` to Cloud Shell (**Manage files → Upload**), then:

   ```bash
   unzip eurc-p02-cicd-kit.zip && cd eurc-platform
   nano config/eurc.env
   #   GITHUB_OWNER = lead's GitHub user (owns the repo, backup prod approver)
   #   DEV1, DEV2   = the two developers (DEV1 is usually the lead)
   #   TESTER       = the QA engineer (owns tests/, signs off production)
   #   ALERT_EMAIL  = receives production alerts and budget e-mails
   gh auth login -s workflow   # GitHub.com → HTTPS → Y → Login with a web browser
   ```

> Long-running commands: start `tmux new -s eurc` first. If Cloud Shell
> disconnects, reopen it and run `tmux attach -t eurc`.

## Part B — Bootstrap Azure and GitHub (10 min, lead)

```bash
./setup.sh
```

| Script | What it does |
|---|---|
| `00-preflight.sh` | Tools, logins, Owner role, region policy, SQL Basic and App Service B1/S1 availability, resource providers |
| `01-bootstrap-azure.sh` | Resource groups `rg-eurc-cicd-cc`, `-dev-cc`, `-test-cc`, `-prod-cc`; one OIDC deployment identity per environment, Contributor + constrained RBAC Administrator on its own group; budget |
| `02-setup-github.sh` | Repository; invites **DEV2** and **TESTER** with write access; writes **CODEOWNERS**; environments `dev` / `test` (main only) and `prod` (**QA sign-off by the tester**, lead as backup, self-approval blocked); variables; first push |

**Team members:** accept the e-mail invitation from GitHub. If the tester
accepted after step 02 ran, the lead re-runs `./scripts/02-setup-github.sh` once
so the tester becomes the prod reviewer.

Then everyone clones the repository on their own machine (or in Codespaces):

```bash
git clone https://github.com/<owner>/eurc-platform && cd eurc-platform
(cd app && npm ci) && (cd web && npm ci) && (cd tests && npm ci)
# two terminals:
cd app && npm run dev     # API on :8080 with demo store "demo" / manager@demo.test / Password123
cd web && npm run dev     # React on http://localhost:5173 (proxies /api to :8080)
```

## Part C — First release (30–40 min)

1. Open `https://github.com/<owner>/eurc-platform/actions` → **CD**.
2. **build** runs the API tests, the React tests and build, validates Bicep and
   packages one zip containing the API and the React app.
3. **dev** and **test** deploy automatically. The test stage runs the smoke,
   integration and load suites and the **Playwright** browser tests on desktop
   and tablet. The run summary shows every check; the Playwright HTML report is
   in the `reports-test` artifact.
4. **Tester:** open the test URL, try the register (it shows a **TEST** badge),
   then approve: **Review deployments → prod → Approve and deploy**.
5. **prod** deploys to the staging slot, smoke-tests it, swaps with preview (production settings applied to staging, wait until Healthy, then switch), verifies and runs
   the post-deployment gate. **release tag** creates the GitHub release.

Check it:

```bash
./scripts/20-test-env.sh --integration
./scripts/03-harden-prod.sh
./scripts/02-setup-github.sh --protect-main   # PR + 1 review + code owners + green app/web/infra/scripts
```

Open production, choose **Create a store**, add products under **Products**, a
cashier under **Staff**, and ring up a sale on the **Register**.

---

## Team exercises

### 1 — Developer 2 ships a feature, Developer 1 reviews

Story: *As a manager, I want a barcode on each product, so cashiers can search by it.*

```bash
git checkout -b feature/pos-1-barcode
```

Developer 2 adds an expand-only migration to `app/src/migrations.js`:

```js
  {
    version: 4,
    name: 'products_add_barcode',
    sql: `IF COL_LENGTH('dbo.products', 'barcode') IS NULL
ALTER TABLE dbo.products ADD barcode NVARCHAR(32) NULL;`,
  },
```

…bumps `"version"` in `app/package.json` and `web/package.json` to `2.1.0`,
runs `npm test` in both, pushes and opens a PR (`gh pr create --fill`).
CI must be green and **Developer 1** must approve (CODEOWNERS). After the merge,
CD takes `2.1.0+N.<sha>` to dev and test; `/health` shows `schemaVersion: 4`.

### 2 — The tester adds an automated check

The tester opens `test/e2e-refund-receipt` and extends `tests/e2e/pos.spec.mjs`
(for example: the refunded receipt shows **REFUNDED**). Only the tester can
approve changes to `tests/`, so a developer cannot weaken a test unnoticed.

### 3 — CI blocks a broken change

On a branch, change the expected total in `web/src/components/Cart.test.jsx`
from `$8.49` to `$9.49` and open a PR. The **web** check fails, the merge button
stays disabled and nothing is deployed. Close the PR.

### 4 — A bad release is stopped before production

Why the tester owns `tests/`: a developer "simplifies" tax rounding in
`app/src/domain/pricing.js` to `Math.floor` **and** updates the expected values
in `app/test/domain.test.js` so CI stays green (developers own `app/`). The
other developer approves. CD deploys to dev, but in test the tester's
**integration** suite expects the sample basket to total `849` cents (it is now
`848`) and the **Playwright** test expects `$8.49` on screen, so the release
stops before anyone is asked to approve production. Revert with another PR.

### 5 — QA sign-off and rollback

On the next release, the tester approves prod. Afterwards, the lead runs
**Actions → Rollback production → Run workflow** with a reason; the tester
approves it. The previous version is swapped back in about a minute and the
slot-swap alert e-mail arrives.

### 6 — Operate it

```bash
./scripts/30-monitor.sh                # versions, health, traffic, alerts, cost
./scripts/30-monitor.sh --load test 120
./scripts/30-monitor.sh --test-alert
./scripts/30-monitor.sh --dora         # deployment frequency, lead time, change failure rate
```

In the portal: **appi-eurc-prod-cc-001 → Application map** (App Service → SQL,
Blob, Key Vault) and the release annotations on the charts.

---

## Load a large catalogue (v2.3)

For catalogues beyond a few thousand rows (e.g. the 200,000-product supermarket
sample), import from Cloud Shell into a **separate demo store on test**:

```bash
# Excel: File > Save As > CSV UTF-8, then Manage files > Upload
node scripts/40-bulk-import.mjs --env test --store supershop-demo \
     --email you@example.com --file supershop-200k.csv --dry-run   # check every row first
node scripts/40-bulk-import.mjs --env test --store supershop-demo \
     --email you@example.com --file supershop-200k.csv             # import; re-run to resume
```

The script signs in as a user with *products.manage* (Admin, Manager or
Procurement), creates missing categories, and sends batches of 1,000 through
the API (each batch one transaction, bulk insert). On SQL Basic (5 DTU) expect
roughly 30-60 minutes for 200,000 rows; scale the test database to S2 for the
import and back afterwards to make it faster:

```bash
az sql db update -g rg-eurc-test-ncus -s <sql-server> -n sqldb-eurc-core-test --service-objective S2
# ... import ...
az sql db update -g rg-eurc-test-ncus -s <sql-server> -n sqldb-eurc-core-test --service-objective Basic
```

Measured on 24 Oct 2026 with S2: 200,000 rows in 328 s on test and 291 s on prod
(about 600-700 rows/s); the dry run checks all rows in about 2 minutes.

## Payments and the GST/HST report (v2.4)

**Payment methods.** The Admin chooses them under *Business → Payment methods*:
cash, debit, credit, Interac e-Transfer (needs the e-Transfer e-mail) and Stripe.
The register offers only those. The POS records the payment; it never charges a
card or moves money:

| Method | The cashier enters | Refund |
|---|---|---|
| Debit / Credit | the terminal approval code (credit: card brand, optional) | reverse it on the terminal |
| e-Transfer | the reference number from the deposit notification | send an e-Transfer back |
| Stripe | the Stripe payment id (`pi_…`) | refund in the Stripe dashboard |

**GST/HST report** (*GST/HST* tab, Admin and Manager). Pick a month, quarter, year
or custom dates (store time zone). It shows sales and tax by rate, refunds given
in the period, payments by method, and the two return lines:

* **Line 101** - sales and other revenue before tax, after refunds (zero-rated included)
* **Line 103** - GST/HST collected, net of the tax refunded in the period

*Export to Excel* writes the same figures (Summary, By tax rate, Payments).
Input tax credits (line 106) come from purchase invoices and are not included.

QA on test:

1. *Business*: tick e-Transfer and Stripe, set the e-Transfer e-mail, save.
2. Register: sell one item each by Debit, Credit (brand Visa), e-Transfer and
   Stripe; the receipt names the method and its reference.
3. Sales: refund the e-Transfer sale; the dialog says "Send this amount back
   ... by Interac e-Transfer".
4. *Report*: one row per method used.
5. *GST/HST*, *This month*: line 103 = tax on sales - tax refunded; export to Excel.
6. Sign in as a cashier or a Sales user: there is no *GST/HST* tab (the API answers 403).

## Screenshots worth taking

* GitHub: CD run graph, a PR with the four checks and the CODEOWNERS review,
  the tester's prod approval dialog, the Playwright report, the releases list.
* The POS on each environment (DEV / TEST / PROD badge): register, payment,
  receipt, daily report, GST/HST report.
* Portal: `rg-eurc-prod-cc`, staging slot, private endpoints, Application map, Alerts.
* Cloud Shell: `20-test-env.sh` totals and the `30-monitor.sh` snapshot.

## Finish: tear down

```bash
tmux new -s teardown
./scripts/99-teardown.sh            # add --github to remove the GitHub environments/variables too
```

Type `eURC` to confirm, then check **Cost Management** the next day.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `AADSTS700213: No matching federated identity record found` in *Azure login* | The subject must match exactly: `repo:<owner>/<repo>:environment:<env>`. Check `GITHUB_OWNER` / `GITHUB_REPO` in `config/eurc.env` (case matters), re-run `01-bootstrap-azure.sh`. |
| `AuthorizationFailed ... roleAssignments/write` on the first deploy | New role assignments can take a few minutes to apply. Re-run the failed job. If it persists, re-run `01-bootstrap-azure.sh`. |
| `Operation cannot be completed without additional quota ... Standard VMs` | Your subscription has no S1 quota in the region. Request a quota increase (portal → Quotas → App Service), or set `appServiceSku = 'B1'` and `enableStagingSlot = false` in `infra/env/prod.bicepparam` (no slot swap then). |
| `RequestDisallowedByPolicy` | The student subscription's allowed-locations policy excludes the region. Run `00-preflight.sh`, change `LOCATION` and `LOC_SHORT`, and the `locationShort` default in `infra/main.bicep`. |
| Smoke test stuck at `HTTP 503 Starting` | The app is waiting for the database. Portal → web app → **Log stream**, or `AppServiceConsoleLogs` in Log Analytics. `Login failed for user '<token-identified principal>'` means the identity is not SQL admin: re-run CD with *force_infra*. |
| Prod job never starts | It is waiting for your approval (orange clock). If there is no approval button, the prod environment has no reviewer: re-run `02-setup-github.sh`. |
| `git push` rejected: refusing to allow an OAuth App to create or update workflow | Run `gh auth refresh -s workflow`, then `git push`. |
| `20-test-env.sh` shows Key Vault 401 instead of 403 in prod | Public access is still enabled; re-run CD with *force_infra* and check the deployment's errors. |
| Playwright step fails with *Executable doesn't exist* | The runner image changed; the step installs Chromium with `npx playwright install --with-deps chromium` — re-run the job. Locally, run `npx playwright install chromium` in `tests/`. |
| A collaborator cannot approve a PR | They have not accepted the invitation, or they are the PR author. Code owners must review their own area (see `TEAM.md`). |
| Tester sees no *Review deployments* button | The tester was not a collaborator when step 02 ran. Re-run `./scripts/02-setup-github.sh`. |

## Slot swap failed: "application initialization ... took too long"

Production is unchanged when this happens. From v2.3.1 the pipeline swaps in
two phases (`.github/scripts/swap-slots.sh`), so the warm-up wait is ours (15
min) instead of App Service's. To finish or cancel a swap by hand:

```bash
RG=rg-eurc-prod-ncus; APP=app-eurc-web-prod-ncus-ats2j
STG=https://$(az webapp show -g $RG -n $APP --slot staging --query defaultHostName -o tsv)
az webapp deployment slot swap -g $RG -n $APP --slot staging --target-slot production --action preview
until curl -fsS -m 10 $STG/health/ready; do sleep 15; done   # staging now runs with production settings
az webapp deployment slot swap -g $RG -n $APP --slot staging --target-slot production --action swap
# or, to cancel: --action reset
```
