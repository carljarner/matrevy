/* =========================================================
   Matematikrevyen – Active scene/cast data source
   Scheduling data normally comes from the embedded SCENES_DATA /
   CAST_DATA globals (scenes-data.js, generated from data/*.json).
   The manus-import tool (import.js) can locally override that with
   data saved to localStorage — this is the single place both
   schedule.js and import.js check which one is currently active.
   ========================================================= */

'use strict';

const MANUS_OVERRIDE_KEY = 'matrevy-manus-data';

function getManusOverride() {
  try {
    const raw = localStorage.getItem(MANUS_OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function getEffectiveScenesData() {
  const override = getManusOverride();
  return override ? override.scenes : SCENES_DATA;
}

function getEffectiveCastData() {
  const override = getManusOverride();
  return override ? override.cast : CAST_DATA;
}
