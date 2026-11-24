# PulseHook — a webhook SDK quickstart, run as a Flagsmith experiment

> **One-sentence hypothesis:** a pre-filled, live interactive sandbox (variant `interactive_sandbox`)
> will get more developers to a **successful first API call** than a copy-and-paste checklist
> (control `copy_checklist`) — **without** lowering the share of developers who export an SDK snippet.

Submission for **WeMakeDevs × Flagsmith — Toggle Wars, Track 01**.
Everything (Flagsmith, the flag, the experiment, the traffic, the results) runs on a
self-hosted Flagsmith 2.295.2 stack. **All traffic is simulated and disclosed as such.**

- Primary metric: `first_api_call_succeeded` (higher is better)
- Guardrail metric: `sdk_snippet_exported` (must not decrease)
- Flag: `quickstart_experience` — multivariate, 50 / 50, keys `control` and `interactive_sandbox`

---

## 1. The problem

A developer lands on a webhook product's quickstart page. Friction here is silent: they
skim, they copy half a snippet, they leave. The usual fix is a"redesign the whole page"
bet with no way to tell which half did the work.

PulseHook makes the choice falsifiable: one multivariate flag swaps the quickstart body
between two complete experiences, and the primary conversion is measured **in the product
itself** (a real `POST` that returns `200`), not by a proxy like scroll depth or clicks.

## 2. Architecture

```
                       ┌──────────────────────────────┐
   browser  ─────────▶ │  Express app  (port 3000)    │
   (visitor cookie)    │  SSR renders the variant,    │
                       │  so first paint == assigned  │
                       │  variant  (zero flicker)     │
                       └──────┬───────────────┬───────┘
                              │ getExperiment-│ trackEvent(
                              │ Flag(name,    │   '$flag_exposure'
                              │  visitorId)   │   automatically,
                              │               │   'first_api_call_succeeded',
                              │               │   'sdk_snippet_exported')
                              ▼               ▼
                    ┌──────────────────────────────────────┐
                    │ self-hosted Flagsmith  2.295.2       │
                    │  web :18000  task-proc :18001        │
                    │  PostgreSQL 17 (flagsmith db)        │
                    │  experimentation app:                │
                    │   flag + 2 metrics + 2 experiments   │
                    └──────────────────────────────────────┘
```

The same stable visitor id (`fs_visitor_id` cookie, `vis_<uuid>`) is used for flag
evaluation **and** for both conversion events — that is what makes exposure → conversion
joinable in Flagsmith's Bayesian engine.

## 3. What was built

| Path | Purpose |
| --- | --- |
| `docker-compose.yml` | Self-hosted Flagsmith web + task processor + PostgreSQL 17, experimentation enabled |
| `scripts/bootstrap-flagsmith.mjs` | Idempotent provisioning: org/project/env, multivariate flag, warehouse connection, both metrics, A/A and A/B experiments, then **starts** both |
| `src/flagsmith-client.js` | SDK wrapper: identity-based evaluation, variant-key normalisation, conversion tracking, resilient fallback |
| `src/server.js` | Express app: SSR quickstart, `GET /api/session`, `POST /api/v1/sandbox/ping`, `POST /api/v1/sdk/export`, `/audit`, `GET /api/audit`, `POST /api/admin/flush` |
| `src/public/` | The two quickstart experiences + the audit dashboard (warm-paper / charcoal, dark-mode aware) |
| `scripts/simulate-aa.mjs` | 400 visitors through the A/A twin experiment over real HTTP |
| `scripts/simulate-ab.mjs` | 1,200 visitors through the real A/B, persona-driven, deterministic seed |
| `scripts/verify-wiring.mjs` | 12 end-to-end wiring checks against the live stack |
| `scripts/capture-demo.mjs` | 5 screenshots at 1440x900 (DOM-asserted layout) + the demo recording |
| `tests/experiment.test.mjs` | 31 Vitest unit/integration tests |
| `docs/aa-results.json`, `docs/ab-results.json` | Raw results, including Flagsmith's own Bayesian payload |

## 4. Reproduce it

### 4.1 Prerequisites

- Node **>= 22**
- Docker (the compose file pulls `flagsmith/flagsmith:latest` and `postgres:17-alpine`)

### 4.2 Local self-hosted Flagsmith (what the submitted numbers came from)

