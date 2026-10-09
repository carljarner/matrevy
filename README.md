# Matematikrevyen Website

Internal website for the cast and crew of Matematikrevyen. Live at **https://matematikrevy.dk**.

Plain HTML/CSS/JS with one PHP file as the write API. There's no framework and no build step for the site itself. `CLAUDE.md` holds the full architecture notes.

## Pages

| Page | File | Who can use it |
| --- | --- | --- |
| Forside | `index.html` | Public (posts need login) |
| Kalender | `kalender.html` | Public; boss edits events; admin edits Revyperiode/Revyugen |
| Arkiv | `arkiv.html` | Revyst; admin edits |
| Wiki | `wiki.html` | Revyst; boss edits |
| Manus | `manus.html` | Revyst uploads; boss/admin run the production |
| Budget | `budget.html` | Revyst submits receipts; admin manages |
| Formularer | `forms.html` | Revyst fills in; boss builds |
| Fællesspisning | `faellesspisning.html` | Revyst |
| Øveplan (under "Redskaber") | `schedule.html` | Revyst; saved in your own browser only |
| Koordinator | `koordinator.html` | Admin |

There are four levels: public, revyst, boss and admin. Each level beyond public has a shared password, handed out verbally. Logging in happens top right.

## Repository layout

```
/
├── *.html               One file per page (page-template.html is the starting point for new ones)
├── css/                 style.css (shared) + one stylesheet per page
├── js/
│   ├── site.js          Header, nav, login — SITE_PAGES registers every page
│   ├── site-utils.js    Shared helpers (saving, dates, modals, field pickers)
│   ├── <page>.js        One script per page
│   └── manus-data.js    Manus's save shadow (code, not generated)
├── manus/               revy.sty + LaTeX templates for sketches and songs
├── img/                 Static images
├── scripts/
│   ├── embed-scenes.js  data/*.json → js/*-data.js + calendar.ics
│   └── generate-pdfs.js Manuscript, Aktoversigt, Rolleoversigt and Program PDFs
├── server/
│   ├── update-data.php  The write API (login, saves, uploads, Budget/Forms/Fællesspisning)
│   ├── Dockerfile.site  Web container (Apache + PHP, serves the site and the API)
│   ├── Dockerfile.worker, worker.sh   Worker container (reruns the two scripts on demand)
│   ├── apache-site.conf, apache-matrevy.conf, php.ini
│   └── config.docker.php   Reads passwords and paths from environment variables
├── docker-compose.yml   The two containers, as deployed by Coolify
└── data/README.md       Schemas for every data file
```

The `data/`, `posts/` and `wiki/` folders, `calendar.ics` and the generated `js/*-data.js` files in the repo are **old copies from Oct 2, 2026**. The live data is on the server, and `plans/migration-guide.md` lists when these copies get removed from git.

`archive/` is different: the worker mirrors the server's archive into it (one-way), about 5 minutes after the last change, so old and current productions stay browsable on GitHub. Don't edit it in the repo. Because the worker pushes to `main`, run `git pull --rebase` before you push.

## How it runs

Everything runs on **web-1**, a Hetzner server (`188.245.30.36`) managed with **Coolify**, as one Docker Compose app built from this repo's `main` branch:

- **web:** Apache + PHP. Serves every page and `update-data.php`.
- **worker:** TeX Live + Node. Regenerates `js/*-data.js` and `calendar.ics` within a couple of seconds of any save, and builds the PDFs when someone clicks "Generér PDF'er" on Manus (about 15 seconds). It also pushes `archive/` to GitHub once archive changes have been quiet for 5 minutes (needs `ARCHIVE_SYNC_DEPLOY_KEY` in Coolify).

Data lives on the server's disk under `/srv/matrevy/data`:

| Folder | Contents | Web-served? |
| --- | --- | --- |
| `site/data`, `site/archive`, `site/posts`, `site/wiki` | Public site data (JSON, PDFs, images) | Yes |
| `site/generated` | `js/*-data.js` and `calendar.ics`, written by the worker | Yes |
| `budget`, `forms`, `faellesspisning` | Private data (names, phone numbers, receipts) | **Never** |

The passwords are environment variables in Coolify. They're never in the repo.

### DNS (Simply.com)

DNS for `matematikrevy.dk` is at Simply.com (DNS-only plan; nothing else is hosted there):

