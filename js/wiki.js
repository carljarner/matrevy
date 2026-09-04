/* =========================================================
   Matematikrevyen – Wiki (wiki.html)
   Renders WIKI_DATA (embedded from data/wiki.json) as a two-column
   "chapters + content" view, mirroring Forside's dashboard-columns
   grid (same 2:1 ratio, mirrored: chapters is the smaller column).
   Each chapter is a single continuous rich-text record
   ({id, title, body}) — a clickable link in the left column;
   clicking one re-renders the right column with that chapter's
   rendered body. The selected chapter also gets an inline outline of
   its own Overskrift 1 (H2) sections beneath its button, click-to-scroll.
   Boss/admin get a "Rediger kapitler" button at the bottom of the left
   column (opens a modal to add new chapters and reorder the whole list
   via drag-and-drop) and, per chapter, a top-right "Rediger" button
   that swaps the read view for an in-place rich-text edit view (title
   input + formatting toolbar + contenteditable body) — no modal, same
   position on the page. Delete lives inside that edit view's action row.

   Each chapter also carries a `published` flag (default false/unset),
   toggled per row inside the "Rediger kapitler" modal — coordinators
   write chapters long before they're ready to show them off, so writing
   and publishing are separate steps. Boss/admin always see every chapter
   regardless of `published`. A revyst-level visitor sees the full chapter
   list (so they know what exists) but can only open a published one —
   unpublished titles render greyed-out (same visual treatment as a
   locked nav item) and, since they're still clickable, show a brief
   "not written yet" toast instead of opening. If nothing is published
   yet, the revyst-level view collapses to a single banner card instead
   of the two-column layout (renderWikiNoPublishedChapters).

   Metadata saves globally via siteSaveResource ('wiki' resource,
   whole-array replace like every other data-driven page).

   Rich-text storage/rendering: `body` is a sanitized HTML string
   (bold/italic/underline/lists/h2/h3/p only — see WIKI_ALLOWED_TAGS).
   This is a deliberate, scoped exception to the site-wide "DOM is
   built via createElement/textContent only, never innerHTML" rule —
   the exception is made safe by never assigning untrusted HTML to
   `.innerHTML` on a *live* document node. Stored/typed HTML is only
   ever parsed via `DOMParser` into a fully detached document, then
   walked and rebuilt one allow-listed element at a time via
   createElement/createTextNode into the live DOM (renderSanitizedBody)
   or into a detached scratch node whose OWN innerHTML we then read
   back (sanitizeHtmlString) — at no point does raw/untrusted markup
   reach a live node's innerHTML setter. Links are deliberately never
   stored as <a> markup — appendTextWithLinks re-detects plain-text
   URLs at render time only, so a stray pasted <a> just becomes plain
   text on save and gets re-linkified on the next render (idempotent,
   no persisted-attribute XSS surface).
   ========================================================= */

'use strict';

const WIKI_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Outline click-to-scroll and scroll-spy activation share one offset: the
// sticky site header (56px) plus a landing gap in the middle of the
// requested 75–100px "below the navbar" band. Sharing the constant means a
// clicked heading lands exactly where the spy considers it "active", so its
// own outline item is highlighted immediately rather than a neighbour's.
const WIKI_OUTLINE_OFFSET = 56 + 88;

// A landing exactly at WIKI_OUTLINE_OFFSET sometimes lands a hair below it
// (sub-pixel rounding in smooth-scroll's final position), which fails the
// scroll-spy's `<= WIKI_OUTLINE_OFFSET` check and leaves the just-clicked
// item unhighlighted. Scrolling 5px further (landing 5px higher) gives it
// enough margin to always register as active.
const WIKI_OUTLINE_CLICK_EXTRA = 5;

// Matches .wiki-chapters' sticky `top` in wiki.css (56px header + 20px
// resting gap) — the y-position the left column already rests at once
// scrolled past it. Switching chapters scrolls the page so the new
// chapter's content top lands at this same y — the left column, already
// stuck there via position: sticky, visually doesn't move at all; only the
// right column "jumps" to the top of the newly selected chapter.
const WIKI_SIDEBAR_STICKY_TOP = 76;

// Deliberately `behavior: 'instant'`, not 'smooth': switching from a long
// chapter to a much shorter one shrinks the document out from under the
// current scroll position, so the browser itself snaps scrollY to the new
// (smaller) max instantly, un-animated, the moment the shorter content is
// rendered — before this call ever runs. A 'smooth' scrollTo from there
// only animates the short remaining hop to the real target, so the visible
// result was an instant snap immediately followed by a separate glide —
// exactly the "jumpy" two-step motion. Making our own correction instant
// too collapses both into one atomic, un-animated jump — a clean chapter
// switch, matching how switching pages/documents normally behaves.
function scrollWikiContentToSidebarTop() {
  const contentBody = document.getElementById('wiki-content-body');
  if (!contentBody) return;
  const targetY = window.scrollY + contentBody.getBoundingClientRect().top - WIKI_SIDEBAR_STICKY_TOP;
  window.scrollTo({ top: Math.max(targetY, 0), behavior: 'instant' });
}

// ── Data (with a localStorage-backed shadow after a save) ────
let wikiOverride = siteLoadOverride('wiki');

function getEffectiveChapters() {
  return wikiOverride || WIKI_DATA;
}

// Which chapter is shown in the right column, and whether it's
// currently being edited in place — kept outside render() so both
// survive a re-render. Fall back to the first chapter, and drop a
// stale editing id, whenever the underlying data no longer has it.
let wikiSelectedChapterId = null;
let wikiEditingChapterId = null;

// ── Rendering ────────────────────────────────────────────────
// A chapter is visible to a revyst-level visitor once its own `published`
// flag is true — everything else (writing, drafting) stays boss/admin-only
// until a coordinator explicitly flips it on in the "Rediger kapitler"
// modal. Missing/undefined `published` (every pre-existing chapter, and
// every freshly-added one) reads as not-yet-published.
function wikiChapterIsPublished(chapter) {
  return chapter.published === true;
}

