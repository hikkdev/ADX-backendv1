# Backup and restore

Decision 95, 12 September 2026. **RPO 1 hour, RTO 4 hours.** The database
stays in Neon's Singapore region (`ap-southeast-1`).

## The three layers

| Layer | What it is | What it covers |
| --- | --- | --- |
| Neon point-in-time restore | Neon's paid plan keeps the WAL; any instant inside the history window can be restored as a new branch in minutes. | **The RPO.** Any loss inside the window — a bad migration, a bad delete, a bad day — is recovered to the minute before it. This is the first thing to reach for. |
| The nightly dump | `npm run backup`: `pg_dump --format=custom` over the direct endpoint, gzipped, sealed with AES-256-GCM under `BACKUP_KEY`, uploaded to private storage (R2) as `backups/<instant>.dump.enc`, 35-day rotation. | The copy that survives Neon: an account lost, a region gone, a retention window outlived. |
| The monthly restore drill | `jobs/restore-drill.job.ts`: the newest dump restored into `DRILL_DATABASE_URL`, the ledger verify run on it, the result on `GET /settings/system-health/ops` and in the audit trail. | Proof that layer two can be opened. A backup nobody has restored is a hope. |

### The Neon PITR expectation

- History retention set to **at least 7 days** on the production project.
  Check it under *Project settings → Storage* after any plan change; a
  downgrade silently shortens it.
- A restore is a **branch**, not an overwrite: Neon creates a new branch at
  the chosen instant. The app is repointed at it by changing `DATABASE_URL`
  (pooled) and `DIRECT_URL` (direct) and restarting. The old branch stays
  until someone deletes it.
- Neon's own daily snapshots are not relied on for anything: they are Neon's
  operational safety net, not ours.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | The pooled endpoint. The app. Never used for a migration, a dump or a restore. |
| `DIRECT_URL` | The direct endpoint (the host without `-pooler`). `prisma migrate` (via `prisma.config.ts`), `pg_dump`, `pg_restore`. Falls back to `DATABASE_URL` when blank. |
| `BACKUP_KEY` | 32 bytes, 64 hex characters (`openssl rand -hex 32`) or base64. **Kept in the deployment platform's secret store and in the password manager's shared vault — not in the database, not in R2.** A dump without the key is noise; the key without a dump is nothing. |
| `DRILL_DATABASE_URL` | The scratch database the drill restores into — on the same Neon project as a separate database, or on any Postgres. Never the production name; the drill refuses it. Blank skips the drill with a warning. |

The PostgreSQL client tools (`pg_dump`, `pg_restore`, version ≥ the server's
major) must be on `PATH` wherever `npm run backup` and the drill run.

## Schedules

