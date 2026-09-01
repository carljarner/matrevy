#!/usr/bin/env node
'use strict';
// Generates Aktoversigt.pdf / Rolleoversigt.pdf / Manuskript.pdf (plus one
// PDF per sketch/song) straight from data/scenes.json + data/cast.json —
// the same three deliverables the revue's old Perl/LaTeX toolchain
// (matrevy/RevyTeX's acts.pl/roles.pl/manus.pl) used to produce, reimplemented
// here in Node per matrevy-plan.md's Phase 4.4.
//
// data/scenes.json stays the sole source of truth (edited via manus.html's
// Main Manus View, particularly the "Manus" tab's scriptBody/status/melody/
// writtenBy/sourceProduction/sourceYear fields) — this script only ever
// *reads* it. It DOES write back into archive/<folder>/'s stored per-scene
// .tex sources (deriveSourceTexPath, below) — overwriting the original
// as-submitted script with the final, currently-edited text/roles, so the
// archived .tex always matches the archived .pdf it was compiled from. Every
// other output (Aktoversigt/Rolleoversigt/Manuskript/per-scene .pdf) remains
// disposable/regeneratable.
//
// Run manually after editing scenes (like scripts/embed-scenes.js):
//   node scripts/generate-pdfs.js
//
// Prerequisites (NOT part of the deployed site's own zero-dependency stack —
// scoped entirely to this one dev-only script, see package.json):
//   - a local TeX Live/MacTeX install providing `pdflatex` on PATH
//   - `npm install` once, for the pdf-lib dependency used to merge the
//     per-scene PDFs into Manuskript.pdf
//
// manus/revy.sty (the real DIKUrevy/RevyTeX style file, already vendored in
// this repo) supplies every sketch/song document's actual typesetting
// (\role, \begin{roles}, \begin{sketch}/\begin{song}, \says/\sings, the
// page-heading macros) — see manus/skabelon-sketch.tex/skabelon-sang.tex for
// the blank template this script's per-scene .tex mirrors. Aktoversigt/
// Rolleoversigt only borrow revy.sty for their own \maketitle title block;
// their body content (an enumerate list, and a giant rotated-header table)
// is plain LaTeX with no revy.sty environments involved, matching how the
// original acts.pl/roles.pl generated them.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = p => path.join(__dirname, '..', p);
const readJson = p => JSON.parse(fs.readFileSync(root(p), 'utf8'));

const BUILD_DIR = root('.pdf-build');
const REVY_STY = root('manus/revy.sty');

// ── Role classification (duplicated a third time — see import.js's and
// manus.js's own copies of this exact table/logic. manus.js's file header
// already documents why this codebase duplicates rather than cross-file-
// reuses this: the three call sites are a browser event-handler file, a
// second browser file, and now a standalone Node script with no shared
// module setup in this zero-dependency codebase.) Used only to derive the
// "Roller:" list's explanation text (e.g. "Instruktør") from a scene's raw
// cast[].role codes — a good default, not a perfect match for hand-picked
// wording real manuscripts sometimes use (see the plan's noted fidelity gap).
const ROLE_CATEGORIES = ['Instruktør', 'Koreograf', 'Skuespil', 'Sang/Rap', 'Dans', 'Kor', 'Statist', 'Ninja'];

function classifyRoleCode(code, isSong, isDans) {
  const raw = code.trim();
  const c = raw.toUpperCase();
  if (raw.includes('I')) return 'Instruktør';
  if (c.includes('Y')) return 'Koreograf';
  if (c.startsWith('ST')) return 'Statist';
  if (isSong) {
    if (c.includes('D')) return 'Dans';
    if (c.startsWith('K')) return 'Kor';
    if (c.includes('N')) return 'Ninja';
    return 'Sang/Rap';
  }
  if (isDans && c.includes('D')) return 'Dans';
  if (c.includes('N')) return 'Ninja';
  return 'Skuespil';
}

function classifyOrKeep(code, isSong, isDans) {
  return ROLE_CATEGORIES.includes(code) ? code : classifyRoleCode(code, isSong, isDans);
}

// Duplicated verbatim from manus.js's castRoleLabels() — see its own doc
// comment there for why this exists: Rollefordeling only ever captures a
// cast member's broad classified category (never a distinguishing per-person
// code), so this assigns each cast entry a label unique *within its own
// scene* (the bare category, or category+ordinal when more than one person
// shares it) — this is what actually goes in \role{<label>}, and what the
// scene's own scriptBody (written in the Manus tab, which showed the writer
// this exact same label) references in \says{<label>}/\sings{<label>}.
function castRoleLabels(entries) {
  const counts = new Map();
  for (const e of entries) counts.set(e.category, (counts.get(e.category) || 0) + 1);
  const seen = new Map();
  return entries.map((e) => {
    if (counts.get(e.category) <= 1) return { ...e, label: e.category };
    const n = (seen.get(e.category) || 0) + 1;
    seen.set(e.category, n);
    return { ...e, label: `${e.category}${n}` };
  });
}

// ── Small helpers ────────────────────────────────────────────
// Escapes plain-data strings (names, status text, act labels) before they're
// interpolated into generated LaTeX source. NEVER applied to
// scene.scriptBody, which is already real LaTeX written by a human in the
// Manus tab — escaping that would double-escape every macro in it. Also
// never applied to scene.name/title (see buildSceneTex/buildAktoversigtTex/
// buildRolleoversigtTex below) — a title may itself be real LaTeX (e.g.
// "$\chi$-faktor", typed via the Manus tab's title header field), same
// reasoning as scriptBody/writtenBy/melody.
function texEscape(value) {
  return String(value == null ? '' : value).replace(/[\\&%$#_{}~^]/g, (c) => {
    switch (c) {
      case '\\': return '\\textbackslash{}';
      case '~': return '\\textasciitilde{}';
      case '^': return '\\textasciicircum{}';
      default: return '\\' + c;
    }
  });
}

// Mirrors archive.js's slugifyFolderName() convention (CLAUDE.md: "spaces→_,
// æøå transliterated, everything else stripped") — used only as a fallback
// filename for a scene that has no sourcePdf yet (see deriveSourcePdfPath).
const TRANSLIT = { æ: 'ae', ø: 'oe', å: 'aa', Æ: 'Ae', Ø: 'Oe', Å: 'Aa' };
function slugify(name) {
  return String(name)
    .split('').map((ch) => TRANSLIT[ch] || ch).join('')
    .trim().replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '');
}

// Bandsang is treated as song-like: it has lyrics (scriptBody), typeset the
// same way a 'sang' scene is (melody, etc.), just with no cast/roles.
function isSongScene(scene) { return (scene.types || []).some((t) => t === 'sang' || t === 'bandsang'); }
function isDansScene(scene) { return (scene.types || []).includes('dans'); }
function hasScript(scene) {
  return !!scene.scriptBody && (scene.types || []).some((t) => t === 'sketch' || t === 'sang' || t === 'bandsang' || t === 'video');
}

