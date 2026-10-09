# Matematikrevyen – Multi-Tenant Platform Roadmap

## Top-Level Overview

Speculative roadmap for turning the single-tenant `matematikrevy.dk` codebase into a
platform other student revues could run their own isolated instance of: one underlying
codebase, each revy ("tenant") gets its own data, branding, and choice of which tools are
enabled, provisioned through a setup step rather than a source-code fork.

**Status of this file**: parked. First written 2026-08-28; revised 2026-10-04 after the
move to web-1 (Hetzner + Coolify, see CLAUDE.md / README.md), which invalidated several of
the original premises (see "What changed with web-1"). No code exists yet, nothing below is
started. Revisit after the fall production, once the current single-tenant feature set has
been fully exercised in practice.

## Why not a git branch/fork per revy

The tempting model — give each revy their own branch or fork of the repo — was considered
and rejected. Every bug fix or feature built afterward would need to be cherry-picked or
merged into N branches, and any revy that customized theirs makes that merge conflict-prone.
A year in, that's not one product with N customers, it's N slowly-diverging products that
happen to share ancestry. Tenants must differ by **configuration and data**, never by
source: one codebase, one `main` branch.

## What changed with web-1 (2026-10-02)

The 2026-08-28 version of this plan assumed GitHub Pages + Simply.com + git-commits-as-
database, and argued for a real backend + database mainly to fix that setup. Since the move:

- **The propagation-delay argument is gone.** Saves go to local disk (`github_api()` is now
  a local-disk stand-in) and are visible on the next page load within ~3 s; the GitHub embed
  workflow is retired and `SITE_OVERRIDE_TTL_MS` is down to 30 s. A database is no longer
  needed for speed — it has to justify itself on other grounds (cross-tenant queries, real
  conflict detection, running on more than one host).
- **"Move off static hosting" is done.** Every request already passes through Apache/PHP on a
  server we control, so server-side tenant resolution is possible today without new infra.
- **Coolify makes a third deployment model cheap** (below), which the original plan's
  fork-vs-rewrite framing didn't have.

## Deployment models

| | A: Per-tenant deployment (recommended first) | B: One shared app + database |
|---|---|---|
| Shape | One Coolify Compose app **per tenant**, all built from the same repo `main` | One deployment; every row/file scoped by `tenant_id` |
| Code divergence | None — one push redeploys every tenant | None |
| Isolation | OS/container-level: a tenant's data dir is the only one mounted | Application-level: a missed tenant filter leaks across tenants |
| Code change needed | Small (see Phase 1) | Large (Phase 4: data layer rewrite) |
| Per-tenant cost | One `web` + one `worker` container (image layers shared; worker idle almost always) | ~zero |
| Backup / restore / delete one tenant | One folder | Per-tenant queries/exports |
| Breaks down at | Tens of tenants (RAM, Coolify UI sprawl, manual provisioning) | Scales to hundreds; needed for cross-tenant features or multi-host HA |

**Recommendation**: start with **A**. It reuses today's architecture almost unchanged and
keeps the "no build step, no server framework, no database — anyone can read the whole
system" property. Move to **B** only when tenant count, cross-tenant features or
availability requirements actually demand it. A rough, unmeasured estimate: 10–20 tenants
fit on a mid-size Hetzner VPS before resizing (a one-click vertical scale) or sharing one
worker across tenants becomes necessary.

## Architecture Decisions (recommended, to revisit before Phase 0)

- **Tenant resolution (model A)**: implicit — each deployment *is* one tenant, so no
  request-level resolution is needed. Traefik routes by `Host` to the right deployment.
  (Model B would resolve by subdomain or `Host` server-side before any of `site.js`'s
  `SITE_PAGES`/`applyPageGate()` gating runs.)
- **Domains**: either each revy's own domain, or subdomains of a platform domain
  (`revy2.matrevy.dk`). Per-subdomain certificates work with Traefik's default HTTP-01
  challenge; a **wildcard** certificate needs DNS-01 via the DNS provider's API, which Simply
  likely doesn't support in Traefik — that would mean moving the platform domain's DNS to
  Cloudflare or Hetzner DNS.
- **Data layer (model A)**: unchanged — each tenant gets `/srv/<tenant>/data/{site,budget,
  forms,faellesspisning}`, mounted at `/data` exactly as matrevy's is today. Flat JSON +
  `flock` is fine at per-revy scale.
- **Auth**: keep the shared-password-per-level model (public/revyst/boss/admin). In model A
  the three passwords are simply each deployment's own Coolify env vars — already
  tenant-scoped with zero code. Real per-user login stays orthogonal to this effort.
- **Feature selection (tool picking)**: an `enabledTools` list in the tenant's
  `data/config.json`; `site.js` checks it alongside `SITE_LEVEL_RANK` when rendering
  `SITE_PAGES`, and `update-data.php` refuses actions for disabled tools. Additive, not a
  redesign.
- **Archive mirror**: today `worker.sh` pushes `archive/` to this repo. Per tenant it must
  be off (empty `ARCHIVE_SYNC_DEPLOY_KEY`) or point at the tenant's own repo (needs the
  target repo to become an env var).