// Shown to a revyst-level visitor in place of the two-column layout when
// no chapter is published yet — mirrors site.js's own applyPageGate()
// login-gate card styling. Reuses (hides/clears) the existing #wiki-
// chapter-list/#wiki-content-body/#wiki-chapter-actions nodes rather than
// removing them from the DOM, so a later renderWiki() call (e.g. once a
// coordinator publishes something and this same tab re-renders) can
// rebuild the real layout without needing a page reload.
function renderWikiNoPublishedChapters() {
  const columns = document.querySelector('.wiki-columns');
  const chaptersCard = document.querySelector('.wiki-chapters');
  const contentBody = document.getElementById('wiki-content-body');
  if (!columns || !chaptersCard || !contentBody) return;

  columns.classList.add('wiki-columns-construction');
  chaptersCard.hidden = true;

  contentBody.classList.add('site-gate-card');
  contentBody.textContent = '';
  const h = document.createElement('h2');
  h.textContent = 'Siden er under opbygning';
  const p = document.createElement('p');
  p.textContent = 'Wikien er ved at blive skrevet og er endnu ikke offentliggjort for revyster.';
  contentBody.appendChild(h);
  contentBody.appendChild(p);
}

function renderWiki() {
  const chapterList = document.getElementById('wiki-chapter-list');
  const contentBody = document.getElementById('wiki-content-body');
  const actionsSlot = document.getElementById('wiki-chapter-actions');
  if (!chapterList || !contentBody) return;

  const canEdit = siteHasLevel('boss');
  const chapters = getEffectiveChapters();

  if (!canEdit && !chapters.some(wikiChapterIsPublished)) {
    renderWikiNoPublishedChapters();
    return;
  }

  // Restore the normal two-column layout in case a previous render left it
  // in the "no published chapters yet" banner state above.
  document.querySelector('.wiki-columns')?.classList.remove('wiki-columns-construction');
  const chaptersCard = document.querySelector('.wiki-chapters');
  if (chaptersCard) chaptersCard.hidden = false;
  contentBody.classList.remove('site-gate-card');

  chapterList.textContent = '';
  contentBody.textContent = '';
  actionsSlot.textContent = '';

  const outlineSpyItems = [];

  if (chapters.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wiki-empty';
    empty.textContent = 'Wikien er tom endnu.';
    contentBody.appendChild(empty);
  } else {
    // A revyst-level visitor can only ever land on a published chapter —
    // boss/admin can land on any of them, published or not.
    const selectable = canEdit ? chapters : chapters.filter(wikiChapterIsPublished);
    if (!wikiSelectedChapterId || !selectable.some((c) => c.id === wikiSelectedChapterId)) {
      wikiSelectedChapterId = selectable[0].id;
    }
    if (wikiEditingChapterId && !chapters.some((c) => c.id === wikiEditingChapterId)) {
      wikiEditingChapterId = null;
    }

    // Chapter switching and adding are disabled while a chapter is being
    // edited — simplest, deliberate answer to "what if you switch
    // mid-edit": you can't, until Gem/Annuller.
    for (const chapter of chapters) {
      const published = wikiChapterIsPublished(chapter);
      // A revyst-level visitor sees every chapter's title (so they know
      // what exists) but can't open an unpublished one — greyed via its
      // own class (not the disabled attribute, which would swallow the
      // click) so it can still respond with the "not written yet" toast
      // below.
      const locked = !canEdit && !published;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wiki-chapter-btn';
      if (chapter.id === wikiSelectedChapterId) btn.classList.add('wiki-chapter-active');
      if (locked) btn.classList.add('wiki-chapter-locked');
      btn.textContent = chapter.title;
      if (canEdit && !published) {
        const tag = document.createElement('span');
        tag.className = 'wiki-chapter-unpublished-tag';
        tag.textContent = ' (skjult)';
        btn.appendChild(tag);
      }
      btn.disabled = !!wikiEditingChapterId;
      btn.addEventListener('click', () => {
        if (locked) {
          siteShowToast('Dette kapitel er ikke færdigskrevet endnu');
          return;
        }
        if (chapter.id === wikiSelectedChapterId) return;
        wikiSelectedChapterId = chapter.id;
        renderWiki();
        scrollWikiContentToSidebarTop();
      });
      chapterList.appendChild(btn);

      if (chapter.id === wikiSelectedChapterId) {
        const h2Titles = getChapterH2Titles(chapter);
        if (h2Titles.length > 0) {
          const outline = document.createElement('div');
          outline.className = 'wiki-chapter-outline';
          h2Titles.forEach((title, index) => {
            const headingId = `wiki-h2-${chapter.id}-${index}`;
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'wiki-outline-item';
            item.textContent = title;
            item.disabled = !!wikiEditingChapterId;
            item.addEventListener('click', () => {
              const el = document.getElementById(headingId);
              if (!el) return;
              const targetY = window.scrollY + el.getBoundingClientRect().top - WIKI_OUTLINE_OFFSET + WIKI_OUTLINE_CLICK_EXTRA;
              window.scrollTo({ top: Math.max(targetY, 0), behavior: 'smooth' });
            });
            outline.appendChild(item);
            outlineSpyItems.push({ btn: item, headingId });
          });
          chapterList.appendChild(outline);
        }
      }
    }

    const selected = chapters.find((c) => c.id === wikiSelectedChapterId);
    contentBody.appendChild(
      wikiEditingChapterId === selected.id
        ? renderChapterEditView(selected)
        : renderChapterReadView(selected, canEdit)
    );
  }

  // Read view only — the edit view never stamps heading ids, so there's
  // nothing to spy on while editing (its outline items are also disabled
  // above).
  setupWikiScrollSpy(wikiEditingChapterId ? [] : outlineSpyItems);
  adjustWikiScrollRoom(!wikiEditingChapterId && outlineSpyItems.length > 0 ? outlineSpyItems[outlineSpyItems.length - 1].headingId : null);

  if (canEdit) {
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'btn-small wiki-manage-chapters-btn';
    manageBtn.textContent = 'Rediger kapitler';
    manageBtn.disabled = !!wikiEditingChapterId;
    manageBtn.addEventListener('click', openManageChaptersModal);
    actionsSlot.appendChild(manageBtn);
  }
}

