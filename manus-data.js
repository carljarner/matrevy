/* =========================================================
   Matematikrevyen – Active scene/cast data source
   Scheduling data comes from the embedded SCENES_DATA / CAST_DATA
   globals (scenes-data.js, generated from data/*.json). A manus-tool
   save (import.js's applyImport()) writes those files globally via
   server/update-data.php, then reloads once the GitHub Action has
   regenerated scenes-data.js — but that round trip takes a minute or
   two, so a successful save also sets an in-memory (page-lifetime
   only, never persisted) shadow here for instant same-tab feedback.
   This is the single place both schedule.js and import.js check which
   one is currently active.
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
