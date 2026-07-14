# Matematikrevyen Website

Internal website for cast and crew of Matematikrevyen.

Live at: **matematikrevy.dk**

## Project Structure

```
/
├── index.html          Landing page (coordinator messages + general info)
├── manus.html          Script/manus page
├── schedule.html       Rehearsal scheduling tool
├── page-template.html  Copy this to add a new page
├── CNAME               Custom domain for GitHub Pages
├── css/
│   ├── style.css       Shared stylesheet
│   └── schedule.css    Scheduling tool styles
├── js/
│   ├── schedule.js       Scheduling tool logic
│   └── scenes-data.js    Embedded scene data (auto-generated — do not edit directly)
├── data/
│   ├── scenes.json     Scene and cast data (source of truth — edit this)
│   └── cast.json       Full cast list and role code definitions
└── scripts/
    └── embed-scenes.js Regenerates js/scenes-data.js from data/scenes.json
```

## Adding a New Page

1. Copy `page-template.html` to a new file, e.g. `gallery.html`.
2. Replace `Sidetitel` with your page title.
3. Add a nav link (`<a href="gallery.html">Galleri</a>`) to the `<nav>` block in **all** existing pages.
4. Mark the link `class="active"` only on the new page itself.

## Updating Scene Data for a New Production

1. Edit `data/scenes.json` with the new scenes and cast.
2. Run `node scripts/embed-scenes.js` to regenerate `js/scenes-data.js`.
3. Commit and push both files.

## Deployment

The site is hosted via GitHub Pages (root `/` folder, `main` branch).
Push changes to `main` and they go live automatically within a minute or two.

### DNS setup (Simply.com)
The apex domain `matematikrevy.dk` uses four A records pointing to GitHub Pages:
```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

See `matrevy-plan.md` at the repo root for the full project plan.