function renderChapterReadView(chapter, canEdit) {
  const wrap = document.createElement('div');

  const head = document.createElement('div');
  head.className = 'card-head wiki-content-head';

  const heading = document.createElement('h2');
  heading.className = 'wiki-content-title';
  heading.textContent = chapter.title;
  head.appendChild(heading);

  if (canEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small';
    editBtn.textContent = 'Rediger';
    editBtn.addEventListener('click', () => {
      wikiEditingChapterId = chapter.id;
      renderWiki();
    });
    head.appendChild(editBtn);
  }

  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'wiki-chapter-body';
  renderSanitizedBody(body, chapter.body, { assignHeadingIds: true, headingIdPrefix: `wiki-h2-${chapter.id}-` });
  wrap.appendChild(body);

  if (chapter.attachments && chapter.attachments.length > 0) {
    const attachments = document.createElement('div');
    attachments.className = 'wiki-attachments';
    for (const a of chapter.attachments) {
      const link = document.createElement('a');
      link.className = 'btn-small wiki-attachment-link';
      link.href = a.path;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = a.name;
      attachments.appendChild(link);
    }
    wrap.appendChild(attachments);
  }

  return wrap;
}

function renderChapterEditView(chapter) {
  const wrap = document.createElement('div');

  const head = document.createElement('div');
  head.className = 'card-head wiki-content-head';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'wiki-edit-title-input';
  titleInput.value = chapter.title;
  head.appendChild(titleInput);
  wrap.appendChild(head);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'wiki-edit-body';
  bodyEl.contentEditable = 'true';
  bodyEl.spellcheck = false;
  // Chrome's default is to wrap each new line in a <div> on Enter, which
  // falls outside our storage allow-list (WIKI_ALLOWED_TAGS has no DIV);
  // asking for 'p' keeps typed paragraphs matching what's actually stored.
  bodyEl.addEventListener('focus', () => {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  });

  const toolbar = buildWikiToolbar(bodyEl);
  wrap.appendChild(toolbar);

  renderSanitizedBody(bodyEl, chapter.body, { linkify: false });
  wrap.appendChild(bodyEl);

  const error = document.createElement('div');
  error.className = 'login-error';

  // ── Attachments ──
  // Local draft: existing entries carry {id, name, path}; a newly-picked
  // file carries {id, name, file} (not yet uploaded) instead of `path`.
  // Uploads only happen at Gem time, mirroring archive.js's openYearEditor
  // (pick files first, upload as part of save, only then persist the
  // chapter record referencing the confirmed paths).
  let attachmentDraft = (chapter.attachments || []).map((a) => ({ ...a }));

  const attachSection = document.createElement('div');
  attachSection.className = 'wiki-edit-attachments';
  const attachLabel = document.createElement('div');
  attachLabel.className = 'wiki-edit-attachments-label';
  attachLabel.textContent = 'Vedhæftede filer';
  attachSection.appendChild(attachLabel);

  const attachList = document.createElement('div');
  attachSection.appendChild(attachList);

  function renderAttachmentList() {
    attachList.textContent = '';
    attachmentDraft.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'wiki-edit-attachment-row';

      const name = document.createElement('span');
      name.className = 'wiki-edit-attachment-name';
      name.textContent = a.name + (a.file ? ' (ikke uploadet endnu)' : '');
      row.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'wiki-edit-attachment-remove';
      remove.textContent = '✕';
      remove.title = 'Fjern vedhæftning';
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => {
        attachmentDraft = attachmentDraft.filter((x) => x.id !== a.id);
        renderAttachmentList();
      });
      row.appendChild(remove);

      attachList.appendChild(row);
    });
  }
  renderAttachmentList();

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.className = 'site-file-input wiki-edit-attachment-add';
  attachInput.accept = '.pdf,.tex';
  attachInput.multiple = true;
  attachInput.addEventListener('change', () => {
    const files = Array.from(attachInput.files);
    attachInput.value = '';
    if (files.length === 0) return;

    // Shared batchId + per-file index keeps ids unique even when several
    // files are picked in the same change event (Date.now() alone would
    // collide across a synchronous loop).
    const batchId = Date.now().toString(36);
    const invalidExt = [];
    const oversized = [];
    let added = false;
    files.forEach((file, i) => {
      const ext = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
      if (ext !== 'pdf' && ext !== 'tex') {
        invalidExt.push(file.name);
        return;
      }
      if (file.size > WIKI_MAX_UPLOAD_BYTES) {
        oversized.push(file.name);
        return;
      }
      attachmentDraft.push({ id: `${batchId}-${i}`, name: file.name, file });
      added = true;
    });

    const messages = [];
    if (invalidExt.length > 0) messages.push(`Kun .pdf- og .tex-filer kan vedhæftes: ${invalidExt.join(', ')}`);
    if (oversized.length > 0) messages.push(`Følgende fil(er) er for store (maks. 5 MB): ${oversized.join(', ')}`);
    error.textContent = messages.join(' ');

    if (added) renderAttachmentList();
  });
  attachSection.appendChild(attachInput);

  wrap.appendChild(attachSection);

  const attachDivider = document.createElement('div');
  attachDivider.className = 'wiki-edit-divider';
  wrap.appendChild(attachDivider);

  wrap.appendChild(error);

  // ── Actions ──
  const actions = document.createElement('div');
  actions.className = 'wiki-edit-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'site-btn-warm';
  cancel.textContent = 'Annuller';
  cancel.addEventListener('click', () => {
    toolbar.destroy();
    wikiEditingChapterId = null;
    renderWiki();
  });
  actions.appendChild(cancel);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'site-btn-danger';
  del.textContent = 'Slet';
  del.addEventListener('click', () => openDeleteChapterConfirm(chapter));
  actions.appendChild(del);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'site-btn-success';
  save.textContent = 'Gem';
  actions.appendChild(save);

  wrap.appendChild(actions);

  save.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) {
      error.textContent = 'Titel er påkrævet.';
      return;
    }

    save.disabled = true;
    error.textContent = '';

    // Upload any newly-picked (not-yet-uploaded) attachment files first —
    // same order as archive.js's openYearEditor: files land in the repo
    // before the chapter record referencing their paths is saved.
    const finalAttachments = [];
    for (const a of attachmentDraft) {
      if (!a.file) {
        finalAttachments.push({ id: a.id, name: a.name, path: a.path });
        continue;
      }
      const ext = a.name.match(/\.([^.]+)$/)[1].toLowerCase();
      const path = buildWikiAttachmentPath(chapter.id, a.id, a.name, ext);
      const dataUrl = await wikiReadFileAsDataURL(a.file);
      const uploadResult = await siteUploadFile(path, wikiStripDataUrlPrefix(dataUrl));
      if (!uploadResult.ok) {
        save.disabled = false;
        error.textContent = uploadResult.message;
        return;
      }
      finalAttachments.push({ id: a.id, name: a.name, path });
    }

    const draft = { id: chapter.id, title, body: sanitizeHtmlString(bodyEl.innerHTML), published: chapter.published === true, attachments: finalAttachments };
    const current = getEffectiveChapters();
    const next = current.map((c) => (c.id === chapter.id ? draft : c));
    const result = await saveChapters(next); // clears wikiEditingChapterId + re-renders on success
    if (result.ok) {
      toolbar.destroy();
    } else {
      save.disabled = false;
      error.textContent = result.message;
    }
  });

  titleInput.focus();
  return wrap;
}

