# Railway container control

A small app that spins `nginx:alpine` containers up and down on Railway through its
public GraphQL API: create, stop, start and destroy, with live state in the browser.
A double click, a lost response, a restart mid-create or a service deleted by hand never
leave a duplicate or an orphan, and the screen shows what Railway actually has.

- [docs/erd.md](docs/erd.md): every decision, the alternative rejected and why.
- [docs/walkthrough.md](docs/walkthrough.md): the 30-minute demo script, including the
  failure demo.
- [docs/adr](docs/adr): the four decisions with lasting weight;
  [CONTEXT.md](CONTEXT.md): the vocabulary; [issue #1](https://github.com/V473r10/railway-take-home/issues/1):
  the spec.

## Deployment

Live at [app-production-c949.up.railway.app](https://app-production-c949.up.railway.app),
behind a shared password (a cost barrier, not an authentication system).

Two Railway projects (ADR 0002):

- **`railway-container-control`**: the app service (one Node process: Hono serves the
  API, the SSE feed and the built React UI) and a managed Postgres.
- **`railway-spike`**: the sandbox. Only the containers the app creates live here, so a
  bug in a destroy cannot reach the app or its database.

Variables of the app service:

| Variable | What it is |
| --- | --- |
| `RAILWAY_TOKEN` | Account token. An account token is required: the identity check at startup (ADR 0003) asks `me`, which a workspace token cannot answer, so the app would start read-only. |
| `SANDBOX_PROJECT_ID`, `SANDBOX_ENVIRONMENT_ID` | Where containers are created. |
| `APP_PASSWORD` | The shared password. |
| `SESSION_SECRET` | Signs the session cookie (at least 32 characters). |
| `DATABASE_URL` | A reference to `${{Postgres.DATABASE_URL}}`. |
| `CHAOS` | `1` shows the chaos panel (see below). Off by default. |

The token is used by the server only; the browser never receives it. Migrations run at
startup, under an advisory lock. The service's health check (`/api/health`), restart
policy and start command are set through the API with
`node scripts/railway-power.mjs configure`: Railway ignores `railway.json` for this
service. The start command runs `node` directly, not `npm start`: npm reports the
SIGTERM of a stop as a failure, so a clean stop showed up as `CRASHED`.

Deployed with the Railway CLI from the repository root. With an account token the CLI
reads it from `RAILWAY_API_TOKEN` (`RAILWAY_TOKEN` is for project tokens) and needs the
ids spelled out:

```sh
RAILWAY_API_TOKEN=... railway up -p <app project id> -s <app service id> -e <environment id> --ci
```

Between demos the app and its Postgres are paused, so they do not spend plan credit
(Serverless sleep would never trigger: the minute sweeps and the database connection
are outbound traffic). The Postgres volume is kept.

```sh
RAILWAY_TOKEN=... SANDBOX_PROJECT_ID=... node scripts/railway-power.mjs pause    # app, then Postgres
RAILWAY_TOKEN=... node scripts/railway-power.mjs resume                           # Postgres, then app (~70 s)
RAILWAY_TOKEN=... node scripts/railway-power.mjs status
RAILWAY_TOKEN=... node scripts/railway-power.mjs configure                        # deploy settings, then redeploy
```

`pause` refuses while the sandbox still has services, since nothing enforces their
lifetime with the app down; on resume, the boot sweep destroys whatever expired.
`restart` restarts the app's process in place, for the walkthrough's failure demo.

## Development

Node 24 or newer, and a Postgres for the tests (CI uses a Postgres service).

```sh
npm ci
npm run test:local                 # starts a throwaway Postgres in .scratch/, then runs the suite
npx vitest run test/reconcile.test.ts   # one file, once the cluster is up (scripts/test-db.sh)
SIM_SEEDS=500 npx vitest run test/simulation.test.ts   # the seeded simulation, 500 seeds (CI runs 10)
SIM_SEED=60 npx vitest run test/simulation.test.ts     # replay one seed, with its full trace on failure
npm run typecheck && npm run build
RAILWAY_FAKE=1 DATABASE_URL=... APP_PASSWORD=... SESSION_SECRET=... npm run dev
```

`RAILWAY_FAKE=1` swaps Railway for the same in-memory fake the tests use, with
deployments that succeed on their own after 1.5 s, so the UI can be used end to end
without a token. Tests read `TEST_DATABASE_URL` and default to the throwaway cluster.

## Chaos mode

With `CHAOS=1` the UI shows a panel that breaks the app on purpose, against real Railway:
lose the response of the next call that changes something (Railway acts, the app never
hears), kill the process right after such a call reaches Railway, kill it now, cut every
WebSocket subscription, or delete a container's service straight on Railway. Open a
container's timeline to watch the app recover: it looks before repeating, resumes after
the restart, resubscribes, marks the container missing.

The kill switches send the process `SIGKILL`; Railway's `ON_FAILURE` restart policy
(set by `railway-power.mjs configure`) starts it again. Locally, run it under
`npm run start:supervised`, which does the same. Against `RAILWAY_FAKE=1` a kill also
wipes the in-memory fake, so the restarted app finds every service gone: use real
Railway to see a kill recover.

Anyone with the password can use the panel, kill switch included, so it is meant for a
demo instance, not one people depend on.

## Smoke test against real Railway

Run by hand against the deployed app; nothing in CI touches real Railway.

**2026-09-30, first run: failed at Stop.** Create reached `running` in 13 s and the
public URL answered 200. The Stop then stayed in `stopping`: Railway already reported
`SUCCESS` with `deploymentStopped: true`, but the deployment subscription pushes status
changes only, and a stop keeps the status at `SUCCESS`. Fixed by having the observer
confirm a Stop by reading the deployment with backoff; the fake now pushes status
changes only, like Railway. Redeploying the fix also exercised the startup reconciler
for real: it resumed the stuck Stop, read the deployment and completed it.

**2026-09-30, second run: passed**, full cycle in 31 s:

| Step | Result |
| --- | --- |
| No session cookie | 401 |
| Log in | 200, not read-only |
| Create | 202, `creating` then `running` after 10 s, with its public URL |
| Open the public URL | 200 |
| Stop | 202, `stopped` after 3 s |
| Start | 202, `running` again after 7 s on a new deployment |
| Destroy | 202, gone after 3 s; the sandbox project is empty afterwards |

**2026-10-01, walkthrough rehearsal: passed 15/15 after two fixes.** A script followed
`docs/walkthrough.md`. The first pass found that a service deleted from outside took
54 s to show `missing` and showed `creating` meanwhile, and that Railway was ignoring
`railway.json` (no health check, `npm start`). Both fixed (see the ERD); the second pass:

| Step | Result |
| --- | --- |
| Double click on Create | one operation (202 and 200) |
| Create | `running` after 9 s; public URL 200 |
| Stop / Start | `stopped` after 3 s, `running` after 6 s |
| Create, then restart the app mid-create | the new process reconciled it; `running` 7 s later; 2 services in the sandbox, no duplicate |
| Delete a service from outside the app | `crashed` at once, `missing` after 3.8 s; Destroy then closes it |
| Destroy both | sandbox empty |
| Pause | app `SUCCESS (stopped)`, no longer `CRASHED` |
