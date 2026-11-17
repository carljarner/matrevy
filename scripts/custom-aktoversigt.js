'use strict';
// Compiles a one-off Aktoversigt with only the scenes a boss picked in
// Manus's "Aktfordeling → Custom" modal. Same LaTeX template as the
// standard Aktoversigt.pdf (generate-pdfs.js's buildAktoversigtTex).
//
//   node scripts/custom-aktoversigt.js <dir>/<jobId>.request.json
//
// update-data.php's manus_custom_aktoversigt writes the request
// ({jobId, keys, requestedAt}; keys = scene uids, see sceneUid) into
// /data/site/generated/custom-akt/ (not web-served), and server/worker.sh
// runs this script once per request file, then deletes it. The result goes
// next to the request: <jobId>.pdf, then <jobId>.json ({state: done|failed,
// message?}) last, so a status file means the PDF is already in place.
// manus_custom_aktoversigt_status hands the PDF to the page and deletes both.
//
// Never touches archive/, .pdf-build/ or the main pdf-status.json, so it can
// run between two full builds without disturbing either.

const fs = require('fs');
const path = require('path');
const {
  root, readJson, compileTex, buildProdMeta, backfillTexMeta, sceneUid, buildAktoversigtTex,
} = require('./generate-pdfs.js');

const JOB_ID_RE = /^[a-f0-9]{16}$/;
// Abandoned jobs (the page was closed before it fetched the PDF).
const MAX_AGE_MS = 60 * 60 * 1000;

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function removeOldFiles(dir) {
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch (e) { /* already gone */ }
  }
}

function run(requestPath) {
  const dir = path.dirname(requestPath);
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const jobId = String(request.jobId || '');
  if (!JOB_ID_RE.test(jobId)) throw new Error(`invalid jobId in ${requestPath}`);
  const statusPath = path.join(dir, `${jobId}.json`);
  const writeStatus = (status) => writeAtomic(statusPath, JSON.stringify(status));

  const buildDir = root(path.join('.pdf-build-custom', jobId));
  try {
    const keys = new Set(Array.isArray(request.keys) ? request.keys.map(String) : []);
    const scenesJson = readJson('data/scenes.json');
    // Same act list as the standard Aktoversigt (the reserved 'pool'
    // pseudo-act is never printed); acts with nothing picked are dropped,
    // since LaTeX rejects an empty enumerate.
    const acts = scenesJson.acts
      .filter((act) => act.act !== 'pool')
      .map((act) => ({ ...act, scenes: act.scenes.filter((s) => keys.has(sceneUid(s))) }))
      .filter((act) => act.scenes.length > 0);
    if (!acts.length) {
      writeStatus({ state: 'failed', message: 'Ingen af de valgte scener findes længere.' });
      return;
    }
    backfillTexMeta(acts);
    const tex = buildAktoversigtTex(acts, buildProdMeta(scenesJson));
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'Aktoversigt.tex'), tex, 'utf8');
    const pdf = compileTex(buildDir, 'Aktoversigt.tex');
    writeAtomic(path.join(dir, `${jobId}.pdf`), fs.readFileSync(pdf));
    writeStatus({ state: 'done' });
  } catch (err) {
    const latex = err && err.latex && err.latex.message;
    writeStatus({ state: 'failed', message: latex ? `LaTeX-fejl: ${latex}` : 'PDF-generatoren fejlede.' });
    throw err;
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node scripts/custom-aktoversigt.js <jobId>.request.json');
    process.exit(2);
  }
  try {
    run(path.resolve(requestPath));
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
  try { removeOldFiles(path.dirname(path.resolve(requestPath))); } catch (e) { /* ignore */ }
}