// A manually-added video/bandsang row (see js/manus.js's "Videoer &
// Bandsange" card) has no rehearsable cast and is never schedulable in
// Øveplan — Rolleoversigt (the "Rollefordeling" PDF) exists to show who's
// cast where for rehearsal-scheduling purposes, so these rows are excluded
// from it entirely (mirrors js/manus.js's own manusRowIsManualMedia(), which
// checks `types`, not `origin`, for the identical reason). Manuskript (the
// "Manus" PDF), by contrast, must include everything — see hasScript above.
function isMediaScene(scene) { return (scene.types || []).some((t) => t === 'video' || t === 'bandsang'); }

function deriveSourcePdfPath(scene, currentFolder) {
  if (scene.sourcePdf) return scene.sourcePdf;
  const folder = isSongScene(scene) ? 'songs' : 'sketches';
  return `archive/${currentFolder}/${folder}/${slugify(scene.name)}.pdf`;
}

// Mirrors deriveSourcePdfPath, but for the composed .tex itself (see the
// per-scene compile loop in main(), step 1) — the final, freshly-recomposed
// script source (current cast/roles + current scriptBody) is written back to
// this same path, overwriting whatever was originally submitted there, so
// archive/<folder>/{sketches,songs}/ always reflects the truly final text
// rather than the as-submitted draft.
function deriveSourceTexPath(scene, currentFolder) {
  if (scene.sourceTex) return scene.sourceTex;
  const folder = isSongScene(scene) ? 'songs' : 'sketches';
  return `archive/${currentFolder}/${folder}/${slugify(scene.name)}.tex`;
}

// data/scenes.json has no `melody` field (Main Manus View dropped its melody
// UI — see js/manus.js's own note) even though every submitted song .tex
// still carries a real `\melody{Kunstner: "Originaltitel"}` line (from
// manus/skabelon-sang.tex's own template). Rather than round-tripping that
// through the Manus tool, Aktoversigt just reads it straight off the song's
// already-on-disk sourceTex at generation time — cheap, and always in sync
// with whatever the actual submitted script says.
function extractTexMelody(texSource) {
  const m = texSource.match(/\\melody\{([^}]*)\}/);
  return m ? m[1].trim() : '';
}

// Same situation as melody, one macro over: data/scenes.json has no
// `writtenBy` field, but every real submitted .tex (sketch or song alike)
// has its own `\author{...}` line naming who wrote it (from either
// skabelon's own template), never round-tripped anywhere either.
function extractTexAuthor(texSource) {
  const m = texSource.match(/\\author\{([^}]*)\}/);
  return m ? m[1].trim() : '';
}

// ── Per-scene .tex (mirrors manus/skabelon-sketch.tex/skabelon-sang.tex) ──
// One place computing a scene's cast labels — reused by both the roles
// block below and Rolleoversigt's per-actor columns, so a scene's \role{}
// codes and its Rolleoversigt cells never disagree with each other.
// Prefers a cast entry's real, imported/hand-entered roleCode/description
// (from the Manus page's Rollefordeling tab — see manus.js's own
// castRoleLabels()/manusImportFromTex() for why those exist and how they get
// there) over the auto-generated category+ordinal fallback: a real code
// (e.g. "S1") is what any already-existing scriptBody's \says{}/\sings{}
// calls actually reference, so it must win whenever present.
function sceneCastLabels(scene) {
  const isSong = isSongScene(scene);
  const isDans = isDansScene(scene);
  const entries = (scene.cast || [])
    .filter((c) => c.name && c.role)
    .map((c) => ({
      name: c.name,
      category: classifyOrKeep(c.role, isSong, isDans),
      roleCode: (c.roleCode || '').trim(),
      description: (c.description || '').trim(),
    }));
  return castRoleLabels(entries).map((e) => ({
    name: e.name,
    label: e.roleCode || e.label,
    description: e.description || e.category,
  }));
}

function buildRolesBlock(scene) {
  const labeled = sceneCastLabels(scene);
  if (!labeled.length) return '';
  const lines = labeled.map((e) => `\\role{${texEscape(e.label)}}[${texEscape(e.name)}] ${texEscape(e.description)}`);
  return `\\begin{roles}\n${lines.join('\n')}\n\\end{roles}\n\n`;
}

// amsmath/amssymb are loaded unconditionally: this is a math student revue,
// so scriptBody routinely contains real math notation (e.g. \mathbb{R}) that
// plain LaTeX has no macro for.
function buildSceneTex(scene, prodMeta) {
  const envName = isSongScene(scene) ? 'song' : 'sketch';

  let preamble = '';
  preamble += `\\revyname{${texEscape(scene.sourceProduction || prodMeta.name)}}\n`;
  preamble += `\\revyyear{${texEscape(scene.sourceYear || prodMeta.year)}}\n`;
  preamble += `\\version{${texEscape(prodMeta.version)}}\n`;
  if (scene.duration != null && scene.duration !== '') preamble += `\\eta{${texEscape(scene.duration)} minutter}\n`;
  if (scene.status) preamble += `\\status{${texEscape(scene.status)}}\n`;
  // scene.name/title is raw LaTeX, same as writtenBy/melody just below (e.g.
  // "$\chi$-faktor", typed via the Manus tab's title header field) —
  // texEscape-ing it here would corrupt it into literal escaped text
  // instead of compiling. Insert verbatim, same as scriptBody.
  preamble += `\n\\title{${scene.name}}\n`;
  // writtenBy/melody are raw LaTeX straight out of the scene's own real
  // \author{}/\melody{} lines (see extractTexAuthor/extractTexMelody) —
  // already properly escaped by whoever originally wrote the .tex, so
  // texEscape-ing them here would double-escape (e.g. turn a real "\&"
  // into a literal backslash-ampersand on the page). Insert verbatim, same
  // as scriptBody.
  if (scene.writtenBy) preamble += `\\author{${scene.writtenBy}}\n`;
  if (isSongScene(scene) && scene.melody) preamble += `\\melody{${scene.melody}}\n`;

  return `\\documentclass[a4paper,11pt]{article}

\\usepackage{revy}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[danish]{babel}
\\usepackage{amsmath,amssymb}

${preamble}
\\begin{document}
\\maketitle

${buildRolesBlock(scene)}\\begin{${envName}}
${scene.scriptBody}
\\end{${envName}}
\\end{document}
`;
}

// ── Aktoversigt (mirrors RevyTeX's scripts/acts.pl) ─────────────
function formatMinutes(n) {
  return String(Number(n) || 0);
}

