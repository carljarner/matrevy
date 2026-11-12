---
paths:
  - "wiki.html"
  - "js/wiki.js"
  - "css/wiki.css"
---

# Wiki (`wiki.html`/`wiki.js`, `data/wiki.json`, boss-level)

A flat chapter list, `{id, title, body, published?, attachments?}`. `body` is sanitized HTML limited to `WIKI_ALLOWED_TAGS` (`b/strong`, `i/em`, `u`, `ul`, `ol`, `li`, `p`, `br`, `h2`, `h3`): untrusted HTML is parsed into a **detached** `DOMParser` document (never executes, never attached) and rebuilt with allow-listed `createElement`/`createTextNode`, copying no attributes — no persisted-attribute XSS surface. `<a>` isn't allowed; links are auto-detected from text at render time. In-place editing: the chapter's pencil (`siteEditToggle`) swaps in an editable view with a `document.execCommand` toolbar (deprecated but the only no-dependency option). Attachments (`{id, name, path}`, pdf/tex, 5 MB) upload via the boss-level `upload` action to `wiki/<chapterId>/<attachmentId>-<slug>.<ext>` (`WIKI_ATTACHMENT_PATH_RE`). Server validation checks shape only (boss-only path). **Publishing**: `published` per chapter — revyster see unpublished chapters greyed (toast on click) and a "Siden er under opbygning" banner when nothing is published; the eye toggle in "Rediger kapitler" is admin-only client-side (server only checks boss + boolean). A scroll-spy table of contents (`setupWikiScrollSpy`) tracks headings. **"Rediger kapitler"** (`openManageChaptersModal`): draggable flat list + centered "+" appending `{id, title:'Nyt kapitel'}`; drop position shown as an orange line above the row (`.wiki-manage-row::before`, since the row's own border would hide a color change), plus a trailing `.wiki-manage-drop-tail`.


**Saving** (`siteSaveListResource`): same-chapter edits are last save wins, except the in-place chapter editor, which asks before overwriting a chapter someone else saved since editing started (`wikiConfirmOverwrite`). "Rediger kapitler" applies only its own order/adds/removals/title and publish changes, keeping chapters added by others (at the end). Editing something deleted meanwhile shows "… slettet af en anden".
