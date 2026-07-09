# Matematikrevyen Website

Internal website for cast and crew of Matematikrevyen.

## Project Structure

```
site/
├── index.html          Landing page (coordinator messages + general info)
├── manus.html          Script/manus page
├── schedule.html       Rehearsal scheduling tool
├── page-template.html  Copy this to add a new page
├── style.css           Shared stylesheet
└── data/
    ├── scenes.json     Scene and cast data (update each production)
    └── cast.json       Full cast list and role code definitions
```

## Adding a New Page

1. Copy `site/page-template.html` to a new file, e.g. `site/gallery.html`.
2. Replace `Sidetitel` with your page title.
3. Add a nav link (`<a href="gallery.html">Galleri</a>`) to the `<nav>` block in **all** existing pages.
4. Mark the link `class="active"` only on the new page itself.

## Updating Scene Data for a New Production

1. Open `site/data/scenes.json` and replace the content with the new production's scenes.
2. The schema is documented inside the file.
3. Open `site/data/cast.json` and update the cast list.

## Deployment

The site is hosted via GitHub Pages. Push changes to the `main` branch and they go live automatically within a minute or two.

See `matrevy-plan.md` at the repo root for the full project plan.