function buildAktoversigtTex(actsData, prodMeta) {
  let body = '';
  for (const act of actsData) {
    const total = act.scenes.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
    body += `\\section*{${texEscape(act.label)} \\small{\\textbf{\\emph{(Tidsestimat: ${formatMinutes(total)} minutter)}}}}\n`;
    body += '\\begin{enumerate}\n';
    for (const s of act.scenes) {
      // s.name/title is raw LaTeX, not escaped — see texEscape's own doc
      // comment above.
      body += `  \\item \\textbf{${s.name}}`;
      // s.melody is raw LaTeX straight out of a real \melody{} line (see
      // extractTexMelody) — already properly escaped by whoever wrote the
      // scene's .tex (e.g. "S\&M"), so texEscape-ing it here would
      // double-escape it into a literal backslash. Insert verbatim, same
      // as scriptBody above.
      if (s.melody) body += ` (${s.melody})`;
      body += ` \\\\\n      \\small{\\emph{Tidsestimat: ${formatMinutes(s.duration)} minutter}}\n`;
    }
    body += '\\end{enumerate}\n\n';
  }

  return `\\documentclass[danish]{article}
\\usepackage{revy}
\\usepackage{babel}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
% The reference Aktoversigt.pdf (old Perl toolchain output) is US Letter
% with ~30mm/26mm side margins from plain \\documentclass{article} defaults
% — but pdfTeX's own default output paper size is driver/install-dependent
% (this machine's TeX Live defaults to A4 when nothing else says otherwise),
% which silently produced a much wider, mismatched page here. Pinning both
% paper size and margin explicitly makes the output reproducible across
% machines instead of inheriting whatever the local install happens to
% default to (same reasoning as Rolleoversigt's explicit geometry call).
% margin bumped up slightly from a plain 1in per feedback ("a bit more, a
% tab's worth"); headsep pulled way in from geometry's ~25pt default so the
% title block (start of the text body) sits right under the date instead of
% a big blank gap below it. top/bottom are set separately from left/right,
% both at half of 1.3in, to match the tightened whitespace top and bottom.
\\usepackage[letterpaper,margin=1.3in,top=0.65in,bottom=0.65in,headheight=14pt,headsep=6pt]{geometry}
\\usepackage{fancyhdr}

\\title{Aktoversigt}
\\version{${texEscape(prodMeta.version)}}
\\revyname{${texEscape(prodMeta.name)}}
\\revyyear{${texEscape(prodMeta.year)}}

\\begin{document}
% revy.sty's own \\ps@revyheadings (its default \\pagestyle, set at the end
% of the .sty) draws a Version/date/title/Side-X-of-Y running header with a
% rule under it on every page — replaced here with a single, undecorated
% "generated on" date in the top-right corner instead, via fancyhdr rather
% than fighting revy.sty's own header macros.
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[R]{\\today}
\\renewcommand{\\headrulewidth}{0pt}
\\maketitle

${body}\\end{document}
`;
}

// ── Rolleoversigt (mirrors RevyTeX's scripts/roles.pl) ──────────
// roles.pl builds its rotated-header column list via a Perl/TeX catcode
// trick, since it has to expand a `|`-joined name list at LaTeX-compile
// time. This script already has the actor list as a plain JS array before
// any TeX is emitted, so it just writes one `&\actor{Name}` column header
// per actor directly — same visual result, no macro trickery needed.
function buildRolleoversigtTex(actsData, prodMeta) {
  // Only schedulable scenes (sketches/songs) belong here — see isMediaScene's
  // own doc comment above for why video/bandsang rows are excluded.
  const actsSchedulable = actsData.map((act) => ({
    ...act,
    scenes: act.scenes.filter((s) => !isMediaScene(s)),
  }));

  const actorSet = new Set();
  for (const act of actsSchedulable) {
    for (const s of act.scenes) {
      for (const c of s.cast || []) if (c.name) actorSet.add(c.name);
    }
  }
  const actors = Array.from(actorSet).sort((a, b) => a.localeCompare(b, 'da'));
  const n = actors.length;

  let header = '&Sketch / Navn\n';
  for (const name of actors) header += `&\\actor{${texEscape(name)}}\n`;
  header += '\\\\\\hline\n';

  let body = '';
  for (const act of actsSchedulable) {
    body += `\\multicolumn{${n + 2}}{|l|}{\\textbf{${texEscape(act.label)}}}\\\\\n\\hline\n`;
    act.scenes.forEach((s, i) => {
      const labelByActor = new Map(sceneCastLabels(s).map((e) => [e.name, e.label]));
      // s.name/title is raw LaTeX, not escaped — see texEscape's own doc
      // comment above.
      body += `${i + 1} & ${s.name}`;
      for (const name of actors) {
        const label = labelByActor.get(name);
        body += ` & ${label ? texEscape(label) : '\\q'}`;
      }
      body += ' \\\\\n\\hline\n';
    });
  }

  return `\\documentclass[landscape,a3paper]{article}
\\usepackage{revy}
\\usepackage[danish]{babel}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{graphicx}
% Symmetric margins on all four sides, with header/footer space zeroed out
% (pagestyle is empty below, so nothing is ever drawn in headsep/footskip) —
% mixing raw \\textwidth/\\textheight/\\headsep overrides with the geometry
% package (the previous approach) left top/bottom asymmetric, since geometry
% doesn't know to rebalance around dimensions set after it loads.
\\usepackage[a3paper,landscape,margin=15mm,headheight=0pt,headsep=0pt,footskip=0pt]{geometry}

\\frenchspacing
\\pagestyle{empty}

% \\enddocument (redefined by revy.sty) unconditionally writes \\@version to
% the .aux file regardless of whether \\maketitle is ever called; \\@version
% has no safe default (unlike \\@revyname/\\@revyyear) and falls back to an
% interactive \\typein prompt, fatal under -interaction=nonstopmode. Setting
% \\version{} here avoids that even though this document never displays it.
\\version{${texEscape(prodMeta.version)}}

\\newcommand{\\q}{\\rule{5.5mm}{0mm}}
\\newcommand{\\actor}[1]{\\rotatebox{90}{#1\\ }}

\\begin{document}
% A page-level \\vfill (even anchored with \\null) is still subject to TeX's
% page-breaker treating it as a near-zero-badness break point, which can
% split the title from the table onto separate pages instead of centering
% them. Wrapping everything in one explicit \\vbox to \\textheight resolves
% the fill glue deterministically inside a single atomic, unbreakable box.
\\vbox to \\textheight{
\\vfil
\\begin{center}
{\\Large ${texEscape(prodMeta.name)} ${texEscape(prodMeta.year)}}\\\\[2mm]
{\\LARGE\\bf Rolleoversigt}\\\\[6mm]

% Scale to fill \\textwidth first (today's behavior); if that would make the
% table taller than the height budget left after the title block (~35mm),
% measure it and rescale by height instead. This keeps a small table (fewer
% scenes) filling the full width like today, while a much larger table (many
% more rows than the current production's 32 scenes) shrinks to fit instead
% of overflowing past the page — correct for any future season's data, with
% no hardcoded size that needs re-tuning by hand. Both calls use the
% *starred* \\resizebox*, which targets total height (\\ht+\\dp) — the
% unstarred form only pins \\ht, silently leaving \\dp (a tabular's last-row
% depth) to scale along uncontrolled, which undershoots our \\ifdim budget.
\\setbox0=\\hbox{\\resizebox*{\\textwidth}{!}{%
\\begin{tabular}{|rl|*{${n}}{@{}c@{}|}}
\\hline
${header}
${body}\\end{tabular}%
}}%
\\ifdim\\dimexpr\\ht0+\\dp0\\relax>\\dimexpr\\textheight-35mm\\relax
\\setbox0=\\hbox{\\resizebox*{!}{\\dimexpr\\textheight-35mm\\relax}{%
\\begin{tabular}{|rl|*{${n}}{@{}c@{}|}}
\\hline
${header}
${body}\\end{tabular}%
}}%
\\fi
% \\box0 alone here relies on \\centering's \\leftskip/\\rightskip glue to
% split the leftover \\textwidth - \\wd0 evenly — confirmed by measuring a
% real compiled page that this does NOT happen reliably for a single boxed
% object mid-paragraph inside this nested \\vbox (it rendered flush against
% the left margin instead, with all the slack pushed to the right). Wrapping
% in \\makebox[\\textwidth]{...} sidesteps that: \\makebox centers its
% content by default via its own self-contained glue, independent of the
% surrounding paragraph's leftskip/rightskip.
\\makebox[\\textwidth]{\\box0}
\\end{center}
\\vfil
}
\\end{document}
`;
}

