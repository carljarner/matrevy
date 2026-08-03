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
   as the calendar/posts/archive overrides) purely so a *freshly
   loaded* Øveplan session — nothing built on the grid yet, see
   schedule.js's loadManusOverride()/loadScenes() — can start from it
   too, without waiting on the GitHub Action. This file's own reads
   (getEffectiveScenesData/getEffectiveCastData) deliberately stay
   in-memory-only, unaffected by that persistence.
   Loaded only by manus.html now — Øveplan (schedule.js) reads the
   same localStorage key directly (it doesn't load this file or
   site-utils.js, to keep working over file://) but is otherwise a
   read-only consumer of the plain embedded globals.
   ========================================================= */

'use strict';

let manusSavedOverride = null;

function setManusSavedOverride(data) {
  manusSavedOverride = data;
  siteSaveOverride('manus', data);
}

function getEffectiveScenesData() {
  return manusSavedOverride ? manusSavedOverride.scenes : SCENES_DATA;
}

function getEffectiveCastData() {
  return manusSavedOverride ? manusSavedOverride.cast : CAST_DATA;
}
