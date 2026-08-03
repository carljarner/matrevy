/* =========================================================
   Matematikrevyen – Active scene/cast data source
   Scheduling data comes from the embedded SCENES_DATA / CAST_DATA
   globals (scenes-data.js, generated from data/*.json). A Manus page
   save (manus.js's manusSaveMain()) writes those files globally via
   server/update-data.php, then reloads once the GitHub Action has
   regenerated scenes-data.js — but that round trip takes a minute or
   two, so a successful save also sets an in-memory (page-lifetime
   only, never persisted) shadow here for instant same-tab feedback.
   Loaded only by manus.html now — Øveplan (schedule.js) is a
   read-only consumer of the plain embedded globals and doesn't load
   this file, since it has no same-tab save of its own to shadow.
   ========================================================= */

'use strict';

let manusSavedOverride = null;

function setManusSavedOverride(data) {
  manusSavedOverride = data;
}

function getEffectiveScenesData() {
  return manusSavedOverride ? manusSavedOverride.scenes : SCENES_DATA;
}

function getEffectiveCastData() {
  return manusSavedOverride ? manusSavedOverride.cast : CAST_DATA;
}