// ── Program (mirrors the old hand-maintained program.tex, now driven by
// data/program.json's boss-edited Medvirkende/Ordliste/QR-codes plus the
// same act/scene data Aktoversigt.pdf uses) ─────────────────────
// Resolves the front-cover image (this production's own Arkiv cover photo,
// data/archive.json's coverImage for the currentFolder entry) and the
// back-cover image (always the sitewide placeholder, same file archive.js
// itself falls back to when a year has no cover photo — see
// ARCHIVE_PLACEHOLDER_COVER there) — both repo-relative paths, resolved
// before compiling so a missing/empty coverImage never fails the build.
function resolveProgramImages(currentFolder) {
  const PLACEHOLDER = 'archive/_assets/placeholder-cover.jpg';
  const archiveJson = readJson('data/archive.json');
  const entry = (archiveJson.years || []).find((y) => y.folder === currentFolder);
  const coverRel = (entry && entry.coverImage) || PLACEHOLDER;
  return { coverRel, backRel: PLACEHOLDER };
}

// Renders one QR PNG per qrCodes[] entry directly into workDir, from its
// admin-entered `url` — no image is ever uploaded/stored, see save_program's
// own doc comment in server/update-data.php. Entries with an empty/clearly
// invalid url are skipped defensively (already checked server-side, but this
// script also runs against hand-edited data/program.json), returning a
// filename only for the entries that actually got a file written.
async function generateQrFiles(workDir, qrCodes) {
  const QRCode = require('qrcode');
  const filenames = new Map();
  let i = 0;
  for (const qr of qrCodes) {
    if (!qr || typeof qr.url !== 'string' || !/^https?:\/\//i.test(qr.url)) continue;
    const filename = `qr-${i++}.png`;
    await QRCode.toFile(path.join(workDir, filename), qr.url, { type: 'png', width: 600, margin: 1 });
    filenames.set(qr.id, filename);
  }
  return filenames;
}

// Standalone article, no revy.sty (program.tex itself never used it either —
// this is a printed audience programme, not a rehearsal script, so none of
// revy.sty's \role/\begin{sketch}/\maketitle machinery applies). Styled to
// mirror program.tex's own centered/\Huge look, not Aktoversigt.pdf's
// numbered-enumerate/time-estimate style meant for internal rehearsal use.
//
// Escaping: act.label/scene.name/scene.melody are raw, already-valid LaTeX
// straight out of scenes.json (same as buildAktoversigtTex above — a scene's
// title/melody is typed as real LaTeX via the Manus tab, e.g. "$\chi$-faktor"
// or "S\&M"). programData.medvirkende/.ordliste are ALSO raw, already-valid
// LaTeX now — boss-typed through the Program tab's own plain textareas
// (js/manus.js's renderProgramMedvirkendeSection/renderProgramOrdlisteSection,
// mirroring scenes.json's scriptBody box) — so those two are inserted
// verbatim, un-texEscape()'d. This used to be a structured array
// (category/name/note, term/definition) that this function assembled into
// LaTeX itself, alphabetizing ordliste by `term` along the way; with
// free-form LaTeX there's no structured field left to sort by, so both
// content *and* ordering are now entirely the boss's own responsibility,
// same as the original hand-maintained program.tex this feature replaced.
// programData.qrCodes[].label/.url, by contrast, are still plain text typed
// into small structured fields (a URL needs to stay a real URL to generate a
// QR code from) and are ALWAYS run through texEscape() — the opposite
// convention, and easy to get backwards, so don't "fix" one to match the
// other.
// Returns the six sections as SEPARATE standalone LaTeX documents (each with
// its own preamble/\begin{document}/\end{document}) rather than one linear
// .tex — Program.pdf (the plain "Standard" download) and the two booklet
// layouts below need these same six pieces of content in a *different* page
// order, and Medvirkende/Ordliste are open-ended boss-typed LaTeX whose real
// compiled page count can't be known ahead of time. Compiling each section
// on its own (see main(), below) and reassembling the results with pdf-lib
// (composeProgramPdf, below) lets every ordering reuse the exact same
// compiled pages instead of trying to carve page ranges out of one big PDF.
//
// Standard reading order (Program.pdf): front cover, Aktoversigt,
// Medvirkende, Ordliste, QR-koder, back cover.
// Booklet reading order (ProgramHaefte*.pdf, see imposeBooklet below): front
// cover, Aktoversigt, Ordliste, Medvirkende, a run of blank pages, QR-koder,
// back cover — deliberately different from the Standard order. Worked
// backwards from an explicit print-imposition spec: once imposed two-up
// (imposeBooklet's psbook math), this ordering puts Aktoversigt/QR-koder
// facing each other on the sheet nearest the covers and lets Medvirkende
// land as one unbroken spread on the innermost sheet, with the blank run
// (padding out to a multiple of 4 pages) absorbing whatever's left after
// Ordliste — see data/README.md's program.json section. This is a fixed
// template sized for a normal year's Ordliste+Medvirkende fitting on two
// folded A4 sheets (per explicit product decision, not meant to
// auto-rebalance) — if a future year's content grows past that, the fixed
// pairing described above no longer holds and the template needs revisiting
// by hand; imposeBooklet's own padding still keeps the output a foldable
// multiple of 4 pages either way.
//
// Escaping: act.label/scene.name/scene.melody are raw, already-valid LaTeX
// straight out of scenes.json (same as buildAktoversigtTex above — a scene's
// title/melody is typed as real LaTeX via the Manus tab, e.g. "$\chi$-faktor"
// or "S\&M"). programData.medvirkende/.ordliste are ALSO raw, already-valid
// LaTeX now — boss-typed through the Program tab's own plain textareas
// (js/manus.js's renderProgramMedvirkendeSection/renderProgramOrdlisteSection,
// mirroring scenes.json's scriptBody box) — so those two are inserted
// verbatim, un-texEscape()'d. This used to be a structured array
// (category/name/note, term/definition) that this function assembled into
// LaTeX itself, alphabetizing ordliste by `term` along the way; with
// free-form LaTeX there's no structured field left to sort by, so both
// content *and* ordering are now entirely the boss's own responsibility,
// same as the original hand-maintained program.tex this feature replaced.
// programData.qrCodes[].label/.url, by contrast, are still plain text typed
// into small structured fields (a URL needs to stay a real URL to generate a
// QR code from) and are ALWAYS run through texEscape() — the opposite
// convention, and easy to get backwards, so don't "fix" one to match the
// other.
function buildProgramSections(programActs, prodMeta, programData, images) {
  const { coverFile, backFile, qrFiles } = images;

  // Wrapped in a local \baselineskip bump (scoped to this \begin{center}...
  // \end{center} group) so scenes/act headers get noticeably more breathing
  // room than the document's default line spacing — matches the old
  // hand-maintained program.tex, which set the same 20pt around its own
  // Aktoversigt block.
  let aktBody = '\\setlength{\\baselineskip}{20pt}\n';
  for (const act of programActs) {
    aktBody += `\\vskip 18pt\n{\\Large \\bfseries ${texEscape(act.label)}}\n\\vskip 6pt\n`;
    for (const s of act.scenes) {
      aktBody += s.name;
      if (s.melody) aktBody += ` (\\emph{${s.melody}})`;
      aktBody += '\\\\\n';
    }
  }

  const medBody = programData.medvirkende;
  const ordBody = programData.ordliste;

  let qrBody = '';
  for (const qr of programData.qrCodes) {
    const file = qrFiles.get(qr.id);
    if (!file) continue;
    qrBody += `\\vspace*{\\fill}\n\\huge{${texEscape(qr.label)}}\\\\\n\\vspace{10mm}\n\\includegraphics[width=9cm]{${file}}\\\\\n\\vspace*{\\fill}\n`;
  }

  const sectionBodies = {
    frontCover: `% Front cover
\\begin{center}
\\vspace*{\\fill}
\\includegraphics[width=\\textwidth]{${coverFile}}
\\vspace*{\\fill}
\\end{center}`,

    aktoversigt: `% Aktoversigt
\\begin{center}
{\\Huge Aktoversigt}
\\end{center}
\\begin{center}
${aktBody}\\end{center}`,

    medvirkende: `% Medvirkende
\\begin{center}
{\\Huge Medvirkende}
\\end{center}
\\begin{multicols}{2}
${medBody}
\\end{multicols}`,

    ordliste: `% Ordliste
\\begin{center}
{\\Huge Ordliste}
\\end{center}
\\begin{multicols}{2}
\\noindent
${ordBody}
\\end{multicols}`,

    qrKoder: `% QR-koder
\\begin{center}
${qrBody}\\end{center}`,

    backCover: `% Back cover
\\begin{center}
\\vspace*{\\fill}
\\includegraphics[width=0.6\\textwidth]{${backFile}}
\\vspace*{\\fill}
\\end{center}`,
  };

  const preamble = `\\documentclass[a4paper,12pt]{article}
\\usepackage[a4paper, hmargin=2cm, vmargin=1cm]{geometry}
\\usepackage[danish]{babel}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{graphicx}
\\usepackage{multicol}
\\usepackage{soul}
\\newcommand{\\arb}[1]{\\textbf{#1}\\\\}
\\setlength{\\parindent}{0pt}
\\pagestyle{empty}
`;

  const sections = {};
  for (const [key, sectionBody] of Object.entries(sectionBodies)) {
    sections[key] = `${preamble}
\\begin{document}

${sectionBody}

\\end{document}
`;
  }
  return sections;
}

// Reassembles already-compiled section PDFs (raw bytes, keyed however the
// caller likes) into one PDF, in the given order, via pdf-lib. Each part is
// either `{bytes}` (embeds every page of that section) or `{blank: true}`
// (inserts one blank page sized to `pageSize`, an [width, height] pair) —
// used both for Program.pdf's plain section order and for the booklet
// source's reordered-and-padded-to-a-multiple-of-4 order (see
// buildProgramSections' own doc comment above and main(), below).
async function composeProgramPdf(pageSize, parts) {
  const { PDFDocument } = require('pdf-lib');
  const outDoc = await PDFDocument.create();
  for (const part of parts) {
    if (part.blank) {
      // A page added via addPage() with nothing drawn on it has no
      // /Contents stream at all — harmless as a final PDF page, but
      // imposeBooklet's own embedPdf() (pdf-lib) refuses to embed a page
      // with no Contents ("Can't embed page with missing Contents"), so
      // this draws one fully transparent, zero-size rectangle purely to
      // give the page a (no-op) content stream.
      const blankPage = outDoc.addPage(pageSize);
      blankPage.drawRectangle({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });
      continue;
    }
    const srcDoc = await PDFDocument.load(part.bytes);
    const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const page of copiedPages) outDoc.addPage(page);
  }
  return outDoc.save();
}