| What | When | How |
| --- | --- | --- |
| Nightly dump | 02:00 IST (20:30 UTC), daily | A scheduler on the host (cron, the platform's scheduled job, or a GitHub Actions workflow with the secrets) runs `npm run backup` from the backend root. It prints the dump's name and sizes, and what it rotated — never a URL, never the key. A non-zero exit is the alert. |
| Restore drill | First hourly tick on or after the 2nd of the month, IST | The API process itself (`server.ts`), under a Redis lock and a month key. Nothing to schedule. |
| Retention sweep | Daily, IST | The API process, `jobs/retention.job.ts`. See `modules/ops/README.md`. |

## Who is on call

**Every ADMIN account**, until a rota exists. That is who the drill's failure
notification, the past-due erasure notice and the 5xx-rate alert go to. When
a rota is set up, `modules/ops/ops.notify.ts` is the one place to change.

## Checking the state

`GET /settings/system-health/ops` (ADMIN). Read it against the targets it
carries: `backup.stale` (no dump in 26 hours), `drill.status`
(`FAILED`, or `drill: null` meaning it has never run), `retention.dueCount`,
and any job with `stale: true`.

## Procedures

### A. Something was lost or corrupted inside the last 7 days

Use Neon PITR. It is faster than any dump and loses less.

1. Note the instant just before the damage (the audit trail at `GET /audit`
   with `from`/`to` narrows it; the request id on the offending row is the
   exact moment).
2. In the Neon console, *Branches → Restore* on the production branch at
   that instant. Neon creates a restore branch and gives it its own pooled
   and direct endpoints.
3. Put the API into maintenance (`PUT /app/status { maintenance }`), so
   nothing is written to the branch about to be abandoned.
4. Set `DATABASE_URL` and `DIRECT_URL` to the restore branch's endpoints in
   the deployment platform; restart.
5. `GET /health/ready`, then `GET /finance/ledger/verify` (ADMIN — the
   reconciliation screen's check). `healthy: true` or stop and escalate.
6. Lift maintenance. Keep the old branch for a week, then delete it.

Elapsed: 20–40 minutes. Loss: the writes between the chosen instant and the
maintenance flag.

### B. Neon is gone, or the loss is older than the history window

Use the nightly dump. Loss: up to one night's writes — that is what the
1-hour RPO does **not** cover, and why layer one exists.

1. Provision a fresh Postgres (a new Neon project in `ap-southeast-1`, or
   anywhere). Note its direct endpoint; set it as `DIRECT_URL` (and the
   pooled one as `DATABASE_URL`) in a shell — **not yet in the platform**.
2. `npm run restore -- adx_restore [dump-name]` — the newest dump when no
   name is given. The script creates `adx_restore` on that server, downloads,
   unseals, `pg_restore`s and prints a row count. It refuses the production
   database name by design: the restored copy always lands under a new name.
3. Run the two verify queries against `adx_restore` (they are
   `LEDGER_VERIFY_SQL` in `modules/ops/restore-drill.service.ts`; both must
   return no rows).
4. Either rename (`ALTER DATABASE adx_restore RENAME TO adx` once nothing
   is connected) or point the platform's `DATABASE_URL` / `DIRECT_URL` at
   `adx_restore` directly. Run `npx prisma migrate deploy` — a dump taken
   before a migration that has since shipped needs it.
5. Set the app to maintenance, repoint, restart, `GET /health/ready`, lift
   maintenance.
6. Tell every party whose writes were lost: the audit trail on the old
   system is gone with it, so the window is "since the dump's instant".

Elapsed: 1–3 hours against the 4-hour RTO; most of it is the restore of a
large dump and the migration.

### C. The drill failed

The notification names the cause. In order of likelihood:

| Cause | Fix |
| --- | --- |
| `No dump to restore` | The nightly is not running. Check the scheduler and its last output. |
| `BACKUP_KEY is not set` / `bad header` / auth-tag failure | The key in the drill's environment is not the key the dump was sealed with. The drill environment and the backup environment must hold the same value. |
| `pg_restore is not on PATH` | Install the client tools on the API host. |
| `pg_restore exited with 2` | The scratch role cannot create something the dump needs. The redacted stderr on the row says what. |
| `The restored ledger does not verify` | **Escalate.** Either the live books are unbalanced (run `verifyLedger` on production now) or the dump is not a consistent snapshot (it is one transaction; it should be). |

Rerun by hand once fixed: delete the Redis key `lock:restore-drill:<YYYY-MM>`
and the next hourly tick runs it, or call `runRestoreDrill(defaultDrillDeps(adminId))`
from a `tsx` shell.

### D. Rotating the backup key

Sealed dumps are only openable with the key that sealed them. To rotate:
generate the new key, set it in **both** the backup and the drill
environments, run `npm run backup` once by hand, and keep the old key in the
vault for 35 days, labelled with the date, until every dump under it has
rotated out.

## What is deliberately not done

- No automatic restore into production, from anywhere. Both the script and
  the drill refuse the production name.
- No dump of the private files (KYC images, evidence, invoices). R2 holds
  those with its own durability; a dump of the database restores every
  `storageKey`, and the objects are still where the keys say.
- No unencrypted dump, anywhere, ever — `npm run backup` refuses to run
  without `BACKUP_KEY`.
