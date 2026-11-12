---
paths:
  - "index.html"
  - "js/posts.js"
  - "js/bosses.js"
---

# Forside (`index.html`): Posts + Bosser

**Posts** (`data/posts.json`, `posts.js`): a Facebook-style board, pinned first then date-desc (`renderPostFeed()` re-sorts the whole array). Anonymous visitors see "Log ind for at se opslag". Shows the last `POSTS_INITIAL_MONTHS` (6) months plus every pinned post; "Indlæs en måned mere" widens the window by a month. Each post is `{id, pinned, date, author, title, text, image, comments}` — `title` optional (shown as a small tag), dates are floating local timestamps. `text` is rich text sanitized like Wiki (`POST_ALLOWED_TAGS`, `renderSanitizedPostBody`); legacy plain-text posts (`postLooksLikeHtml` false) go through the line-split + auto-link path. `image` is uploaded inline at creation (`posts/<id>/image.jpg`) and can't be replaced from the edit modal. Pinning is a pin-icon toggle (`togglePinned`). **Three write paths, one file**: `posts_create`/`comments_create` are revyst-level **append-only** actions (server assigns `id`/date; posts always start `pinned:false`); editing/deleting posts/comments and pinning go through the boss full-array `siteSaveResource('posts', …)`. `postsApi()` is its own any-level authenticated helper for the append-only actions.

**Bosser** (`data/bosses.json` = `{title, roles:[{names, role}]}`, `BOSSES_DATA`, `bosses.js`, **admin** `bosses` resource): Forside's right-hand card. Admin's pencil in the card head switches the card to inline editing (title + rows editable with the inline field style, draggable rows, a centred "+" below); the pencil becomes a check mark that saves and leaves edit mode, like Koordinator's logins card (nothing changed → just leaves; a failed save stays in edit mode with the error under the "+"; `beforeunload`/`siteRegisterUnsavedCheck` warn while the draft differs). Fully blank rows are dropped on save. Drag ghost shows the role title; the drop zone is the whole `<ul>` (`.boss-list-editing` padding). In-memory-only shadow (no `siteLoadOverride`).


**Posts saving**: edits go through `siteSaveListResource` (live re-read + `baseSha`, retried on 409); an edit keeps the live `pinned`/`comments`.