// Real print imposition: takes an already-assembled reading-order PDF (a
// multiple of 4 pages — see composeProgramPdf's blank-padding above) and
// lays its pages two-up onto landscape A4 sheets in saddle-stitch booklet
// order, so that printing double-sided and folding the stack once down the
// middle reproduces that reading order (page 1 on the front cover, the last
// page on the back cover, etc.) — the classic psbook/pdfbook algorithm.
// `flip` picks which physical duplex-printing convention the output is
// built for — home/office printers disagree on which edge they flip a sheet
// around between sides, and there's no way to detect that from here, so
// this offers both and lets whoever's printing pick whichever comes out
// right-side-up on their own printer: 'vertical' (the default) leaves every
// page upright; 'horizontal' rotates every back side 180° to compensate for
// a printer that flips the other way. Page count is still defensively
// padded to a multiple of 4 here too (Math.max/Math.ceil below) in case a
// caller ever passes an unpadded PDF directly — for a caller that already
// pads via composeProgramPdf this is just a no-op.
async function imposeBooklet(sourcePdfBytes, flip = 'vertical') {
  const { PDFDocument, degrees } = require('pdf-lib');
  const srcDoc = await PDFDocument.load(sourcePdfBytes);
  const pageCount = srcDoc.getPageCount();
  const totalPages = Math.max(4, Math.ceil(pageCount / 4) * 4);

  const outDoc = await PDFDocument.create();
  const embeddedPages = await outDoc.embedPdf(sourcePdfBytes, Array.from({ length: pageCount }, (_, i) => i));
  // 1-indexed lookup matching the imposition formula below; out-of-range
  // (padding) slots resolve to null and are simply left blank.
  const embeddedAt = (pageNum) => (pageNum >= 1 && pageNum <= pageCount ? embeddedPages[pageNum - 1] : null);

  // Landscape A4: swap portrait width/height, split into two equal halves.
  const [firstSrcPage] = srcDoc.getPages();
  const { width: portraitW, height: portraitH } = firstSrcPage.getSize();
  const sheetW = portraitH;
  const sheetH = portraitW;
  const halfW = sheetW / 2;

  const drawHalf = (page, embedded, xOffset) => {
    if (!embedded) return; // padding slot — leave blank
    const scale = Math.min(halfW / embedded.width, sheetH / embedded.height);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    page.drawPage(embedded, { x: xOffset + (halfW - w) / 2, y: (sheetH - h) / 2, width: w, height: h });
  };

  const sheets = totalPages / 4;
  for (let s = 0; s < sheets; s++) {
    const front = outDoc.addPage([sheetW, sheetH]);
    drawHalf(front, embeddedAt(totalPages - 2 * s), 0);
    drawHalf(front, embeddedAt(2 * s + 1), halfW);

    const back = outDoc.addPage([sheetW, sheetH]);
    drawHalf(back, embeddedAt(2 * s + 2), 0);
    drawHalf(back, embeddedAt(totalPages - 2 * s - 1), halfW);
    if (flip === 'horizontal') back.setRotation(degrees(180));
  }

  return outDoc.save();
}

