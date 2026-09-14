# Matematikrevyen – Multi-Tenant Platform Roadmap

## Top-Level Overview

Speculative roadmap for turning the single-tenant `matematikrevy.dk` codebase into a
platform other student revues could run their own isolated instance of: one underlying
codebase, each revy ("tenant") gets its own data, branding, and choice of which tools are
enabled, provisioned through a setup wizard rather than a source-code fork.

**Status of this file**: parked. Written 2026-08-28 after a discussion of feasibility, cost,
and shape — no code exists yet, nothing below is started. Revisit after the fall production,
once the current single-tenant feature set has been fully exercised in practice.
`matrevy-plan.md` remains the only active roadmap until then.

## Why not a git branch/fork per revy

The tempting model — give each revy their own branch or fork of the repo — was considered
and rejected. Every bug fix or feature built afterward would need to be cherry-picked or
merged into N branches, and any revy that customized theirs makes that merge conflict-prone.
A year in, that's not one product with N customers, it's N slowly-diverging products that
happen to share ancestry. A **setup wizard** implies configuration, not forking source: one
codebase, one deployment, and a tenant identifier that scopes every read/write — the wizard's
job is "create a tenant record + seed default data," never "cut a branch."

## Architecture Decisions (recommended, to revisit before Phase 0)

- **This is a genuinely different project, not an increment.** It trades the current
  deliberate simplicity (no build step, no server framework, no database — anyone can read
  the source and understand the whole system) for real infrastructure (database, tenant
  model, provisioning) in exchange for supporting multiple organizations cleanly. Worth it
  if the goal is "other revys use this as a product"; probably not worth it for just one or
  two extra groups, where duplicating the repo + duplicating the Simply.com deployment (no
  shared-codebase gymnastics, just N fixed, small deployments) is genuinely less total work.
- **Tenant resolution**: by subdomain (`revy1.matrevy.dk`, `revy2.matrevy.dk`), resolved
  server-side before any of today's access-level gating (`site.js`'s `SITE_PAGES` /
  `applyPageGate()`) even runs.
- **Data layer**: replace the GitHub-embed pipeline (`scripts/embed-scenes.js` +
  `.github/workflows/embed-scenes.yml`, which regenerates `*-data.js` globals from
  `data/*.json` and is why a public-data save takes ~1-2 minutes to propagate today) with a
  real multi-tenant database — every table gets a `tenant_id`. This is the actual latency win
  of paying for a server: not "servers are faster than GitHub Pages," but "stop using git
  commits as the database," which removes the propagation delay and the 5-minute
  optimistic-override hack (`SITE_OVERRIDE_TTL_MS` in the data-driven-page convention) that
  exists specifically to paper over it.
