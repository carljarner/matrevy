#!/usr/bin/env node
// Run this script whenever site/data/scenes.json is updated:
//   node scripts/embed-scenes.js

const fs = require('fs');
const path = require('path');

const scenesPath = path.join(__dirname, '../site/data/scenes.json');
const outPath    = path.join(__dirname, '../site/scenes-data.js');

const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8'));
const allScenes = [];
for (const act of scenes.acts) {
  for (const scene of act.scenes) {
    allScenes.push({ ...scene, actLabel: act.label });
  }
}

const out =
  '// Auto-generated from data/scenes.json\n' +
  '// Run scripts/embed-scenes.js to regenerate after editing scenes.json\n' +
  'const SCENES_DATA = ' + JSON.stringify(allScenes, null, 2) + ';\n';

fs.writeFileSync(outPath, out);
console.log(`✓ Wrote ${allScenes.length} scenes to site/scenes-data.js`);
