# Migration to web-1: remaining cleanup

Updated Oct 2, 2026 · What's left after moving matematikrevy.dk to web-1

## Where things stand

The move is done. Since **Oct 2, 2026**, the site, the API and all data run on **web-1**:

- Server: Hetzner, `188.245.30.36`, managed with Coolify.
- One Docker Compose app runs two containers, `web` and `worker`. CLAUDE.md and README.md describe how it works.

Stages A–D are done:

- **B (Oct 2):** moved the PHP API from Simply.com to web-1.
- **D (Oct 2):** moved the site itself off GitHub Pages.

The full step-by-step record is in git history (commit `3bd6d5d` and earlier). This file only lists what's left to do.

Commands are marked with where they run: **laptop**, **web-1** (after `ssh web-1`), **Coolify**, **Simply** (control panel), or **GitHub**.

### DNS today (Simply)

| Name | Type | Value | Note |
| --- | --- | --- | --- |
| `matematikrevy.dk` | A | `188.245.30.36` | was 4 × `185.199.10x.153` (GitHub Pages) |
| `www` | CNAME | `matematikrevy.dk.` | was `carljarner.github.io.` |
| `manus` | A | `188.245.30.36` | was CNAME `matematikrevy.dk.linux32.unoeuro-server.com.` (Simply) |
| `api-new` | A | `188.245.30.36` | temporary, delete Oct 4 |
| `beta` | A | `188.245.30.36` | temporary, delete Oct 3 |
| MX, `_dmarc`, `_domainkey`, autoconfig, SRV | | Simply mail | leave alone; mail stays at Simply |

TTLs are 600 s everywhere.

---

## From Oct 3: site cleanup (24 h after the site moved)

By now every DNS resolver has left GitHub Pages.

1. [ ] **GitHub** → repo **Settings → Pages**: turn off GitHub Pages. **Do this first.** Step 2 removes the files Pages is serving.
2. [ ] Ask Claude: *"Do the Oct 3 repo cleanup in migration-guide.md."* It will:
   - delete `CNAME` and `.nojekyll`
   - untrack the live-data copies, which are stale since Oct 2 (the real data is on web-1):
     - `data/*.json` (keeping `data/README.md`)
     - `posts/`, `wiki/`, `calendar.ics`
     - **not** `archive/`: it stays tracked, because the worker now mirrors the server's archive into it (see "Archive mirror" below)
     - every `js/*-data.js` except `js/manus-data.js`
   - add them to `.gitignore`
   - delete `.github/workflows/embed-scenes.yml` and `generate-pdfs.yml`
   - delete `server/Dockerfile`, the old API-only image
   - simplify `SITE_API_ENDPOINT` in `js/site.js` to `'/update-data.php'`
   - touch up CLAUDE.md/README.md where they mention the stale repo copies
   - optionally, clear out stale code comments that still mention GitHub commits, Simply or `import.js`
3. [ ] **Coolify**, Compose app:
   - **Source**: change the branch from `server-hosting` to **`main`**.
   - **Advanced**: make sure there's **no Watch Path**, because a push touching any file must redeploy, not just `server/`.
   - **Access**: remove `https://beta.matematikrevy.dk`.
   - Redeploy once.
