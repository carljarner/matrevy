#!/usr/bin/env node
// Embeds the JSON files in data/ as global-constant *-data.js files so
// the site works over file:// (where fetch() fails). Run after any hand
// edit to a data/*.json file:
//   node scripts/embed-scenes.js
// (A manus-tool save triggers .github/workflows/embed-scenes.yml, which
// runs this automatically.)
//
// To embed a new data file (announcements, calendar, ...): add an entry
// to EMBEDS below, list the new output file in embed-scenes.yml's
// `git add` step, and load it via <script src="..."> where needed.

const fs = require('fs');
const path = require('path');

const root = p => path.join(__dirname, '..', p);
const readJson = p => JSON.parse(fs.readFileSync(root(p), 'utf8'));

// Each entry: one generated output file, built from one or more globals.
const EMBEDS = [
  {
    out: 'scenes-data.js',
    sources: 'data/scenes.json and data/cast.json',
    globals: () => {
      const scenes = readJson('data/scenes.json');
      const allScenes = [];
      for (const act of scenes.acts) {
        for (const scene of act.scenes) {
          allScenes.push({ ...scene, actLabel: act.label });
        }
      }
      const cast = readJson('data/cast.json');
      console.log(`  ${allScenes.length} scenes, ${cast.cast.length} cast members`);
      return { SCENES_DATA: allScenes, CAST_DATA: cast.cast };
    },
  },
];

for (const embed of EMBEDS) {
  const globals = embed.globals();
  let out =
    `// Auto-generated from ${embed.sources}\n` +
    '// Run scripts/embed-scenes.js to regenerate after editing the source file(s)\n';
  for (const [name, value] of Object.entries(globals)) {
    out += `const ${name} = ` + JSON.stringify(value, null, 2) + ';\n';
  }
  fs.writeFileSync(root(embed.out), out);
  console.log(`✓ Wrote ${embed.out}`);
}
