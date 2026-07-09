#!/usr/bin/env node
// Run this script whenever data/scenes.json or data/cast.json is updated:
//   node scripts/embed-scenes.js

const fs = require('fs');
const path = require('path');

const scenesPath = path.join(__dirname, '../data/scenes.json');
const castPath   = path.join(__dirname, '../data/cast.json');
const outPath    = path.join(__dirname, '../scenes-data.js');

const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8'));
const allScenes = [];
for (const act of scenes.acts) {
  for (const scene of act.scenes) {
    allScenes.push({ ...scene, actLabel: act.label });
  }
}

const cast = JSON.parse(fs.readFileSync(castPath, 'utf8'));

const out =
  '// Auto-generated from data/scenes.json and data/cast.json\n' +
  '// Run scripts/embed-scenes.js to regenerate after editing either file\n' +
  'const SCENES_DATA = ' + JSON.stringify(allScenes, null, 2) + ';\n' +
  'const CAST_DATA = ' + JSON.stringify(cast.cast, null, 2) + ';\n';

fs.writeFileSync(outPath, out);
console.log(`✓ Wrote ${allScenes.length} scenes and ${cast.cast.length} cast members to scenes-data.js`);
