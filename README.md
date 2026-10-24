# eURC Point of Sale — Hands-on Project 02: Dev, Test, Production with DevOps CI/CD

A multi-store **Point of Sale** (React front end, Node.js API) running on Azure in
three isolated environments, built by **2 developers** and verified by **1 tester**,
and delivered by a GitHub Actions pipeline that **builds once and promotes the same
package dev → test → prod**, with automated gates, the tester's QA sign-off, a
zero-downtime slot swap and automatic rollback.

| Drawing (A3, draw.io + PDF in `docs/`) | Shows |
|---|---|
| `eURC_P02_Application_Architecture_A3` | React screens and components, Express API layers, data model, checkout and sign-in flows |
| `eURC_P02_DevOps_Architecture_A3` | Team and roles, branching and reviews, CI, CD stages and gates, QA sign-off, rollback, tooling |
| `eURC_P02_Azure_Architecture_A3` | The three Azure environments, networking, identity, security, monitoring and cost |

Guides: [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (lab steps) · [`docs/TEAM.md`](docs/TEAM.md) (roles, reviews, Definition of Done).

## 1. The application

| | |
|---|---|
| Front end | React 19 single-page app (Vite 8): sign-in / create store, **Register** (product grid, cart, cash and card payment, receipt), **Sales** (history, receipt, refund), **Products** (catalogue, stock), **Report** (daily totals), **Staff** (cashiers and managers) |
| API | Node.js 22, Express 5: stores, users with roles, products, sales (server-side pricing, all-or-nothing stock update), refunds, daily report, health |
| Data | Azure SQL (stores, users, products, sales, sale lines), Blob Storage (receipts as JSON), Key Vault (session-signing key) — all through a managed identity |
| Security | scrypt password hashes, HMAC-signed 8-hour sessions, manager/cashier roles, per-store isolation, CSP and security headers, rate-limited sign-in; card payments record only the terminal approval code (no card data) |
| Tests | API: 31 unit/HTTP tests · React: 17 component and app tests · pipeline suites: smoke 8, integration 13, load gate, Playwright E2E (desktop + tablet) |

Run it locally: `cd app && npm ci && npm run dev` and `cd web && npm ci && npm run dev`,
then open <http://localhost:5173> (demo store `demo`, `manager@demo.test` / `Password123`).

## 2. The three environments

| | **dev** | **test** | **prod** |
|---|---|---|---|
| Resource group | `rg-eurc-dev-cc` | `rg-eurc-test-cc` | `rg-eurc-prod-cc` |
| App Service plan | B1 Linux | B1 Linux | **S1** Linux + **staging slot** |
| Azure SQL / Storage / Key Vault | Entra ID only, no shared keys | same | same + **private endpoints**, public access **disabled**, ZRS storage |
| Monitoring | Log Analytics + App Insights | same | same + 6 metric alerts, availability test, slot-swap alert |
| Deploys | automatically on every merge | automatically after dev | after the **tester's approval**, staging slot → swap |
| Gates | smoke | smoke, integration, load, **Playwright E2E** | staging smoke, verify, post-deploy gate, auto-rollback |

## 3. Pipeline and team

```
feature branch ─► PR ─► CI: app · web · infra · scripts ─► review (other developer / tester for tests/) ─► merge
merge ─► build once ─► dev ─► test (integration, load, E2E) ─► ⏸ QA sign-off (tester) ─► prod: staging → swap → gate ─► release
```

* **No secrets anywhere:** GitHub signs in to Azure with OpenID Connect, one identity
  per environment, each limited to its own resource group.
* **Separation of duties:** developers own `app/`, `web/`, `infra/`; the tester owns
  `tests/` and approves production; the lead and tester own the pipeline. Nobody
  approves their own pull request or their own production run.

## 4. Repository layout

```
app/        Node.js API (Express 5) + migrations + unit tests
web/        React front end (Vite) + component tests
tests/      tester-owned suites: smoke, integration, load, Playwright E2E
infra/      Bicep: one environment per resource group; env/*.bicepparam
.github/    workflows (ci, cd, reusable deploy, rollback), deploy-infra action,
            CODEOWNERS, PR and issue templates
scripts/    Cloud Shell: 00 preflight · 01 Azure · 02 GitHub + team · 03 harden ·
            20 environment tests · 30 monitor · 99 teardown
config/     eurc.env — the only file you edit (owner, DEV1, DEV2, TESTER, alert e-mail)
docs/       three architecture drawings, report, runbook, team guide
```

## 5. Quick start (Azure Cloud Shell)

```bash
unzip eurc-p02-cicd-kit.zip && cd eurc-platform
nano config/eurc.env                 # GITHUB_OWNER, DEV1, DEV2, TESTER, ALERT_EMAIL
gh auth login -s workflow
./setup.sh                           # preflight → Azure → GitHub team setup → first push
```

About **USD 4.90 per day** with everything running. Tear down with `./scripts/99-teardown.sh`.