4. [ ] **Coolify:** delete the old API app (stopped since Oct 2).
5. [ ] **GitHub:** delete the `server-hosting` branch (it's merged).
6. [ ] **Simply DNS:** delete the `beta` record.
7. [ ] **GitHub:** revoke the fine-grained token that was in `GITHUB_TOKEN` (**Settings → Developer settings → Fine-grained tokens**). Nothing uses it any more.
8. [ ] **web-1**, the morning after: check that the nightly backup includes the site data.
   ```bash
   . /root/.restic-env && restic snapshots --latest 1
   ```
   ```bash
   tail -20 /var/log/backup-srv.log
   ```
   The latest snapshot should cover `/srv`, which includes `/srv/matrevy/data/site`.
9. [ ] **web-1:** remove the repo clone used for the data copy: `rm -rf /root/mr-src`

## Archive mirror to GitHub (set up once, any time)

The worker pushes the server's `archive/` to this repo (CLAUDE.md → Hosting & data flow). Until the key is set, the mirror is off and the worker logs `archive sync: off`.

1. [ ] **Laptop:** create a deploy key:
   ```bash
   ssh-keygen -t ed25519 -f matrevy-archive -N '' -C matrevy-archive
   ```
2. [ ] **GitHub** → repo **Settings → Deploy keys → Add deploy key**: paste `matrevy-archive.pub` and tick **Allow write access**.
3. [ ] **Coolify**, Compose app → **Environment variables**: set `ARCHIVE_SYNC_DEPLOY_KEY` to the output of
   ```bash
   base64 < matrevy-archive | tr -d '\n'
   ```
   then Redeploy.
4. [ ] **Laptop:** `rm matrevy-archive matrevy-archive.pub`.
5. [ ] **Coolify**, `worker` logs: expect `archive sync: pushed <sha>` within a minute of the redeploy (the first push catches up everything since Oct 2).
6. [ ] **Coolify** deployments list: check that the bot's `[skip ci]` commit did **not** start a deployment. If it did, add a Watch Path that excludes `archive/**`, and update the "no Watch Path" note in the Oct 3 list.
7. [ ] **Laptop:** `git pull --rebase` to pick up the mirrored archive.

## From Oct 4: Simply forwarder (48 h after the API moved)

1. [ ] **Simply:** confirm the forwarder is no longer used. If Simply shows access logs for `manus.matematikrevy.dk`, there should be no recent requests to `update-data.php`.
2. [ ] **Simply**, in `/var/www/matematikrevy.dk/manus-api/`:
   - delete the forwarder's `update-data.php`
   - remove the three `Rewrite…` lines (and the comment above them) from `.htaccess`
3. [ ] **Coolify**, Compose app → **Access**: remove `https://api-new.matematikrevy.dk`.
4. [ ] **Simply DNS:** delete the `api-new` record.
5. [ ] **web-1:** delete the Stage B staging files: `rm -r /root/b2-upload /root/b2-go`
6. [ ] Ask Claude to delete `server/simply-forwarder/` from the repo.

## Around Oct 16: Simply data and keys (2 quiet weeks)

1. [ ] **Simply:** delete the three private data folders (`budget-data`, `forms-data`, `faellesspisning-data`) and `config.php` from `/var/www/matematikrevy.dk/manus-api/`. Keeping personal data in several places is a GDPR liability.
2. [ ] **web-1:** `rm -r /root/simply-backup`. This is the copy of Simply's original API files, and it holds old secrets.
3. [ ] **Laptop:** delete `~/matrevy-migration/` (old backups and data copies), or move it to an encrypted disk.
4. [ ] **Simply** → **Website → SSH access**: remove web-1's key. On **web-1**, delete it and the sync script: `rm /root/.ssh/simply /root/.ssh/simply.pub /root/sync-from-simply`
5. [ ] **Simply:** check whether anything else (email, other sites) uses the webhotel before you consider cancelling it. Mail for `@matematikrevy.dk` runs there (the MX record), and so does DNS.
6. [ ] **web-1:** practise restoring one folder from the backup:
   ```bash
   . /root/.restic-env
   restic snapshots
   restic restore latest --target /tmp/restore --include /srv/matrevy/data/budget
   ls -R /tmp/restore | head
   rm -rf /tmp/restore
   ```
7. [ ] Delete this file (`migration-guide.md`). Everything that outlives the move is in README.md's "Drift" section and CLAUDE.md.

---

## Rollback (only until the Oct 3 cleanup)

As long as GitHub Pages is on and the repo still tracks the data, the site can go back to GitHub Pages and Simply.

1. **web-1:** copy the live public data into a repo clone and push it, so saves made since Oct 2 aren't lost:
   ```bash
   git clone https://github.com/carljarner/matrevy /root/mr-src   # or: git -C /root/mr-src pull -q
   cd /root/mr-src
   rsync -a /srv/matrevy/data/site/data /srv/matrevy/data/site/archive /srv/matrevy/data/site/posts /srv/matrevy/data/site/wiki ./
   git add -A data archive posts wiki && git commit -m "Restore data from web-1" && git push
   ```
   Pushing from web-1 needs GitHub credentials. If they aren't set up, `rsync` the folders to the laptop and commit from there.
2. **Simply DNS:** restore the four `185.199.108–111.153` A records for `matematikrevy.dk`, `www` as CNAME `carljarner.github.io.`, and `manus` as CNAME `matematikrevy.dk.linux32.unoeuro-server.com.`.
3. **Simply:** upload `/root/simply-backup/update-data.php` (the original API) over the forwarder, and copy the private data back:
   ```bash
   eval "$(grep '^SRC=' /root/sync-from-simply)"
   rsync -a -e 'ssh -i /root/.ssh/simply' /srv/matrevy/data/budget/ "$SRC/budget-data/"
   rsync -a -e 'ssh -i /root/.ssh/simply' /srv/matrevy/data/forms/ "$SRC/forms-data/"
   rsync -a -e 'ssh -i /root/.ssh/simply' /srv/matrevy/data/faellesspisning/ "$SRC/faellesspisning-data/"
   ```
4. **GitHub:** revert the merge `3bd6d5d` on `main`, so Pages serves the old front end, which uses GitHub for files and PDFs.

After the Oct 3 cleanup, restore from restic instead (step 6 of the Oct 16 list shows how).