// ── Formatting toolbar ──────────────────────────────────────
// Google-Docs-style layout: block-style dropdown first, then B/I/U
// toggle buttons (highlighted when the caret/selection has that
// formatting, also bound to Cmd/Ctrl+B/I/U), then list buttons last.
// Call toolbar.destroy() when the edit view unmounts (Annuller or a
// successful Gem) to remove the document-level selectionchange listener.
function buildWikiToolbar(bodyEl) {
  const toolbar = document.createElement('div');
  toolbar.className = 'wiki-toolbar';

  // The style dropdown opens an async popup (site-utils.js), so unlike
  // the buttons below, bodyEl's selection WILL be lost by the time
  // 'change' fires (the user clicked a row inside the popup, which
  // steals focus). Capture the range up front on mousedown and restore
  // it right before running the command.
  let savedRange = null;
  const styleDropdown = siteCreateDropdownField([
    { value: 'p', label: 'Normal' },
    { value: 'h3', label: 'Overskrift 2' },
    { value: 'h2', label: 'Overskrift 1' },
  ], 'p');
  styleDropdown.classList.add('wiki-toolbar-style');
  styleDropdown.addEventListener('mousedown', () => {
    const sel = window.getSelection();
    if (sel.rangeCount > 0 && bodyEl.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });
  styleDropdown.addEventListener('change', () => {
    bodyEl.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    // Angle-bracket tag form is the cross-browser-safe one for
    // formatBlock (older Firefox rejects the bare tag name).
    document.execCommand('formatBlock', false, `<${styleDropdown.value}>`);
    updateToolbarState();
  });
  toolbar.appendChild(styleDropdown);

  // mousedown + preventDefault (not click) so focus/selection never
  // leaves bodyEl before the execCommand fires — the standard,
  // load-bearing gotcha for any execCommand-based toolbar.
  function addFormatBtn(label, title, command, extraClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn-small wiki-toolbar-btn${extraClass ? ' ' + extraClass : ''}`;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.execCommand(command);
      updateToolbarState();
    });
    toolbar.appendChild(btn);
    return btn;
  }

  const boldBtn = addFormatBtn('B', 'Fed', 'bold', 'wiki-toolbar-btn-bold');
  const italicBtn = addFormatBtn('I', 'Kursiv', 'italic', 'wiki-toolbar-btn-italic');
  const underlineBtn = addFormatBtn('U', 'Understreget', 'underline', 'wiki-toolbar-btn-underline');
  const bulletBtn = addFormatBtn('•', 'Punktopstilling', 'insertUnorderedList');
  const orderedBtn = addFormatBtn('1.', 'Nummereret liste', 'insertOrderedList');

  // Walks up from the caret to the nearest h2/h3/p ancestor within
  // bodyEl (renderSanitizedBody only ever nests those three as direct
  // children of bodyEl; inline b/i/u nest inside a p). Falls back to
  // 'p' when nothing matches (e.g. caret inside a list item, which
  // execCommand('insertUnorderedList') doesn't wrap in a p).
  function detectBlockTag() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !bodyEl.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    const startEl = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = startEl && startEl.closest ? startEl.closest('h2, h3, p') : null;
    return block && bodyEl.contains(block) ? block.tagName.toLowerCase() : 'p';
  }

  function updateToolbarState() {
    const sel = window.getSelection();
    const focused = document.activeElement === bodyEl || (sel.rangeCount > 0 && bodyEl.contains(sel.anchorNode));
    if (!focused) return; // leave last-known display as-is when focus is elsewhere on the page
    boldBtn.classList.toggle('wiki-toolbar-btn-active', document.queryCommandState('bold'));
    italicBtn.classList.toggle('wiki-toolbar-btn-active', document.queryCommandState('italic'));
    underlineBtn.classList.toggle('wiki-toolbar-btn-active', document.queryCommandState('underline'));
    bulletBtn.classList.toggle('wiki-toolbar-btn-active', document.queryCommandState('insertUnorderedList'));
    orderedBtn.classList.toggle('wiki-toolbar-btn-active', document.queryCommandState('insertOrderedList'));
    const tag = detectBlockTag();
    // .value's setter only re-renders the dropdown's display, it never
    // dispatches 'change' (site-utils.js), so this can't loop back into
    // another formatBlock call.
    if (tag) styleDropdown.value = tag;
  }

  function onSelectionChange() { updateToolbarState(); }
  bodyEl.addEventListener('keyup', updateToolbarState);
  bodyEl.addEventListener('mouseup', updateToolbarState);
  document.addEventListener('selectionchange', onSelectionChange);

  bodyEl.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const command = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
    if (!command) return;
    e.preventDefault();
    document.execCommand(command);
    updateToolbarState();
  });

  // ── Markdown-style list autocorrect (Word/Docs convention): typing
  // "* ", "- ", or "1. " converts the current, still-empty line into a
  // bullet/numbered list. Only fires when the marker is the block's entire
  // content so far — never mid-sentence — so `before === marker text` and
  // the caret sitting at the end of that same text node is the trigger.
  const BULLET_MARKERS = new Set(['*', '-']);
  const ORDERED_MARKER = '1.';

  function getCaretBlock(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !bodyEl.contains(el)) return null;
    return el.closest('p, h2, h3, li') || bodyEl;
  }

  function textBeforeCaret(block, range) {
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString();
  }

  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed || !bodyEl.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return;
    const block = getCaretBlock(range.startContainer);
    if (!block) return;
    const before = textBeforeCaret(block, range);
    const isBullet = BULLET_MARKERS.has(before);
    const isOrdered = before === ORDERED_MARKER;
    if ((!isBullet && !isOrdered) || range.startOffset !== before.length) return;
    e.preventDefault();
    // 'delete' once per marker character — like real Backspace presses —
    // rather than mutating the text node directly. Leaving the text node
    // manually emptied (via Text.deleteData) confused execCommand right
    // after: on an otherwise-empty line, insertUnorderedList/insertOrderedList
    // sometimes picked up the *next* paragraph as "the current block"
    // instead of the (now content-less) one the caret was actually in.
    // Routing the deletion through execCommand keeps the browser's own
    // editing state consistent, so the following list command always
    // targets the right line.
    for (let i = 0; i < before.length; i++) {
      document.execCommand('delete');
    }
    document.execCommand(isBullet ? 'insertUnorderedList' : 'insertOrderedList');
    updateToolbarState();
  });

  // Chrome's execCommand('indent') nests a sub-list as a *sibling* of the
  // preceding <li> (`<ul><li>A</li><ul><li>B</li></ul></ul>`) rather than
  // inside it — invalid HTML (a list's only valid children are <li>s) that
  // also confuses the browser's own backspace/delete merging on the
  // now-oddly-parented sub-item (deleting on an empty nested line could
  // eat the *previous* line's content instead of just the empty line).
  // Re-parent any list that ends up as a direct child of another list into
  // the end of its immediately preceding <li>, matching the nesting
  // Word/Docs produce. Moves the actual node (never clones it), so any
  // selection/caret inside it stays valid.
  function normalizeNestedLists() {
    bodyEl.querySelectorAll('ul, ol').forEach((list) => {
      const parent = list.parentElement;
      if (!parent || (parent.tagName !== 'UL' && parent.tagName !== 'OL')) return;
      const prevLi = list.previousElementSibling;
      if (prevLi && prevLi.tagName === 'LI') prevLi.appendChild(list);
    });
    // The flip side: running execCommand('outdent') on a *properly* nested
    // list (the shape the fix above just produced) can leave the un-nested
    // <li> as a direct child of its former parent <li> — also invalid (an
    // <li> can only contain block content, never another <li> without an
    // intervening <ul>/<ol>). Hoist any such <li> to be its parent's next
    // sibling instead, in document order so multi-level cases cascade
    // correctly in one pass.
    bodyEl.querySelectorAll('li').forEach((li) => {
      const parent = li.parentElement;
      if (parent && parent.tagName === 'LI') parent.after(li);
    });
  }

  // ── Tab / Shift+Tab nests/un-nests the current list item, matching how
  // Word/Docs handle sub-items. Only intercepted inside a list item — a Tab
  // press anywhere else keeps its normal (focus-moving) behaviour.
  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const sel = window.getSelection();
    if (!sel.rangeCount || !bodyEl.contains(sel.anchorNode)) return;
    const el = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
    const li = el && el.closest ? el.closest('li') : null;
    if (!li || !bodyEl.contains(li)) return;
    e.preventDefault();
    document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    normalizeNestedLists();
    updateToolbarState();
  });

  updateToolbarState();
  toolbar.destroy = () => document.removeEventListener('selectionchange', onSelectionChange);

  return toolbar;
}

// ── Sanitized rendering (see the file-level comment for why this is
// safe despite storing/rendering HTML) ──────────────────────────
const WIKI_ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'P', 'BR', 'H2', 'H3']);
const WIKI_TAG_MAP = { B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u', UL: 'ul', OL: 'ol', LI: 'li', P: 'p', BR: 'br', H2: 'h2', H3: 'h3' };

// Renders a stored/typed HTML string into `container` by parsing it into
// a fully detached document (DOMParser never executes scripts, and the
// result is never attached to the live document) and rebuilding only the
// allow-listed tags as real DOM nodes via createElement/createTextNode —
// `.innerHTML` is never assigned on a live node.
//
// `assignHeadingIds`/`headingIdPrefix` optionally stamp a synthesized
// `id="<headingIdPrefix><index>"` onto each rebuilt H2 (used by the
// left-column outline to scroll a heading into view) — the id is
// generated by our own counter, never copied from the source node, so
// this doesn't weaken the "no attributes copied from source" property.
function renderSanitizedBody(container, html, { linkify = true, assignHeadingIds = false, headingIdPrefix = '' } = {}) {
  container.textContent = '';
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const headingCounter = assignHeadingIds ? { h2: 0 } : null;
  appendSanitizedChildren(container, doc.body, linkify, headingCounter, headingIdPrefix);
}

function appendSanitizedChildren(target, sourceNode, linkify, headingCounter, headingIdPrefix) {
  for (const node of sourceNode.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (linkify) appendTextWithLinks(target, node.textContent);
      else target.appendChild(document.createTextNode(node.textContent));
    } else if (node.nodeType === Node.ELEMENT_NODE && WIKI_ALLOWED_TAGS.has(node.tagName)) {
      const el = document.createElement(WIKI_TAG_MAP[node.tagName]);
      if (headingCounter && node.tagName === 'H2') {
        el.id = `${headingIdPrefix}${headingCounter.h2}`;
        headingCounter.h2 += 1;
      }
      appendSanitizedChildren(el, node, linkify, headingCounter, headingIdPrefix);
      target.appendChild(el);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Disallowed wrapper (e.g. a stray <div>/<span style=...>/<font>
      // produced by execCommand or a paste) — drop the wrapper itself
      // but keep walking its children so their text/allowed formatting
      // survives.
      appendSanitizedChildren(target, node, linkify, headingCounter, headingIdPrefix);
    }
  }
}

// ── Outline scroll-spy ──────────────────────────────────────
// Highlights whichever outline item's heading is currently scrolled to the
// top of the (window-scrolled) page, mirroring the sticky left column's
// 20px-below-the-header resting position (see .wiki-chapters in wiki.css).
// Re-run on every renderWiki() call since the outline buttons/headings are
// fresh DOM nodes each time — always tears down the previous listener
// first so re-renders (chapter switch, edit/save, ...) never stack them.
let wikiScrollSpyCleanup = null;

function setupWikiScrollSpy(items) {
  if (wikiScrollSpyCleanup) {
    wikiScrollSpyCleanup();
    wikiScrollSpyCleanup = null;
  }
  if (!items || items.length === 0) return;

  function update() {
    let activeIndex = -1;
    for (let i = 0; i < items.length; i++) {
      const el = document.getElementById(items[i].headingId);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= WIKI_OUTLINE_OFFSET) {
        activeIndex = i;
      } else {
        break;
      }
    }
    items.forEach((item, i) => {
      item.btn.classList.toggle('wiki-outline-active', i === activeIndex);
    });
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      update();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  update();
  wikiScrollSpyCleanup = () => window.removeEventListener('scroll', onScroll);
}

// Adds just enough bottom room inside #wiki-content-body for the LAST
// outline item to be reachable — no more. Two cases, matching how far the
// chapter's real content already runs past its last heading:
//  - Already far enough (the natural end of the box is at or past the point
//    where the last heading would reach WIKI_OUTLINE_OFFSET once its own
//    bottom scrolls into view): no spacer — the box just ends after its own
//    text, same as any other chapter.
//  - Not far enough (a short trailing section, e.g. "Ikke skrevet endnu…"):
//    add exactly the spacer needed so scrolling to the box's new bottom
//    lands the heading exactly at WIKI_OUTLINE_OFFSET — you can't scroll
//    any further than that, and what you see at the bottom of the viewport
//    at that point is the box's own (now slightly taller) bottom edge, not
//    a further stretch of empty page.
// Always re-measures from a clean slate (removes any previous spacer first)
// since chapter switches/edits change both the heading's position and the
// box's natural height.
function adjustWikiScrollRoom(lastHeadingId) {
  const existingSpacer = document.getElementById('wiki-scroll-spacer');
  if (existingSpacer) existingSpacer.remove();
  if (!lastHeadingId) return;

  const contentBody = document.getElementById('wiki-content-body');
  const headingEl = document.getElementById(lastHeadingId);
  if (!contentBody || !headingEl) return;

  const viewportHeight = window.innerHeight;
  const headingAbsoluteTop = headingEl.getBoundingClientRect().top + window.scrollY;
  const boxBottomAbsolute = contentBody.getBoundingClientRect().bottom + window.scrollY;
  // Trimmed 50px off the strict "box bottom reaches the viewport's bottom
  // edge exactly as the heading crosses WIKI_OUTLINE_OFFSET" requirement —
  // the last item's own click target already lands it correctly (see
  // WIKI_OUTLINE_CLICK_EXTRA above), so the spacer only needs to get it
  // close, not exact, and a shorter minimum reads better.
  const requiredBoxBottom = headingAbsoluteTop - WIKI_OUTLINE_OFFSET + viewportHeight - 50;
  const extra = requiredBoxBottom - boxBottomAbsolute;
  if (extra <= 0) return;

  const spacer = document.createElement('div');
  spacer.id = 'wiki-scroll-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.height = `${Math.ceil(extra)}px`;
  contentBody.appendChild(spacer);
}

// Plain text of every <h2> in a chapter's stored body, in document order —
// used by the left-column outline. Parsed the same way (DOMParser into a
// detached document) as renderSanitizedBody, over the same string, so its
// order always matches the heading ids assignHeadingIds stamps above.
function getChapterH2Titles(chapter) {
  const doc = new DOMParser().parseFromString(chapter.body || '', 'text/html');
  return Array.from(doc.body.querySelectorAll('h2')).map((h2) => h2.textContent);
}

// Canonicalizes whatever execCommand produced in the live contenteditable
// region down to the allow-listed subset before it's ever written to
// data/wiki.json. `scratch` is a detached <div> built entirely from the
// allow-list with zero attributes ever copied from the source, so reading
// `.innerHTML` back off it is safe.
function sanitizeHtmlString(rawHtml) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const scratch = document.createElement('div');
  appendSanitizedChildren(scratch, doc.body, false); // linkify:false — links are render-time only, never stored
  return scratch.innerHTML;
}

// One <a> per http(s)/www URL found in `text`, appended directly into
// `target` alongside plain text nodes for everything else.
const WIKI_URL_RE = /((https?:\/\/|www\.)\S+)/g;

function appendTextWithLinks(target, text) {
  let lastIndex = 0;
  let match;
  WIKI_URL_RE.lastIndex = 0;
  while ((match = WIKI_URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) target.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    let url = match[0];
    const trailingMatch = url.match(/[.,)]+$/);
    if (trailingMatch) url = url.slice(0, -trailingMatch[0].length);
    const a = document.createElement('a');
    a.href = url.startsWith('http') ? url : `https://${url}`;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener';
    target.appendChild(a);
    if (trailingMatch) target.appendChild(document.createTextNode(trailingMatch[0]));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) target.appendChild(document.createTextNode(text.slice(lastIndex)));
}

// ── Attachments (PDF/TEX files per chapter) ──────────────────
// Uploaded via the generic admin/boss 'upload' action (same as Arkiv's
// cover/manus uploads) to wiki/<chapterId>/<attachmentId>-<slug>.<ext> —
// the client picks the exact path, the server only checks it against an
// allow-listed regex (see WIKI_ATTACHMENT_PATH_RE in update-data.php).
// Uniqueness comes from the generated id prefix, not the slug, so no
// collision/dedupe handling is needed — same idea as archive.js's
// slugifyFolderName(), just for a filename instead of a folder name.
function wikiSlugifyFilename(name) {
  const map = { æ: 'ae', ø: 'oe', å: 'aa', Æ: 'Ae', Ø: 'Oe', Å: 'Aa' };
  let s = name.trim().replace(/[æøåÆØÅ]/g, (ch) => map[ch]);
  s = s.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  s = s.replace(/^[_-]+|[_-]+$/g, '');
  return s || 'fil';
}

function buildWikiAttachmentPath(chapterId, attachmentId, originalName, ext) {
  const base = originalName.replace(/\.[^.]+$/, '');
  return `wiki/${chapterId}/${attachmentId}-${wikiSlugifyFilename(base)}.${ext}`;
}

function wikiReadFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // "data:<mime>;base64,<data>"
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function wikiStripDataUrlPrefix(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i === -1 ? dataUrl : dataUrl.slice(i + 1);
}

// ── Saving ───────────────────────────────────────────────────
async function saveChapters(next) {
  const result = await siteSaveResource('wiki', { chapters: next });
  if (result.ok) {
    wikiOverride = next;
    siteSaveOverride('wiki', next);
    wikiEditingChapterId = null;
    renderWiki();
  }
  return result;
}

// A square colored button for modal actions — see style.css's shared
// .site-btn-success/-danger/-warm for the styling (blue .site-btn-primary is reserved for Login/Archive; also used by every other
// page's modals). variant defaults to 'site-btn-warm' (e.g. Annuller).
function wikiPillBtn(label, variant) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = variant || 'site-btn-warm';
  btn.textContent = label;
  return btn;
}