| Name | Type | Value |
| --- | --- | --- |
| `matematikrevy.dk` | A | `188.245.30.36` |
| `www` | CNAME | `matematikrevy.dk.` (the server redirects `www` to the main domain) |
| `manus` | A | `188.245.30.36` (the API's old address, still used by the site) |
| `matematikrevy.dk` | MX | `mx1.forwardemail.net.` and `mx2.forwardemail.net.` (priority 10) |
| `matematikrevy.dk` | TXT | `forward-email=<address>`: Forward Email (forwardemail.net, free plan) forwards all mail for `@matematikrevy.dk` to that address. Receive-only; no mailboxes, no sending as `@matematikrevy.dk`. To change where mail goes, edit this TXT record. |

TLS certificates come from Let's Encrypt automatically, through Coolify's Traefik proxy.

## Deploying

Push to `main`. Coolify rebuilds and redeploys both containers within a few minutes. Saving data on the site doesn't involve git at all.

To change a password, edit the environment variable in Coolify, then redeploy.

## Local development

```
rsync -a web-1:/srv/matrevy/data/site/{data,archive,posts,wiki} ./
node scripts/embed-scenes.js
```

Then open the HTML files directly (`file://`) or serve the folder with any static server. Over `file://` you're treated as admin, but saving doesn't work, because the API only accepts requests from the live site. To build PDFs locally, run `npm install` and then `node scripts/generate-pdfs.js` (needs `pdflatex`).

## Adding a new page

1. Copy `page-template.html` to a new file and set the title.
2. Register it once in `SITE_PAGES` in `js/site.js` with its access level (and `group: 'redskaber'` if it belongs under Redskaber). The nav updates itself on every page.

## A new production

Koordinator → **Arkivering**: generate the PDFs, then **Afslut revyen** (archives the year and empties Manus), then **Start ny revy** (name and folder for the next one).

## Drift (operations)

Most upkeep is automatic: Ubuntu installs security updates, Coolify updates itself, and backups run nightly. That leaves about 10 minutes a month.

### Routine

| When | Task | How |
| --- | --- | --- |
| Monthly | Check disk and memory | Coolify's server page, or `ssh web-1 'df -h / && free -h'` |
| Monthly | Check that backups ran | `ssh web-1 tail -20 /var/log/backup-srv.log` |
| Monthly | Reboot if updates need it | `ssh web-1 cat /var/run/reboot-required`, then `reboot` at a quiet hour |
| Quarterly | Practise a restore | See below |
| Each new revy season | Change the three passwords | Coolify environment variables, then Redeploy |

### Backups

`/srv` (all matrevy data, public and private) is backed up every night at 03:30 with **restic** to Backblaze B2. It keeps 7 daily, 4 weekly and 12 monthly snapshots. The credentials are in `/root/.restic-env` on web-1. Keep `RESTIC_PASSWORD` in the password manager, because without it the backups can't be decrypted.

Restore a single folder:

```bash
ssh web-1
. /root/.restic-env
restic snapshots
restic restore <snapshot-id> --target /tmp/restore --include /srv/matrevy/data/budget
# inspect /tmp/restore, copy back, then fix ownership:
chown -R 33:33 /srv/matrevy/data
```

### When something breaks

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `502 Bad Gateway` or `no available server` | The app crashed on start or isn't healthy | Logs in Coolify. `web` must answer `/health.php`. |
| No HTTPS certificate | DNS doesn't point at the server, or Traefik gave up | `dig +short matematikrevy.dk` should print `188.245.30.36`; then Redeploy |
| Saves fail with "Failed to fetch" | PHP fatal or the container is down | `web` logs in Coolify |
| `{"error":"missing_config", ...}` | An environment variable isn't set | Add it in Coolify and Redeploy |
| `Permission denied` under `/data` | Wrong owner on the host folder | `chown -R 33:33 /srv/matrevy/data` (Apache and the worker run as user 33) |
| Saved data doesn't show up | Worker stopped or failing | `worker` logs in Coolify; a lingering `/srv/matrevy/data/site/.embed-requested` means the worker isn't running |
| "Generér PDF'er" fails | No scenes in the production yet, or a LaTeX package missing from the medium TeX image | Worker log. For a missing package, change `Dockerfile.worker` to `texlive/texlive:latest`. |
| Archive not updating on GitHub | No or wrong deploy key, or a push failed | `worker` logs (`archive sync: …`). Check `ARCHIVE_SYNC_DEPLOY_KEY` in Coolify and that the deploy key has write access |
| Disk filling up | Old Docker images | Coolify **Settings → Docker cleanup**, or `docker system prune -af` |
| Locked out of SSH | Key lost or config mistake | Hetzner Console → server → **Console** gives a browser terminal |
