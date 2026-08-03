/* =========================================================
   Matematikrevyen – Active scene/cast data source
   Scheduling data comes from the embedded SCENES_DATA / CAST_DATA
   globals (scenes-data.js, generated from data/*.json). A Manus page
   save (manus.js's manusSaveMain()) writes those files globally via
   server/update-data.php, then reloads once the GitHub Action has
   regenerated scenes-data.js — but that round trip takes a minute or
   two, so a successful save also sets an in-memory shadow here for
   instant same-tab feedback, mirrored into localStorage (via
   site-utils.js's siteSaveOverride, resource 'manus', same TTL/shape
   as the calendar/posts/archive overrides). getEffectiveScenesData/
   getEffectiveCastData check the in-memory shadow first (this tab's
   own most recent save, if any) and fall back to the persisted one
   (siteLoadOverride) so navigating back to manus.html — a fresh page
   load, in-memory shadow gone — still reflects a still-fresh save
   instead of the stale embedded data, exactly like reopening any
   other data-driven page. Øveplan (schedule.js) reads the same
   localStorage key directly (it doesn't load this file or
   site-utils.js, to keep working over file://) — see its
   loadManusOverride()/loadScenes() for why it additionally never
   consults it once a grid has real placements, a constraint that
   doesn't apply here since manus.js has no equivalent "already placed
   and referenced by id" state that a fresher override could orphan.
   Loaded only by manus.html.
   ========================================================= */

'use strict';

let manusSavedOverride = null;

function setManusSavedOverride(data) {
  manusSavedOverride = data;
  siteSaveOverride('manus', data);
}

function getManusOverride() {
  return manusSavedOverride || siteLoadOverride('manus');
}

function getEffectiveScenesData() {
  const override = getManusOverride();
  return override ? override.scenes : SCENES_DATA;
}

function getEffectiveCastData() {
  const override = getManusOverride();
  return override ? override.cast : CAST_DATA;
}