- **GDPR**: hosting other revues' personal data (names, phone numbers, receipts) makes the
  operator their **data processor** — needs a data processing agreement
  (databehandleraftale) per tenant and a defined tenant-deletion procedure. Model A makes
  deletion and per-tenant restore a single folder.

## Phases

### Phase 0 — Decide the model & prove it

**Intent**: lock in the choices the rest depends on before writing tenant-aware code.

**Expected outcomes**: model A vs. B confirmed; domain strategy (own domains vs. platform
subdomains, and if wildcard, where DNS lives); a throwaway second Coolify deployment of the
current repo on a test domain with its own `/srv/<tenant>/data`, proving two instances run
side by side on web-1 without interfering (ports, data, worker, archive mirror off). Measure
real RAM/disk per instance to replace the estimate above.

**Status**: [ ] not started

---

### Phase 1 — De-hardcode the single tenant

**Intent**: make the repo deployable as a different revy purely through config, with
matematikrevy.dk as the first instance and no behaviour change for it.

**Expected outcomes**:
- `SITE_API_ENDPOINT` → plain `/update-data.php` and CORS → same-origin (already on the
  migration cleanup list).
- Archive-mirror target repo as an env var in `worker.sh`.
- Branding from config: ~50 `matematikrevy` references across HTML titles, JS, PHP and
  scripts, plus the LaTeX templates used by `generate-pdfs.js`.
- A first-run seed: every `data/*.json` and `program.json` must exist before the first save
  (`update_file()` has no create-if-missing), so a fresh instance needs a seed script or a
  create-if-missing branch.

**Status**: [ ] not started

---

### Phase 2 — Tool selection (`enabledTools`)

**Intent**: let a tenant turn tools on/off.

**Expected outcomes**: `enabledTools` in `config.json`; `SITE_PAGES` rendering,
`applyPageGate()` and `injectSitePrefetchLinks()` respect it; `update-data.php` rejects
actions/resources of disabled tools; admin UI to toggle them (Koordinator).

**Status**: [ ] not started

---

### Phase 3 — Provisioning

**Intent**: make onboarding a revy a repeatable procedure, not an afternoon of clicking.

**Expected outcomes**: first a documented checklist (DNS record, Coolify app from the repo,
env vars incl. three generated passwords, data dir + seed, backup coverage — restic already
backs up all of `/srv`); later, if tenant count warrants it, a script against Coolify's API.
Conceptually like Koordinator's close/start-year flow: a sequence of idempotent creates.

**Status**: [ ] not started

---

### Phase 4 — First external tenant

**Intent**: prove the whole system with a second real organization.

**Expected outcomes**: a second revy onboarded end-to-end via Phase 3; data processing
agreement signed; one full production cycle (uploads → Manus → PDFs → close year) run on it.

**Status**: [ ] not started

---

### Phase 5 — Shared app + database (model B; only if needed)

**Intent**: consolidate into one deployment when model A's limits are actually hit — tens
of tenants, cross-tenant features (e.g. a shared revy-archive), or a need for multi-host
availability.

**Expected outcomes**: a tenant-scoped schema (Postgres; managed or self-hosted on Coolify)
for public and private data; tenant resolved from `Host` before any gating; passwords per
tenant in the database instead of env vars. Private tools are the smaller lift — Budget
already namespaces per `budgetId` (`budget_resolve_budget_id()`), and Forms/Fællesspisning
go through per-resource server actions. Public data is the big part: the embedded-global
convention (`<script src="scenes-data.js">`) either becomes live API reads or stays as
per-tenant generated files (decide then; the latter keeps `file://` offline mode). Existing
instances migrated in one at a time.

**Status**: [ ] not started

---

### Phase 5.5 — Live push (optional, independent of the model)

**Intent**: make other people's already-open tabs update without a reload. Neither model
gives this for free.

**Scope**: SSE for one-way server→client push covers nearly every case (WebSockets only for
presence/cursors); a few-second poll is an acceptable no-infra first cut given how few
concurrent coordinators there are. The real work is client-side: every data-driven page
needs "new data arrived → re-render" wiring individually (most already follow a
rebuild-from-data → render pattern). No CRDTs/OT needed — "someone else wrote, here's fresh
state, re-render" suffices. Pairs naturally with the "Edit conflicts are last-save-wins" fix
in CLAUDE.md (send the loaded `sha`, 409 on mismatch).

**Expected outcomes**: one page (Kalender or Posts) wired end to end, plus a documented
pattern for the rest.

**Status**: [ ] not started

---

## Open questions to resolve before starting (Phase 0)

- Is there real demand from other revues, and how many? A handful favours model A firmly.
- Domain strategy: each revy's own domain vs. platform subdomains — and if wildcard, moving
  the platform domain's DNS off Simply.
- Who operates it: is the maintainer willing to be data processor (GDPR) and on-call for
  other organizations? What happens to tenants if the maintainer steps away?
- Branding scope: names/titles/LaTeX only, or full visual re-theming (colors, logo)?
- Which matrevy-specific conventions (Danish UI, `revy.sty`, act codes 1/2/3/E, Stjerneark,
  Fællesspisning) are actually shared by other revues, and which need to become config?
- Single-VPS availability: acceptable for other organizations, or does onboarding them
  raise the bar to a standby server / documented rebuild time?