// Styled "Er du sikker?" overlay — mirrors calendar.js's openDeleteConfirm/
// posts.js's deletePost (dropping the usual h2 heading in favor of one bold
// centered line, narrower than the edit view it sits on top of).
function openDeleteChapterConfirm(existing) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('wiki-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'wiki-confirm-text';
  info.textContent = `Slet "${existing.title}"?`;
  form.appendChild(info);

  const sub = document.createElement('p');
  sub.className = 'wiki-confirm-sub';
  sub.textContent = 'Dette kan ikke fortrydes.';
  form.appendChild(sub);

  const cancelBtn = wikiPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = wikiPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const next = getEffectiveChapters().filter((c) => c.id !== existing.id);
    const result = await saveChapters(next);
    if (result.ok) {
      close();
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// A native drag lets the browser snapshot the dragged element itself as the
// drag image, which for a chapter row (icon handle + title, live page
// styling and all) reads as a messy oversized preview rather than a clean
// one. Routes through one shared, off-screen (not display:none — that
// would keep it from being paintable) <div> instead, restyled with just
// the dragged chapter's own title right before dragstart calls
// setDragImage on it — see forms.js's formsGetDragImageEl for the page
// this pattern originated on.
function wikiGetDragImageEl() {
  let ghost = document.getElementById('wiki-drag-image');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'wiki-drag-image';
    ghost.className = 'wiki-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

// ── Hover tooltip (publish-toggle icon labels) ──
// Mirrors budget.js's own budgetShowFieldTooltip/budgetHideFieldTooltip
// (that file isn't loaded on this page, per the per-feature duplication
// convention documented in CLAUDE.md): a fixed-position dark box, since a
// native title attribute's own tooltip renders inconsistently across
// browsers.
let wikiFieldTooltipEl = null;
function wikiShowFieldTooltip(anchor, text) {
  wikiHideFieldTooltip();
  const tip = document.createElement('div');
  tip.className = 'wiki-field-tooltip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const anchorRect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let top = anchorRect.top - tipRect.height - 6;
  if (top < 4) top = anchorRect.bottom + 6;
  let left = anchorRect.left;
  if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
  if (left < 4) left = 4;
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  wikiFieldTooltipEl = tip;
}
function wikiHideFieldTooltip() {
  if (wikiFieldTooltipEl) { wikiFieldTooltipEl.remove(); wikiFieldTooltipEl = null; }
}

// Open/closed eye glyphs for the publish toggle — same stroke-icon style as
// budget.js's budgetPencilIcon()/budgetCheckIcon() etc. (16x16 viewBox,
// currentColor stroke), duplicated since budget.js isn't loaded here.
function wikiEyeOpenIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const outline = document.createElementNS(svgNS, 'path');
  outline.setAttribute('d', 'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z');
  svg.appendChild(outline);
  const pupil = document.createElementNS(svgNS, 'circle');
  pupil.setAttribute('cx', '8');
  pupil.setAttribute('cy', '8');
  pupil.setAttribute('r', '2');
  svg.appendChild(pupil);
  return svg;
}

function wikiEyeClosedIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const lid = document.createElementNS(svgNS, 'path');
  lid.setAttribute('d', 'M1.333 5.333A7.097 7.097 0 0 0 14.667 5.333');
  svg.appendChild(lid);
  ['M2.667 10L3.818 8.633', 'M13.333 10L12.182 8.633', 'M6 12L6.481 9.833', 'M10 12L9.519 9.833'].forEach((d) => {
    const lash = document.createElementNS(svgNS, 'path');
    lash.setAttribute('d', d);
    svg.appendChild(lash);
  });
  return svg;
}

// Robust dragenter/dragleave pairing via a nesting counter — duplicated from
// manus.js's identically-named helper (Aktfordeling's drag-and-drop), since
// wiki.js doesn't load manus.js. Plain dragover-driven highlighting re-fires
// dragleave on every child element the pointer crosses, flickering the
// highlight on/off; counting enter/leave pairs only clears it once the
// pointer has actually left the whole element.
function wikiWireDropHighlight(el, onDrop, { stop = false } = {}) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth++;
    el.classList.add('wiki-manage-drop-target');
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault(); // required for 'drop' to fire at all
    if (stop) e.stopPropagation();
  });
  el.addEventListener('dragleave', (e) => {
    if (stop) e.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove('wiki-manage-drop-target');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth = 0;
    el.classList.remove('wiki-manage-drop-target');
    onDrop();
  });
}

