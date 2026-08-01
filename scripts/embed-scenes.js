#!/usr/bin/env node
// Embeds the JSON files in data/ as global-constant *-data.js files so
// the site works over file:// (where fetch() fails). Run after any hand
// edit to a data/*.json file:
//   node scripts/embed-scenes.js
// (A manus-tool save triggers .github/workflows/embed-scenes.yml, which
// runs this automatically.)
//
// To embed a new data file (calendar, archive, ...): add an entry
// to EMBEDS below, list the new output file in embed-scenes.yml's
// `git add` step, and load it via <script src="..."> where needed.

const fs = require('fs');
const path = require('path');

const root = p => path.join(__dirname, '..', p);
const readJson = p => JSON.parse(fs.readFileSync(root(p), 'utf8'));

// Each entry: one generated output file, built from one or more globals.
const EMBEDS = [
  {
    out: 'js/scenes-data.js',
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
  {
    out: 'js/calendar-data.js',
    sources: 'data/calendar.json',
    globals: () => {
      const events = readJson('data/calendar.json').events;
      console.log(`  ${events.length} calendar events`);
      return { CALENDAR_DATA: events };
    },
  },
  {
    out: 'js/archive-data.js',
    sources: 'data/archive.json',
    globals: () => {
      const years = readJson('data/archive.json').years;
      console.log(`  ${years.length} archive years`);
      return { ARCHIVE_DATA: years };
    },
  },
  {
    out: 'js/posts-data.js',
    sources: 'data/posts.json',
    globals: () => {
      const posts = readJson('data/posts.json').posts;
      console.log(`  ${posts.length} posts`);
      return { POSTS_DATA: posts };
    },
  },
  {
    out: 'js/bosses-data.js',
    sources: 'data/bosses.json',
    globals: () => {
      const bosses = readJson('data/bosses.json');
      console.log(`  bosses title "${bosses.title}", ${bosses.roles.length} roles`);
      return { BOSSES_DATA: bosses };
    },
  },
  {
    out: 'js/wiki-data.js',
    sources: 'data/wiki.json',
    globals: () => {
      const chapters = readJson('data/wiki.json').chapters;
      console.log(`  ${chapters.length} wiki chapters`);
      return { WIKI_DATA: chapters };
    },
  },
  {
    // Static .ics feed, served directly by GitHub Pages at
    // matematikrevy.dk/calendar.ics — no server/PHP round-trip needed since
    // the calendar data is already fully public (see CLAUDE.md's access-level
    // trade-off). `raw: true` below writes this verbatim instead of the
    // `const NAME = ...` JS wrapping every other entry gets.
    out: 'calendar.ics',
    sources: 'data/calendar.json',
    raw: true,
    build: () => {
      const events = readJson('data/calendar.json').events;
      console.log(`  ${events.length} calendar events -> calendar.ics`);
      return buildIcs(events);
    },
  },
];

// Mirrors calendar.js's CAL_CATEGORIES labels (duplicated here the same way
// category colors are already duplicated between calendar.js and
// calendar.css — no shared-module setup in this zero-dependency codebase).
const ICS_CATEGORY_LABELS = {
  manus: 'Manus',
  ove: 'Øvning',
  forestilling: 'Forestilling',
  deadline: 'Deadline',
  andet: 'Andet',
};

function icsEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function icsDate(iso) {
  return iso.replace(/-/g, '');
}

// endDate defaults to date for a single-day event (mirrors calendar.js's
// calEventEndDate, since this script has no access to the browser globals).
function icsEventEndDate(ev) {
  return ev.endDate && ev.endDate >= ev.date ? ev.endDate : ev.date;
}

function icsAddDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildIcs(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Matematikrevyen//Kalender//DA', 'CALSCALE:GREGORIAN'];
  for (const ev of events) {
    const endDate = icsEventEndDate(ev);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscape(ev.id)}@matematikrevy.dk`);
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);
    if (ev.start) {
      const endTime = ev.end || ev.start;
      lines.push(`DTSTART:${icsDate(ev.date)}T${ev.start.replace(':', '')}00`);
      lines.push(`DTEND:${icsDate(endDate)}T${endTime.replace(':', '')}00`);
    } else {
      // All-day (possibly multi-day): DTEND is exclusive per RFC 5545.
      lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.date)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(icsAddDays(endDate, 1))}`);
    }
    if (ev.note) lines.push(`DESCRIPTION:${icsEscape(ev.note)}`);
    lines.push(`CATEGORIES:${icsEscape(ICS_CATEGORY_LABELS[ev.category] || 'Andet')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

for (const embed of EMBEDS) {
  if (embed.raw) {
    fs.writeFileSync(root(embed.out), embed.build());
    console.log(`✓ Wrote ${embed.out}`);
    continue;
  }
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