- **Private tools are the smaller lift**: Budget already namespaces its data per `budgetId`
  (`BUDGET_DATA_DIR/<budgetId>/...`, `server/update-data.php`'s `budget_resolve_budget_id()`).
  Generalizing that pattern into a real per-tenant directory (or per-tenant DB rows) for
  Budget/Forms/Sheets is a much smaller, lower-risk step than the public-data rewrite, since
  these already go through per-resource server actions rather than the embed pipeline.
- **Auth**: keep the existing lightweight shared-password-per-level model (public/revyst/
  boss/admin) rather than building real per-user accounts — just scope the three passwords
  per tenant instead of globally, consistent with "shared passwords, not real auth" already
  being a documented, accepted trade-off. Real per-user login stays a `matrevy-plan.md`
  "Later / parked" item, orthogonal to this effort.
- **Feature selection (tool picking)**: a tenant config record carries an `enabledTools`
  list; nav/page rendering checks it alongside the existing access-level rank. This composes
  naturally onto `SITE_PAGES` — the site already centralizes "what pages exist and who can
  see them" in one place, so this is additive, not a redesign. It's the cheap part of the
  vision and doesn't reduce the scope of the data-layer/auth work above it.
- **Infra**: move off GitHub Pages (static-only, no server-side tenant resolution) + Simply.com
  flat-file PHP for the parts that become tenant-scoped. A real backend (could stay simple)
  plus a managed Postgres (e.g. Supabase/Neon) or a lighter edge option (Cloudflare
  Workers + D1) fits better than either current host once "which tenant is this request for"
  has to be resolved server-side before anything else.

## Phases

### Phase 0 — Decide platform & infra foundation

**Intent**: lock in the concrete choices the rest of the work depends on, before writing
any tenant-aware code.

**Expected outcomes**: hosting/backend stack chosen; tenant-resolution strategy chosen
(subdomain vs. path); confirm the "one shared deployment" model over per-tenant
deployments; a minimal "hello tenant" prototype (resolve tenant from request, nothing else)
proving the chosen infra actually works end-to-end.

**Status**: [ ] not started

---

### Phase 1 — Tenant model & config-driven feature flags

**Intent**: introduce the tenant concept and the "which tools are enabled" layer first,
since it's additive on top of the existing `SITE_PAGES`/`applyPageGate()` gate and can be
proven against a single default tenant before the data-layer rewrite exists.

**Expected outcomes**: a tenant config shape (`{tenantId, enabledTools, branding, ...}`);
`SITE_PAGES` gating extended to also check the current tenant's `enabledTools`, alongside
the existing access-level rank; still backed by today's single-tenant data underneath.

**Status**: [ ] not started

---

### Phase 2 — Auth & credentials per tenant

**Intent**: move the three shared passwords from global (`config.php`) to per-tenant.

**Expected outcomes**: login flow resolves tenant first, then validates against that
tenant's three passwords; `getSiteAuth()`/`SITE_LEVEL_RANK`-style logic in `site.js` and
`password_level()` in `server/update-data.php` become tenant-scoped.

**Status**: [ ] not started

---

### Phase 3 — Private-tool data migration (Budget / Forms / Sheets)

**Intent**: the lowest-risk data-layer step — generalize Budget's existing `budgetId`
namespacing into full tenant scoping, and retrofit Forms/Sheets (which today have no
per-instance namespacing at all) to match.

**Expected outcomes**: `BUDGET_DATA_DIR`/`FORMS_DATA_DIR`/`SHEETS_DATA_DIR` (or their DB
equivalents) keyed by tenant; every `$BUDGET_ACTIONS`/`$FORMS_ACTIONS`/`$SHEETS_ACTIONS`
handler resolves tenant before resolving budget/form/sheet id.

**Status**: [ ] not started

---

### Phase 4 — Public data & backend rewrite (the big one)

**Intent**: replace the GitHub-embed pipeline for scenes/cast/calendar/wiki/posts/archive
with tenant-scoped database reads/writes — the core of the rewrite, and the part that
actually removes the current 1-2 minute save-propagation delay.

**Expected outcomes**: a real database schema for these resources, tenant-scoped; the
front-end's embedded-global convention (`<script src="scenes-data.js">` etc.) replaced by
live tenant-scoped API calls; `scripts/embed-scenes.js` and `embed-scenes.yml` retired (or
kept only if a hybrid/static-per-tenant approach is chosen in Phase 0 — decide there, not
here); existing production data migrated into "tenant 1" as part of this phase.

**Status**: [ ] not started

---

### Phase 4.5 — Live push (optional, not yet scoped into Phase 4)

**Intent**: Phase 4 only removes save-*propagation* latency (a reload sees fresh data
instantly) — it does not make other people's already-open tabs update without a reload.
That's a separate feature, additive on top of Phase 4's database, not a side effect of it.
Worth tracking explicitly so it isn't assumed to come for free.

**Scope**, once Phase 4's backend exists:
- **Transport**: SSE for one-way server→client push covers nearly every case here
  (reflecting someone else's edit, not live co-editing); WebSockets only needed for
  bidirectional cases (presence, cursors). Given how few concurrent coordinators there
  ever are, even a few-second poll could be an acceptable cheap first cut requiring no new
  infra.
- **Fan-out**: server tracks which clients are subscribed to which tenant/resource and
  notifies on change. Free if the Phase 0 backend choice is Postgres-based (e.g. Supabase
  Realtime pushes table changes out of the box); a hand-rolled backend would need to build
  this itself.
- **Client-side re-render**: the real work, page by page. Most data-driven pages already
  follow a "rebuild from data → render" pattern (e.g. `schedule.js`'s
  `renderGrid()+renderSceneSidebar()+saveState()` flush sequence), so wiring "new data
  arrived, re-run render" is evolutionary — but every data-driven page (Kalender, Wiki,
  Posts, Manus, Budget, Forms, Fællesspisning...) needs that wiring individually, there's
  no one shared choke point for it today.
- **Conflicts**: doesn't need CRDTs/OT. "Someone else wrote, here's fresh state, re-render
  (retry if your own pending write just went stale)" is sufficient given real usage is a
  handful of infrequent coordinators, not simultaneous character-level editing.

**Expected outcomes**: a chosen push transport; at least one page (Kalender or Posts are
the best candidates — most likely to have two boss/revyst users active at once) wired end
to end as proof; a documented pattern for wiring up the rest incrementally afterward.

**Status**: [ ] not started

---

### Phase 5 — Setup wizard (provisioning)

**Intent**: build the actual onboarding flow once there's a real tenant/data model for it
to provision against.

**Expected outcomes**: an admin-only (cross-tenant) wizard: pick `enabledTools`, set
branding/categories, generate the tenant's three passwords, seed empty/default data only
for the tools chosen. Conceptually similar in spirit to Koordinator's existing
"Afslut produktionsår" sequential-save flow (`js/koordinator.js`) — a provisioning
action is likewise a sequence of straightforward creates/seeds, not a bespoke transaction.

**Status**: [ ] not started

---

### Phase 6 — Cutover & first external tenant

**Intent**: prove the whole system with a second real organization, not just the migrated
original.

**Expected outcomes**: `matematikrevy.dk`'s own data confirmed live as tenant 1 under the
new system; a second real revy onboarded through the wizard end-to-end; GitHub
Pages + Simply.com decommissioned for production data (GitHub kept for code hosting/CI
only).

**Status**: [ ] not started

---

## Open questions to resolve before starting (Phase 0)

- Subdomain vs. path-based tenant routing — and what that means for custom domains per revy
  later.
- Concrete backend + database choice (cost, ops burden, how much of the "no build step, no
  server framework" simplicity is worth preserving vs. trading away).
- Whether a handful of tenants is better served by this full rewrite at all, vs. just
  duplicating the current single-tenant repo + Simply.com deployment per revy (cheaper up
  front, more ongoing manual work per tenant, no shared-improvement problem since there's no
  shared codebase to diverge).
- Data migration plan for the current site's real production data into "tenant 1."
- Whether per-tenant custom branding/theming goes beyond `SITE_PAGES`/categories into
  actual visual re-theming (colors, logo) — scope not discussed yet.
- Backup/durability story for the new database, mirroring the still-open "no off-host backup"
  gap already tracked for Budget's private data in `matrevy-plan.md`.