// ── Compiling ────────────────────────────────────────────────
function checkPdflatexAvailable() {
  const result = spawnSync('pdflatex', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      'pdflatex was not found on PATH. This script needs a local TeX Live/MacTeX ' +
      'install — see the header comment in scripts/generate-pdfs.js.'
    );
  }
}

// Runs pdflatex twice in `workDir` (revy.sty's own header comment: "the text
// must be LaTeX'ed twice to get the references right" — the page-count
// cross-reference needs the second pass). Returns the compiled PDF's path.
function compileTex(workDir, texFileName) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.copyFileSync(REVY_STY, path.join(workDir, 'revy.sty'));
  const texPath = path.join(workDir, texFileName);
  for (let pass = 1; pass <= 2; pass++) {
    const result = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', texFileName], {
      cwd: workDir,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const log = (result.stdout || '') + (result.stderr || '');
      throw new Error(`pdflatex failed (pass ${pass}) compiling ${texFileName}:\n${log.slice(-4000)}`);
    }
  }
  return path.join(workDir, texFileName.replace(/\.tex$/, '.pdf'));
}

function writeAndCompile(workDirName, texFileName, texSource) {
  const workDir = path.join(BUILD_DIR, workDirName);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, texFileName), texSource, 'utf8');
  return compileTex(workDir, texFileName);
}

function copyToRepo(builtPdfPath, repoRelativeOut) {
  const dest = root(repoRelativeOut);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(builtPdfPath, dest);
  return dest;
}

function writeTextToRepo(text, repoRelativeOut) {
  const dest = root(repoRelativeOut);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text, 'utf8');
  return dest;
}

function writeBytesToRepo(bytes, repoRelativeOut) {
  const dest = root(repoRelativeOut);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return dest;
}

