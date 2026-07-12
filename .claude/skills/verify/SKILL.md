---
name: verify
description: How to run and verify the MatRevy static site locally (serve + headless-browser drive).
---

# Verifying MatRevy changes

Static site, no build step. Verification = serve it and drive it in a browser.

## Serve

```bash
python3 -m http.server 8741 --bind 127.0.0.1   # from the repo root, background it
```

`file://` also works (open the .html directly) and is itself a supported mode
worth testing — `site.js` skips all login UI and grants synthetic admin there.

## Drive (headless)

Playwright lives in the npx cache, not global node_modules — require it by path:

```js
const pw = require('/Users/carljarner/.npm/_npx/361ceb562f3b3235/node_modules/playwright');
// mobile: await browser.newContext({ ...pw.devices['iPhone SE'] })  → matchMedia '(hover: hover)' is false
// desktop: { viewport: { width: 1280, height: 800 } }               → hover: hover is true
```

Gotchas learned:
- Hover-effect assertions must wait ~300 ms after `.hover()` — most buttons have
  `transition: background 0.15s`, so an immediate `getComputedStyle` reads the
  pre-transition value and looks like a false negative.
- `waitForLoadState()` after clicking a link resolves immediately on an
  already-loaded page — assert on `page.url()` after `waitForURL()` or screenshot
  instead.
- Simulate a logged-in user with
  `ctx.addInitScript(() => localStorage.setItem('matrevy-auth', JSON.stringify({ level: 'admin', password: 'x' })))`
  — real login needs the live PHP endpoint and a real password.
- Headless mobile Chromium paints a teal focus highlight on programmatically
  focused elements; it's UA chrome, not site CSS (now suppressed by the global
  `-webkit-tap-highlight-color: transparent`).

## What to check per flow

- Site shell: hamburger ≤719px / inline nav ≥720px (boundary-test both),
  overlay open/close (✕, Escape, link tap), scroll lock, login modal stacking.
- Collect `pageerror`/console-error events on every page you load —
  the site has no test suite, so a JS exception is the main regression signal.
- Hover audit after CSS changes: every `:hover` outside archive.css's
  reduced-motion block must sit inside `@media (hover: hover)`.