```bash
cp .env.example .env          # set FLAGSMITH_ADMIN_PASSWORD (and the two "change_me" values)
docker compose up -d          # Flagsmith web :18000, task processor :18001, Postgres :5432
# first boot runs migrations; create the admin user once:
docker exec -it pulsehook_flagsmith \
  python manage.py createsuperuser --email admin@pulsehook.local --sign_up_type NO_INVITE
# put that same password into .env as FLAGSMITH_ADMIN_PASSWORD, then:

npm install
npm run bootstrap             # writes .env + flagsmith.env, starts both experiments
npm start                     # PulseHook on http://localhost:3000
npm test                      # 31 Vitest tests
npm run verify                # 12 live wiring checks
npm run simulate:aa           # 400 visitors  -> docs/aa-results.json
npm run simulate:ab           # 1,200 visitors -> docs/ab-results.json
npm run capture               # 5 screenshots + demo video
npm run secret-scan           # 0 hits across git-tracked files
```

`FLAGSMITH_ADMIN_PASSWORD` lives only in `.env` (gitignored) — the bootstrap script
refuses to run without it rather than falling back to a hardcoded default.

`npm run bootstrap` is safe to re-run: it reuses the org/project/env and only creates the
flag, metrics and experiments if they are missing. Because Flagsmith throttles results
recomputation to once per 5 minutes per experiment, `simulate:aa` / `simulate:ab` wait for
the refresh before reading inference.

### 4.3 Cloud mode (no Docker)

Point the same app at a hosted Flagsmith project:

```bash
FLAGSMITH_API_URL=https://edge.api.flagsmith.com/api/v1/
FLAGSMITH_EVENTS_URL=https://events.flagsmith.com/api/
FLAGSMITH_ENVIRONMENT_KEY=<your server-side environment key>
npm start
```

Create the `quickstart_experience` multivariate flag and the two metrics by hand in the
dashboard, then start the experiment. The app code does not change — only the two URLs.

## 5. The four wiring rules this project treats as fatal

These are the ways a Flagsmith experiment silently lies. Each has a dedicated check in
`npm run verify` and unit coverage in `npm test`.

1. **Stable visitor identity.** The same anonymous visitor must get the same variant on
   every reload, or the same person lands in both arms. We mint `vis_<uuid>` once, keep it
   in an HttpOnly `SameSite=Lax` cookie for 30 days, and reuse it for flag evaluation *and*
   both conversion events. → *20/20 reloads return the same variant.*
2. **Multivariate variation keys.** Flagsmith variation options need a non-empty `key`
   (`control` is reserved). Without it, exposures arrive with no variant and cannot be
   attributed. → *2/2 options keyed: `interactive_sandbox`, `control`.*
3. **Exposure → conversion join.** Conversions must never exceed exposures on either
   metric, and both must be filed under the same identifier. → *checked live against the
   Results API after a real event batch.*
4. **Real events reach Flagsmith.** The SDK must point at the self-hosted events API
   (`.../api/`), and the environment needs a `WarehouseConnection` whose config is
   `{"source": "flagsmith_database"}` — otherwise `POST /api/v1/events/` returns 404 and
   the experiment sits at zero conversions forever. Bootstrap asserts this.

Also verified: **SSR zero-flicker** (the HTML's `data-variant` equals `/api/session`'s
variant, so nobody sees the control page flash before the variant), and **offline
degradation** (with Flagsmith unreachable the app serves the control experience with
`isDefault: true` instead of a 500).

One more pitfall worth writing down: for identity-based experiments, evaluate via
`GET /api/v1/identities/?identifier=…`. The older `/api/v1/flags/?identifier=…` route
filters out identity-dependent segments and will hand every visitor the static value —
the experiment looks like it's running while every exposure is quietly `control`.

## 6. Results

All numbers below are **simulated traffic**, generated over real HTTP against the real
self-hosted stack, with a deterministic seed (`20261126`). They are not production data and
are labelled as such in the audit dashboard footer and in both JSON files.

### 6.1 A/A sanity — 400 visitors, identical pages

Two arms that render the *same* page must not differ. If they do, the wiring is broken.

| | control | aa_twin |
| --- | --- | --- |
| exposures (client) | 201 | 199 |
| exposures (Flagsmith) | 210 | 204 |
| primary conversions | 91 | 84 |
| guardrail conversions | 61 | 70 |
| primary CVR | 45.3% | 42.2% |

- SRM p-value **0.9203** — split is clean.
- Flagsmith primary inference: lift **-5.0%**, 95% CI **[-26.5%, +16.5%]**, chance-to-win **32.5%** — i.e. indistinguishable, exactly as it must be.
- Stable-identity mismatches: **0**.

