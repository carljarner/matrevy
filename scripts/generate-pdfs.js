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
// *reads* it and writes disposable, regeneratable .tex/.pdf output. It never
// writes back into archive/<folder>/'s stored .tex sources.
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
// Escapes plain-data strings (titles, names, status text, act labels) before
// they're interpolated into generated LaTeX source. NEVER applied to
// scene.scriptBody, which is already real LaTeX written by a human in the
// Manus tab — escaping that would double-escape every macro in it.
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

function isSongScene(scene) { return (scene.types || []).includes('sang'); }
function isDansScene(scene) { return (scene.types || []).includes('dans'); }
function hasScript(scene) {
  return !!scene.scriptBody && (scene.types || []).some((t) => t === 'sketch' || t === 'sang');
}

function deriveSourcePdfPath(scene, currentFolder) {
  if (scene.sourcePdf) return scene.sourcePdf;
  const folder = isSongScene(scene) ? 'songs' : 'sketches';
  return `archive/${currentFolder}/${folder}/${slugify(scene.name)}.pdf`;
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

function buildSceneTex(scene, prodMeta) {
  const envName = isSongScene(scene) ? 'song' : 'sketch';

  let preamble = '';
  preamble += `\\revyname{${texEscape(scene.sourceProduction || prodMeta.name)}}\n`;
  preamble += `\\revyyear{${texEscape(scene.sourceYear || prodMeta.year)}}\n`;
  preamble += `\\version{${texEscape(prodMeta.version)}}\n`;
  if (scene.duration != null && scene.duration !== '') preamble += `\\eta{${texEscape(scene.duration)} minutter}\n`;
  if (scene.status) preamble += `\\status{${texEscape(scene.status)}}\n`;
  preamble += `\n\\title{${texEscape(scene.name)}}\n`;
  if (scene.writtenBy) preamble += `\\author{${texEscape(scene.writtenBy)}}\n`;
  if (isSongScene(scene) && scene.melody) preamble += `\\melody{${texEscape(scene.melody)}}\n`;

  return `\\documentclass[a4paper,11pt]{article}

\\usepackage{revy}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[danish]{babel}

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
      body += `  \\item \\textbf{${texEscape(s.name)}} `;
      if (s.melody) body += `(${texEscape(s.melody)}) `;
      body += `\\emph{${texEscape(s.sourceProduction || prodMeta.name)} ${texEscape(s.sourceYear || prodMeta.year)}} \\\\\n`;
      body += `      \\small{Status: ${texEscape(s.status || 'Ikke færdig')}, \\emph{Tidsestimat: ${formatMinutes(s.duration)} minutter}}\n`;
    }
    body += '\\end{enumerate}\n\n';
  }

  return `\\documentclass[danish]{article}
\\usepackage{revy}
\\usepackage{babel}
\\usepackage[utf8]{inputenc}

\\title{Aktoversigt}
\\version{${texEscape(prodMeta.version)}}
\\revyname{${texEscape(prodMeta.name)}}
\\revyyear{${texEscape(prodMeta.year)}}

\\begin{document}
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
  const actorSet = new Set();
  for (const act of actsData) {
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
  for (const act of actsData) {
    body += `\\multicolumn{${n + 2}}{|l|}{\\textbf{${texEscape(act.label)}}}\\\\\n\\hline\n`;
    act.scenes.forEach((s, i) => {
      const labelByActor = new Map(sceneCastLabels(s).map((e) => [e.name, e.label]));
      body += `${i + 1} & ${texEscape(s.name)}`;
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
\\usepackage[a3paper]{geometry}

\\frenchspacing

\\newcommand{\\q}{\\rule{5.5mm}{0mm}}
\\newcommand{\\actor}[1]{\\rotatebox{90}{#1\\ }}

\\title{\\large{Rolleoversigt}}
\\revyname{${texEscape(prodMeta.name)}}
\\revyyear{${texEscape(prodMeta.year)}}
\\version{${texEscape(prodMeta.version)}}

\\textwidth 360mm
\\textheight 260mm
\\evensidemargin 0pt
\\oddsidemargin 0pt
\\headsep 1cm

\\begin{document}
\\begin{center}
\\maketitle

\\begin{tabular}{|rl|*{${n}}{@{}c@{}|}}
\\hline
${header}
${body}\\end{tabular}
\\end{center}
\\end{document}
`;
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

// ── Manuskript: merge every per-scene PDF behind a title page ───
// Mirrors RevyTeX's manus.pl (which used Perl's PDF::API2) — approximate,
// not pixel-exact tab/bookmark fidelity for v1 (see the plan's noted
// deferred scope).
async function buildManuskript(actsData, prodMeta, scenePdfPaths, outPath) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const out = await PDFDocument.create();

  const font = await out.embedFont(StandardFonts.HelveticaBold);
  const titlePage = out.addPage([595.28, 841.89]); // A4
  const { width, height } = titlePage.getSize();
  const title = 'Manuskript';
  const subtitle = `${prodMeta.name} ${prodMeta.year}`;
  titlePage.drawText(title, {
    x: width / 2 - font.widthOfTextAtSize(title, 28) / 2,
    y: height / 2 + 20,
    size: 28,
    font,
    color: rgb(0, 0, 0),
  });
  titlePage.drawText(subtitle, {
    x: width / 2 - font.widthOfTextAtSize(subtitle, 14) / 2,
    y: height / 2 - 10,
    size: 14,
    font,
    color: rgb(0.2, 0.2, 0.2),
  });

  for (const act of actsData) {
    for (const scene of act.scenes) {
      const pdfPath = scenePdfPaths.get(scene.id);
      if (!pdfPath) continue;
      const bytes = fs.readFileSync(pdfPath);
      const src = await PDFDocument.load(bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    }
  }

  const bytes = await out.save();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bytes);
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  checkPdflatexAvailable();

  const scenesJson = readJson('data/scenes.json');
  const configJson = readJson('data/config.json');
  const currentFolder = configJson.currentProductionFolder;

  const yearMatch = String(scenesJson.production || '').match(/\d{4}/);
  const prodMeta = {
    name: scenesJson.production || 'Matematikrevyen',
    year: yearMatch ? yearMatch[0] : String(new Date().getFullYear()),
    version: scenesJson.version || new Date().toISOString().slice(0, 10),
  };

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });

  console.log(`Building for ${prodMeta.name} ${prodMeta.year} (production folder: ${currentFolder})`);

  // 1) One PDF per sketch/song scene with actual script text.
  const scenePdfPaths = new Map();
  for (const act of scenesJson.acts) {
    for (const scene of act.scenes) {
      if (!hasScript(scene)) continue;
      const slug = slugify(scene.name) || scene.id;
      const tex = buildSceneTex(scene, prodMeta);
      console.log(`  Compiling scene "${scene.name}"...`);
      const builtPdf = writeAndCompile(`scene-${slug}`, `${slug}.tex`, tex);
      const destRel = deriveSourcePdfPath(scene, currentFolder);
      const dest = copyToRepo(builtPdf, destRel);
      scenePdfPaths.set(scene.id, dest);
    }
  }

  // 2) Aktoversigt.
  console.log('  Compiling Aktoversigt...');
  const aktTex = buildAktoversigtTex(scenesJson.acts, prodMeta);
  const aktPdf = writeAndCompile('aktoversigt', 'Aktoversigt.tex', aktTex);
  copyToRepo(aktPdf, `archive/${currentFolder}/Aktoversigt.pdf`);

  // 3) Rolleoversigt.
  console.log('  Compiling Rolleoversigt...');
  const roleTex = buildRolleoversigtTex(scenesJson.acts, prodMeta);
  const rolePdf = writeAndCompile('rolleoversigt', 'Rolleoversigt.tex', roleTex);
  copyToRepo(rolePdf, `archive/${currentFolder}/Rolleoversigt.pdf`);

  // 4) Manuskript — merge every compiled scene PDF, in act order.
  console.log('  Merging Manuskript...');
  await buildManuskript(scenesJson.acts, prodMeta, scenePdfPaths, root(`archive/${currentFolder}/Manuskript.pdf`));

  console.log(`Done. Wrote Aktoversigt.pdf / Rolleoversigt.pdf / Manuskript.pdf to archive/${currentFolder}/`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  texEscape, slugify, classifyOrKeep, castRoleLabels, sceneCastLabels, hasScript, deriveSourcePdfPath,
  buildSceneTex, buildAktoversigtTex, buildRolleoversigtTex,
};
