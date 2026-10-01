# Walkthrough script (30 minutes)

The order is: show it working, show why it is built this way, break it on purpose,
then the limits. Times are targets, not a stopwatch.

## Before the call (15 minutes ahead)

1. Wake the app (about 70 s; it is paused between demos to save plan credit):

   ```sh
   export RAILWAY_TOKEN=... SANDBOX_PROJECT_ID=...   # account token, sandbox project id
   node scripts/railway-power.mjs resume
   ```

2. Open [the app](https://app-production-c949.up.railway.app) in two browser windows side
   by side and log in on both. No red banner means the token check passed.
3. Open the sandbox project (`railway-spike`) in Railway's dashboard in a third tab. It
   must be empty.
4. Keep a terminal open in the repo with the variables above loaded, and the test
   cluster up (`scripts/test-db.sh`) for the backup demo.
5. Have open: `docs/erd.md`, `src/server/containers.ts`, `test/reconcile.test.ts`.

## 1. The problem (3 min)

"Spinning a container up is one mutation. The work is in what happens around it."
Name the five naive failures from the top of the ERD: double click, lost response, a tab
polling past the rate limit, an invalid token treated as anonymous, a public Create
button spending money. Everything that follows answers one of them.

## 2. Happy path (5 min)

1. **Create** in the left window. It appears at once as `creating` in both windows: one
   observer on the server, fanned out over SSE; the browsers never talk to Railway.
2. Point at the Railway dashboard tab: one `rcc-<operation id>` service appears.
3. At `running` (about 10 s), open its public URL: the nginx welcome page.
4. **Stop**. While it is `stopping`, Start is disabled and its reason is written next to
   it: the same rule the API uses to refuse.
5. **Start**: back to `running` on a new deployment. "The service is the stable
   identity; every start is a new deployment, and the app tracks which is current."
6. Point at the "Time left" countdown: every container is destroyed 30 minutes after
   creation, stopped or not.
7. Leave this container running for the next section.

## 3. The decisions (5 min)

Walk the ERD's architecture diagram, then three decisions with their rejected
alternative:

- **Operations separate from containers**: intent vs observation. This is what makes the
  next two possible.
- **Two layers of idempotency** (ADR 0004): `serviceCreate` takes no key. The key's
  unique constraint protects our API; naming the service after the operation and
  looking it up before any retry protects Railway's.
- **Observed state wins**: `crashed` and `missing` come from Railway; the app never
  re-creates what Railway lost.

## 4. Failure demo: kill it mid-create (6 min)

The point: the process dies while Railway is working, and nothing is duplicated or
orphaned.

1. Click **Create**. As soon as it shows `creating`, in the terminal:

   ```sh
   node scripts/railway-power.mjs restart
   ```

2. Both windows show "Reconnecting..." while the process is replaced.
3. The new process boots, and before accepting requests the reconciler resumes the
   active Create: it searches the sandbox for `rcc-<operation id>`, finds the service the
   dead process created, adopts it, finds or creates the domain, and observes it.
4. The windows reconnect, get a fresh snapshot, and the container reaches `running`.
5. Point at the Railway dashboard: exactly one new service, not two.

Say plainly what this shows and what it does not: Railway's restart sends SIGTERM, so
the in-flight call gets its answer before the process exits. The harder case, a death
between Railway acting and the app recording it, is what the tests do. **Backup, or to
go deeper**, run:

```sh
npx vitest run test/reconcile.test.ts
```

It kills the backend at Create, Stop, Start and Destroy, both before and after Railway
acts, starts a second instance on the same database and fake, and asserts exactly one
service every time. Mention the mutation check: with the reconciler removed, 8 of the
10 fail.

## 5. More failures, from the tests (3 min)

Open `test/retries.test.ts` and show two:

- a 429 is not retried at 6999 ms and is retried at 7000 ms (`Retry-After: 7`, with the
  injected clock);
- a create whose response is lost: the retry finds the service by name instead of
  creating a second one.

Then the reason for the fake: "these failures cannot be provoked on demand against real
Railway, and each try would spend the rate limit."

One failure can be shown live: with a container running, delete its service from the
sandbox in Railway's dashboard. The app shows it down at once and `missing` a few
seconds later (3.8 s in the rehearsal), with Stop and Start refused and Destroy
available. Destroy only closes the row; nothing is re-created.

## 6. The bug the fake could not find (3 min)

The first smoke against real Railway stalled at Stop: the subscription pushes only
`status` changes, and a Stop keeps `SUCCESS` and flips only `deploymentStopped`. The
fake had pushed every field, so 126 tests were green. The fix: confirm a Stop by
reading with backoff, and make the fake push only status changes, like Railway. Redeploying
the fix exercised the reconciler for real: it resumed the stuck Stop and completed it.
"A fake is only as good as what you have observed about the real thing."

## 7. Cost guards (2 min)

- Create five, or point at the limit: the sixth is refused by the app with a clear
  message, not by Railway. Stopped containers count, because they hold a service slot.
- The password: "a cost barrier, not authentication." Say what it is not: no users, no
  login rate limit, no logout.

## 8. Limits and extensions (3 min, then questions)

From the ERD: one instance only; a repeated Start can produce one extra deployment,
never an extra service. Extensions:
Login with Railway (OAuth) and per-user containers, a project-scoped token, the
deployment step timeline, `deploymentCancel`.

## After the call

1. Destroy every container from the app, and check the sandbox is empty.
2. Pause:

   ```sh
   node scripts/railway-power.mjs pause
   ```

   It refuses while the sandbox still has services, because nothing would enforce their
   lifetime with the app down.