// ── Manuskript: merge every per-scene PDF behind a title page ───
// Mirrors RevyTeX's manus.pl (which used Perl's PDF::API2) — approximate,
// not pixel-exact tab/bookmark fidelity for v1 (see the plan's noted
// deferred scope). Shared by both the full Manuskript.pdf (no filter, no
// name) and each per-actor manuscript (buildActorManuskripts, below) — a
// scene filter and a personalized name are the only things that differ
// between the two. The old "Skuespiller: ____" blank-line/label was dropped
// per feedback: the master copy doesn't need a name line at all, and an
// individual copy just gets the actor's own name centered under the title
// instead of a labeled fill-in line.
async function buildManuskriptPdf(actsData, prodMeta, scenePdfPaths, outPath, opts = {}) {
  const { skuespillerName = '', sceneFilter = () => true, aktoversigtPdfPath = '' } = opts;
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const out = await PDFDocument.create();

  const boldFont = await out.embedFont(StandardFonts.HelveticaBold);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const titlePage = out.addPage([595.28, 841.89]); // A4
  const { width, height } = titlePage.getSize();
  const title = 'Manuskript';
  const subtitle = `${prodMeta.name} ${prodMeta.year}`;
  const titleSize = 36;
  const subtitleSize = 18;
  const nameSize = 18;
  titlePage.drawText(title, {
    x: width / 2 - boldFont.widthOfTextAtSize(title, titleSize) / 2,
    y: height / 2 + 60,
    size: titleSize,
    font: boldFont,
    color: rgb(0, 0, 0),
  });
  titlePage.drawText(subtitle, {
    x: width / 2 - font.widthOfTextAtSize(subtitle, subtitleSize) / 2,
    y: height / 2 + 20,
    size: subtitleSize,
    font,
    color: rgb(0.2, 0.2, 0.2),
  });
  if (skuespillerName) {
    titlePage.drawText(skuespillerName, {
      x: width / 2 - boldFont.widthOfTextAtSize(skuespillerName, nameSize) / 2,
      y: height / 2 - 20,
      size: nameSize,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
  }

  // The master Manuskript.pdf gets the just-compiled Aktoversigt spliced in
  // right after the title page, ahead of the per-scene scripts (per explicit
  // request) — individual/Sangboss manuscripts don't pass this option, so
  // they stay title-page-then-scripts as before.
  if (aktoversigtPdfPath) {
    const bytes = fs.readFileSync(aktoversigtPdfPath);
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }

  for (const act of actsData) {
    for (const scene of act.scenes) {
      if (!sceneFilter(scene)) continue;
      const pdfPath = scenePdfPaths.get(scene.id);
      if (!pdfPath) continue;
      const bytes = fs.readFileSync(pdfPath);
      const src = await PDFDocument.load(bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    }
  }

  const outBytes = await out.save();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outBytes);
}

// ── Individual manuscripts: one per cast.json roster entry ──────
// Same merge helper as the master Manuskript.pdf, filtered to only the
// scenes that actor is cast in (in act order) and with their name centered
// on the title page. Generated unconditionally for
// every roster entry, even one cast in nothing this cycle (an empty
// manuscript is still a valid, if uneventful, result).
async function buildActorManuskripts(actsData, prodMeta, scenePdfPaths, castRoster, currentFolder) {
  for (const person of castRoster) {
    const name = person.name;
    const outPath = root(`archive/${currentFolder}/manuskripter/${slugify(name)}.pdf`);
    await buildManuskriptPdf(actsData, prodMeta, scenePdfPaths, outPath, {
      skuespillerName: name,
      sceneFilter: (scene) => (scene.cast || []).some((c) => c.name === name),
    });
  }
}

// ── Sangboss: a fixed pseudo-person, not a cast.json roster entry, whose
// manuscript is every song scene regardless of cast — used by whoever is
// responsible for the singers, not for a specific actor's own scenes.
// Generated unconditionally alongside the real per-actor manuscripts.
async function buildSangbossManuskript(actsData, prodMeta, scenePdfPaths, currentFolder) {
  const outPath = root(`archive/${currentFolder}/manuskripter/${slugify('Sangboss')}.pdf`);
  await buildManuskriptPdf(actsData, prodMeta, scenePdfPaths, outPath, {
    skuespillerName: 'Sangboss',
    sceneFilter: (scene) => isSongScene(scene),
  });
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  checkPdflatexAvailable();

  const scenesJson = readJson('data/scenes.json');
  const castJson = readJson('data/cast.json');
  const configJson = readJson('data/config.json');
  const currentFolder = configJson.currentProductionFolder;

  // scenes.json's "production" bakes the year into the same string (e.g.
  // "Matematikrevyen 2026") — revy.sty's \maketitle prints \revyname{} and
  // \revyyear{} side by side, so the year must be split back out here or
  // every title page prints it twice ("Matematikrevyen 2026 2026").
  const productionStr = String(scenesJson.production || '');
  const yearMatch = productionStr.match(/\d{4}/);
  const prodMeta = {
    name: productionStr.replace(/\s*\d{4}\s*/, ' ').trim() || 'Matematikrevyen',
    year: yearMatch ? yearMatch[0] : String(new Date().getFullYear()),
    version: scenesJson.version || new Date().toISOString().slice(0, 10),
  };

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });

  console.log(`Building for ${prodMeta.name} ${prodMeta.year} (production folder: ${currentFolder})`);

  // manus.js stashes still-unplaced video/bandsang rows (created via the
  // "Videoer & Bandsange" card but not yet dragged into a real act) under a
  // reserved 'pool' pseudo-act (MANUS_POOL_ACT_CODE there) purely so a Gem
  // click never silently drops them — see manusBuildActsPayload's own
  // comment. They aren't actually part of the show yet, so every printed
  // deliverable below (Aktoversigt/Rolleoversigt/Manuskript/individual
  // manuscripts/per-scene PDFs) must skip that act entirely, exactly as it
  // already skips a pool sketch/song submission that hasn't been placed.
  const realActs = scenesJson.acts.filter((act) => act.act !== 'pool');

  // Backfill each scene's writtenBy/melody from its own sourceTex (see
  // extractTexAuthor/extractTexMelody's comments) before Aktoversigt and the
  // per-scene .tex rebuild (step 1 below) read scene.writtenBy/melody.
  for (const act of realActs) {
    for (const scene of act.scenes) {
      if (!scene.sourceTex) continue;
      const texPath = root(scene.sourceTex);
      if (!fs.existsSync(texPath)) continue;
      const texSource = fs.readFileSync(texPath, 'utf8');
      if (!scene.writtenBy) {
        const author = extractTexAuthor(texSource);
        if (author) scene.writtenBy = author;
      }
      if (!scene.melody) {
        const melody = extractTexMelody(texSource);
        if (melody) scene.melody = melody;
      }
    }
  }

  // 1) One PDF per sketch/song scene with actual script text. Skipped
  // (no pdflatex spawn at all) when the freshly-composed .tex is
  // byte-identical to what's already archived at deriveSourceTexPath and
  // that scene's PDF already exists on disk — the dominant real workflow is
  // "edit one scene, click Generér", so this turns an always-full-32-scene
  // rebuild into a handful of actual compiles. Note prodMeta.version (baked
  // into every scene's \version{} line via buildSceneTex) is re-stamped to
  // today's date on every manus save, so this cache only holds within the
  // same day — acceptable, since same-day re-generates are the common case.
  const scenePdfPaths = new Map();
  for (const act of realActs) {
    for (const scene of act.scenes) {
      if (!hasScript(scene)) continue;
      const slug = slugify(scene.name) || scene.id;
      const tex = buildSceneTex(scene, prodMeta);
      const destRel = deriveSourcePdfPath(scene, currentFolder);
      const texRel = deriveSourceTexPath(scene, currentFolder);
      const destAbs = root(destRel);
      const texAbs = root(texRel);
      const unchanged = fs.existsSync(destAbs) && fs.existsSync(texAbs)
        && fs.readFileSync(texAbs, 'utf8') === tex;
      if (unchanged) {
        console.log(`  Skipping scene "${scene.name}" (unchanged)`);
        scenePdfPaths.set(scene.id, destAbs);
        continue;
      }
      console.log(`  Compiling scene "${scene.name}"...`);
      const builtPdf = writeAndCompile(`scene-${slug}`, `${slug}.tex`, tex);
      const dest = copyToRepo(builtPdf, destRel);
      scenePdfPaths.set(scene.id, dest);
      // Persist the exact composed .tex that was just compiled (not a
      // separate reconstruction) so the archived source is guaranteed to
      // match the archived PDF byte-for-byte.
      writeTextToRepo(tex, texRel);
    }
  }

  // 2) Aktoversigt.
  console.log('  Compiling Aktoversigt...');
  const aktTex = buildAktoversigtTex(realActs, prodMeta);
  const aktPdf = writeAndCompile('aktoversigt', 'Aktoversigt.tex', aktTex);
  copyToRepo(aktPdf, `archive/${currentFolder}/Aktoversigt.pdf`);

  // 3) Rolleoversigt.
  console.log('  Compiling Rolleoversigt...');
  const roleTex = buildRolleoversigtTex(realActs, prodMeta);
  const rolePdf = writeAndCompile('rolleoversigt', 'Rolleoversigt.tex', roleTex);
  copyToRepo(rolePdf, `archive/${currentFolder}/Rolleoversigt.pdf`);

  // 4) Manuskript — merge every compiled scene PDF, in act order, with
  // Aktoversigt spliced in right after the title page (per explicit
  // request).
  console.log('  Merging Manuskript...');
  await buildManuskriptPdf(realActs, prodMeta, scenePdfPaths, root(`archive/${currentFolder}/Manuskript.pdf`), {
    aktoversigtPdfPath: aktPdf,
  });

  // 5) One personalized manuscript per cast.json roster entry, plus the
  // fixed Sangboss manuscript (every song, regardless of cast).
  console.log('  Building individual manuscripts...');
  await buildActorManuskripts(realActs, prodMeta, scenePdfPaths, castJson.cast, currentFolder);
  await buildSangbossManuskript(realActs, prodMeta, scenePdfPaths, currentFolder);

  // 6) Program — self-hosted printed audience programme booklet (Manus
  // page's "Program" tab). data/program.json is optional (feature just
  // shipped / no admin save yet) — skip gracefully rather than fail the
  // whole run, same bootstrap posture as Budget's "no active budget" state
  // (see CLAUDE.md). The Aktoversigt section explicitly excludes the
  // Ekstranumre act (unlike the internal Aktoversigt.pdf above, which
  // includes it) — a printed audience programme lists only the three real
  // acts.
  const programJsonPath = root('data/program.json');
  if (!fs.existsSync(programJsonPath)) {
    console.log('  Skipping Program.pdf (data/program.json not found yet).');
  } else {
    console.log('  Compiling Program sections...');
    const programJson = readJson('data/program.json');
    const programActs = realActs.filter((act) => act.act !== 'E');
    const { coverRel, backRel } = resolveProgramImages(currentFolder);
    const workDir = path.join(BUILD_DIR, 'program');
    fs.mkdirSync(workDir, { recursive: true });
    const coverFile = 'cover' + path.extname(coverRel);
    const backFile = 'back' + path.extname(backRel);
    fs.copyFileSync(root(coverRel), path.join(workDir, coverFile));
    fs.copyFileSync(root(backRel), path.join(workDir, backFile));
    const qrFiles = await generateQrFiles(workDir, programJson.qrCodes || []);
    const images = { coverFile, backFile, qrFiles };
    const sectionTex = buildProgramSections(programActs, prodMeta, programJson, images);

    // Each section is its own standalone .tex/.pdf (see buildProgramSections'
    // doc comment) — compiled once here and reassembled twice below, in two
    // different orders, via composeProgramPdf.
    const SECTION_FILES = {
      frontCover: 'ProgramFrontCover.tex',
      aktoversigt: 'ProgramAktoversigt.tex',
      medvirkende: 'ProgramMedvirkende.tex',
      ordliste: 'ProgramOrdliste.tex',
      qrKoder: 'ProgramQrKoder.tex',
      backCover: 'ProgramBackCover.tex',
    };
    const sectionBytes = {};
    for (const [key, texFileName] of Object.entries(SECTION_FILES)) {
      fs.writeFileSync(path.join(workDir, texFileName), sectionTex[key], 'utf8');
      sectionBytes[key] = fs.readFileSync(compileTex(workDir, texFileName));
    }

    const { PDFDocument } = require('pdf-lib');
    const pageCountOf = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();
    const pageSize = (await PDFDocument.load(sectionBytes.frontCover)).getPages()[0].getSize();
    const pageSizeArr = [pageSize.width, pageSize.height];

    console.log('  Composing Program.pdf...');
    const standardBytes = await composeProgramPdf(pageSizeArr, [
      { bytes: sectionBytes.frontCover },
      { bytes: sectionBytes.aktoversigt },
      { bytes: sectionBytes.medvirkende },
      { bytes: sectionBytes.ordliste },
      { bytes: sectionBytes.qrKoder },
      { bytes: sectionBytes.backCover },
    ]);
    writeBytesToRepo(standardBytes, `archive/${currentFolder}/Program.pdf`);

    // Booklet source: same six sections, reordered per buildProgramSections'
    // doc comment (front cover, Aktoversigt, Ordliste, Medvirkende, a blank
    // run, QR-koder, back cover), padded here to a multiple of 4 pages so
    // imposeBooklet's own padding below is a no-op.
    const counts = {};
    for (const key of Object.keys(sectionBytes)) counts[key] = await pageCountOf(sectionBytes[key]);
    const bookletContentPages = counts.frontCover + counts.aktoversigt + counts.ordliste
      + counts.medvirkende + counts.qrKoder + counts.backCover;
    const bookletTotalPages = Math.max(4, Math.ceil(bookletContentPages / 4) * 4);
    const blankPad = bookletTotalPages - bookletContentPages;
    const bookletSourceBytes = await composeProgramPdf(pageSizeArr, [
      { bytes: sectionBytes.frontCover },
      { bytes: sectionBytes.aktoversigt },
      { bytes: sectionBytes.ordliste },
      { bytes: sectionBytes.medvirkende },
      ...Array.from({ length: blankPad }, () => ({ blank: true })),
      { bytes: sectionBytes.qrKoder },
      { bytes: sectionBytes.backCover },
    ]);

    // Two imposed layouts, same booklet source — one per duplex-printing
    // convention (see imposeBooklet's own doc comment above). js/manus.js's
    // Program quick-link picker lets a boss choose between all three
    // (Standard/ProgramHaefte/ProgramHaefteHorisontal).
    console.log('  Imposing ProgramHaefte (vertikal flip)...');
    const bookletVertical = await imposeBooklet(bookletSourceBytes, 'vertical');
    writeBytesToRepo(bookletVertical, `archive/${currentFolder}/ProgramHaefte.pdf`);

    console.log('  Imposing ProgramHaefte (horisontal flip)...');
    const bookletHorizontal = await imposeBooklet(bookletSourceBytes, 'horizontal');
    writeBytesToRepo(bookletHorizontal, `archive/${currentFolder}/ProgramHaefteHorisontal.pdf`);
  }

  console.log(
    `Done. Wrote Aktoversigt.pdf / Rolleoversigt.pdf / Manuskript.pdf plus ${castJson.cast.length} ` +
    `individual manuscripts (+ Sangboss) to archive/${currentFolder}/`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  texEscape, slugify, classifyOrKeep, castRoleLabels, sceneCastLabels, hasScript, isMediaScene, deriveSourcePdfPath,
  deriveSourceTexPath,
  extractTexMelody, extractTexAuthor,
  buildSceneTex, buildAktoversigtTex, buildRolleoversigtTex, buildManuskriptPdf, buildActorManuskripts,
  buildSangbossManuskript,
  resolveProgramImages, generateQrFiles, buildProgramSections, composeProgramPdf, imposeBooklet,
};