Verdict: **wiring unbiased**. The A/A twin uses Flagsmith's assigned variation key
(`aa_twin` vs `control`) as its bucket identity while both arms render byte-identical
pages — otherwise the two arms would both report `copy_checklist` and no audit would be
possible.

### 6.2 A/B — 1,200 visitors, real assignment, real Bayesian read

| metric | control rate | variant rate | relative lift | 95% CI | chance to win |
| --- | --- | --- | --- | --- | --- |
| **primary** `first_api_call_succeeded` | 41.9% | 68.5% | **+63.7%** | **[+45.8%, +81.5%]** | **1.000** |
| **guardrail** `sdk_snippet_exported` | 32.7% | 25.0% | **-23.5%** | **[-37.2%, -9.7%]** | 0.0004 |

Exposures: control 597 / interactive_sandbox 604 (SRM p = 0.840).

Traffic mix: 35% *senior* developers, 45% *explorers*, 20% *impatient* — each persona has
its own conversion probabilities per arm. The sandbox helps everyone reach a first call,
but the impatient persona (and the export-hungry explorer) export the snippet far less
often, because the sandbox hands them a working call before they ever read the snippet.

## 7. The honest decision

**Do not ship `interactive_sandbox` at 100%.**

The primary metric wins decisively (+63.7%, CI well clear of zero, chance-to-win > 99%),
and Flagsmith's own dashboard agrees — it labels the variant a >99% winner. The guardrail
moves the other way with almost the same confidence (-23.5%, CI entirely below zero).

Shipping on the primary alone would trade "more developers succeed on their first call" for
"fewer developers leave with the SDK snippet in hand" — and the second is the leading
indicator of whether they come back. The dashboard therefore reports a **mixed** verdict
and a plan, not a green light:

1. **Build v2 of the sandbox with an auto-expanded export card.** Today the snippet export
   is a second, optional button; v2 surfaces it *inside* the success state so the two
   metrics stop competing.
2. **Keep control at 50%** until v2 clears the guardrail in a follow-up experiment.
3. **Never read this as a lift to production.** 1,200 simulated visitors buy a good story
   and a clean wiring proof, not a rollout decision.

This is deliberate: a submission that ships on a conflicted result is not an honest A/B
test, and the guardrail metric exists precisely to catch this shape of result.

## 8. Screenshots and demo

All at 1440x900, generated by `scripts/capture-demo.mjs`. Layout was verified by DOM
assertions (zero horizontal overflow, zero clipped elements, sane element heights) rather
than by eyeballing the images.

| # | File | Shows |
| --- | --- | --- |
| 1 | `docs/screenshots/1-control-checklist.png` | Control: copy-paste quickstart checklist, 3 steps + export |
| 2 | `docs/screenshots/2-variant-sandbox.png` | Variant: interactive sandbox after a live `200` |
| 3 | `docs/screenshots/3-audit-dashboard.png` | Audit: 4 wiring checks, A/A, both metrics, decision card |
| 4 | `docs/screenshots/4-flagsmith-ab-results.png` | Flagsmith A/B page: 1,201 enrolled, >99% winner, +63.7% |
| 5 | `docs/screenshots/5-flagsmith-aa-sanity.png` | Flagsmith A/A page: 414 enrolled, 68% (no winner) |

Demo recording: `docs/demo/toggle-wars-demo.mp4` (H.264, ~2.5 min) — walks control, the
sandbox, both Flagsmith experiment pages, and ends on the honest decision card.

## 9. Security and hygiene

- No secrets are committed. `.env`, `flagsmith.env`, `*.log`, recorded video and test
  artefacts are all gitignored; `.env.example` contains only placeholders.
- The app never echoes an admin token. The generated SDK snippets contain only the
  *client-side environment key*, never the server-side admin token.
- Logs mask keys to their first 6 characters.
- Flagsmith's dashboard routes need the **environment API key** (not the numeric id) in
  the URL — that mismatch is the source of the 403s you'll hit if you poke around by hand.

## 10. What this proves, and what it doesn't

**Proves:** the full loop works — a multivariate Flagsmith flag drives a real product
surface, exposures and two custom conversion events land under one stable identifier, and
Flagsmith's own Bayesian engine computes lift and credible intervals from them. The A/A
twin shows the wiring is unbiased; the A/B shows the harness can detect a real effect in
both directions, including one where the honest answer is "don't ship".

**Does not prove:** that `interactive_sandbox` will beat the checklist in production. The
traffic is simulated from explicit persona assumptions; running this against real visitors
is the next step, and the wiring checks are exactly what you'd re-run on day one.