// ── Manage-chapters modal (add + reorder via drag-and-drop) ──
function openManageChaptersModal() {
  const { form, error, actions, close } = siteOpenModalWithClose('Rediger kapitler');

  // Boss can write/reorder/delete every chapter but not decide what's
  // published to revyster — that stays admin-only (see the publish toggle
  // below).
  const canPublish = siteHasLevel('admin');

  // Local draft of {id, title, published} only — body/attachments are
  // never touched here, only reattached from the current saved chapters at
  // save time, so a reorder/add/publish-toggle can never lose a chapter's
  // content.
  let draft = getEffectiveChapters().map((c) => ({ id: c.id, title: c.title, published: c.published === true }));

  const listWrap = document.createElement('div');
  listWrap.className = 'wiki-manage-list';
  form.appendChild(listWrap);

  // Dragged chapter's id, set on dragstart and consumed by whichever row's
  // drop handler fires — mirrors manus.js's Aktfordeling drag-and-drop
  // (manusDragKey/wireDropHighlight/manusMoveRow), simplified to a single
  // flat list (no lanes/columns to target).
  let dragId = null;

  function moveDraftItem(id, beforeId) {
    const idx = draft.findIndex((d) => d.id === id);
    if (idx === -1) return;
    const [item] = draft.splice(idx, 1);
    const beforeIdx = beforeId ? draft.findIndex((d) => d.id === beforeId) : -1;
    if (beforeIdx === -1) draft.push(item);
    else draft.splice(beforeIdx, 0, item);
    renderList();
  }

  function renderList() {
    listWrap.textContent = '';
    draft.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'wiki-manage-row';
      row.draggable = true;

      row.addEventListener('dragstart', (e) => {
        dragId = item.id;
        e.dataTransfer.effectAllowed = 'move';
        const ghost = wikiGetDragImageEl();
        ghost.textContent = item.title;
        e.dataTransfer.setDragImage(ghost, 12, 16);
      });
      row.addEventListener('dragend', () => row.classList.remove('wiki-manage-drop-target'));
      wikiWireDropHighlight(row, () => {
        if (dragId && dragId !== item.id) moveDraftItem(dragId, item.id);
      }, { stop: true });

      const handle = document.createElement('span');
      handle.className = 'wiki-manage-drag-handle';
      handle.textContent = '⠿';
      row.appendChild(handle);

      const title = document.createElement('span');
      title.className = 'wiki-manage-row-title';
      title.textContent = item.title;
      row.appendChild(title);

      // Publish toggle — admin-only (boss can write/reorder/delete every
      // chapter but not decide what's visible to revyster); boss still
      // sees the current state, just can't touch it. An open/closed eye
      // icon button (see wikiEyeOpenIcon/wikiEyeClosedIcon above) rather
      // than a checkbox+label — hover shows the current state via the
      // same dark-box tooltip convention as budget.js's icon actions.
      // Mutates the draft item directly (no full renderList() needed,
      // unlike a reorder, since nothing else on screen depends on this
      // value — just the button's own icon/tooltip text).
      const publishBtn = document.createElement('button');
      publishBtn.type = 'button';
      publishBtn.className = 'wiki-manage-publish-toggle';
      if (!canPublish) publishBtn.classList.add('wiki-manage-publish-toggle-readonly');
      publishBtn.disabled = !canPublish;
      function syncPublishBtn() {
        publishBtn.textContent = '';
        publishBtn.appendChild(item.published ? wikiEyeOpenIcon() : wikiEyeClosedIcon());
        publishBtn.setAttribute('aria-label', item.published ? 'Synlig for revyster' : 'Skjult for revyster');
      }
      syncPublishBtn();
      publishBtn.addEventListener('mouseenter', () => wikiShowFieldTooltip(publishBtn, publishBtn.getAttribute('aria-label')));
      publishBtn.addEventListener('mouseleave', wikiHideFieldTooltip);
      publishBtn.addEventListener('click', () => {
        if (!canPublish) return;
        item.published = !item.published;
        syncPublishBtn();
        wikiHideFieldTooltip();
      });
      row.appendChild(publishBtn);

      listWrap.appendChild(row);
    });

    // Trailing drop zone filling the rest of the list's own space — without
    // it, dropping below the last row has nowhere to land (a per-row drop
    // target can only ever insert *before* that row). Same recipe as
    // Manus's Aktfordeling .manus-akt-drop-tail (manus.css/js).
    const tail = document.createElement('div');
    tail.className = 'wiki-manage-drop-tail';
    wikiWireDropHighlight(tail, () => {
      if (dragId) moveDraftItem(dragId, null);
    }, { stop: true });
    listWrap.appendChild(tail);
  }
  renderList();

  // ── "+ Ny kapitel" — clicking it immediately appends a new row to the
  // draggable list (same look as an existing chapter, no separate input
  // step); renaming happens afterward via the normal per-chapter edit view,
  // not here.
  const addTriggerWrap = document.createElement('div');
  addTriggerWrap.className = 'wiki-manage-add-trigger-wrap';
  const addTrigger = document.createElement('button');
  addTrigger.type = 'button';
  addTrigger.className = 'boss-manage-add-plus';
  addTrigger.textContent = '+';
  addTrigger.title = 'Tilføj kapitel';
  addTrigger.setAttribute('aria-label', 'Tilføj kapitel');
  addTrigger.addEventListener('click', () => {
    draft.push({ id: Date.now().toString(36), title: 'Nyt kapitel', published: false });
    renderList();
  });
  addTriggerWrap.appendChild(addTrigger);
  form.appendChild(addTriggerWrap);

  const save = wikiPillBtn('Gem', 'site-btn-success');
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    if (draft.length === 0) {
      error.textContent = 'Der skal være mindst ét kapitel.';
      return;
    }
    save.disabled = true;
    error.textContent = '';

    const current = getEffectiveChapters();
    const next = draft.map((d) => {
      const existing = current.find((c) => c.id === d.id);
      return existing
        ? { id: d.id, title: d.title, body: existing.body, published: d.published === true, attachments: existing.attachments || [] }
        : { id: d.id, title: d.title, body: '', published: d.published === true };
    });

    const result = await saveChapters(next);
    if (result.ok) {
      close();
    } else {
      save.disabled = false;
      error.textContent = result.message;
    }
  });
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderWiki);
