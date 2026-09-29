// Railway API spike (M0). Runs one full container lifecycle against the real API
// and measures what the take-home design depends on:
//   1. does serviceCreate(source.image) auto-deploy?
//   2. does the WebSocket subscription authenticate and push status?
//   3. is the token scope enough for create/delete?
//   4. how many requests (and rate-limit points) does one cycle cost?
//
// Run:  node spike.ts            (Node >= 23.6 strips the types natively)
// Token file (outside any repo):  ~/.config/railway-spike/.env
//   RAILWAY_TOKEN=...            required
//   RAILWAY_TOKEN_KIND=bearer    bearer (account/workspace) | project
//   RAILWAY_PROJECT_ID=...       optional; bearer tokens create "railway-spike" if absent
//   RAILWAY_WORKSPACE_ID=...     optional; used only when creating the project
//
// The token is never printed or written to the results file.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const WS_ENDPOINT = "wss://backboard.railway.com/graphql/v2";
const IMAGE = "nginx:alpine";
const IMAGE_PORT = 80;
const TERMINAL = new Set(["SUCCESS", "FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

// ---------- config ----------
const envPath = process.env.RAILWAY_ENV_FILE ?? join(homedir(), ".config/railway-spike/.env");
const env = loadEnv(envPath);
const TOKEN = env.RAILWAY_TOKEN;
const KIND = (env.RAILWAY_TOKEN_KIND ?? "bearer").toLowerCase();
if (!TOKEN) fail(`RAILWAY_TOKEN missing in ${envPath}`);
if (KIND !== "bearer" && KIND !== "project") fail("RAILWAY_TOKEN_KIND must be bearer or project");

const authHeaders: Record<string, string> =
  KIND === "project" ? { "Project-Access-Token": TOKEN } : { Authorization: `Bearer ${TOKEN}` };

// ---------- measurement ----------
type StepLog = { step: string; ms: number; requests: number; ok: boolean; error?: unknown; note?: string };
// Live log: every line is timestamped and also appended to results/live.log,
// so a long run can be followed with `tail -f results/live.log`.
const liveLog = join(dirname(fileURLToPath(import.meta.url)), "results", "live.log");
mkdirSync(dirname(liveLog), { recursive: true });
writeFileSync(liveLog, "");
for (const k of ["log", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${a.map(String).join(" ")}`;
    orig(line);
    appendFileSync(liveLog, line + "\n");
  };
}

const steps: StepLog[] = [];
const statusTrail: { phase: string; status: string; at: string; via: string }[] = [];
let requests = 0;
let lastRemaining: number | null = null;
const remainingSamples: { label: string; remaining: number | null }[] = [];

type GqlErrorItem = { message: string; extensions?: { code?: string; traceId?: string } };
class GqlError extends Error {
  http: number;
  errors: GqlErrorItem[];
  constructor(http: number, errors: GqlErrorItem[]) {
    super(errors.map((e) => `${e.extensions?.code ?? "?"}: ${e.message} (traceId ${e.extensions?.traceId ?? "-"})`).join("; "));
    this.http = http;
    this.errors = errors;
  }
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}, label = "gql"): Promise<T> {
  requests++;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ query, variables }),
  });
  const rem = res.headers.get("x-ratelimit-remaining");
  lastRemaining = rem === null ? lastRemaining : Number(rem);
  remainingSamples.push({ label, remaining: rem === null ? null : Number(rem) });
  if (res.status === 429) throw new GqlError(429, [{ message: `rate limited, retry-after ${res.headers.get("retry-after")}` }]);
  const body = (await res.json()) as { data?: T; errors?: GqlErrorItem[] };
  if (body.errors?.length) throw new GqlError(res.status, body.errors);
  return body.data as T;
}

async function step<T>(name: string, fn: () => Promise<T>, note?: string): Promise<T | undefined> {
  const r0 = requests;
  const t0 = Date.now();
  try {
    const out = await fn();
    steps.push({ step: name, ms: Date.now() - t0, requests: requests - r0, ok: true, note });
    console.log(`✓ ${name} (${Date.now() - t0} ms, ${requests - r0} req, remaining ${lastRemaining})`);
    return out;
  } catch (e) {
    const error = e instanceof GqlError ? { http: e.http, errors: e.errors } : String(e);
    steps.push({ step: name, ms: Date.now() - t0, requests: requests - r0, ok: false, error, note });
    console.log(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

// ---------- status watching ----------
// Primary: graphql-transport-ws subscription (handshake verified without a token;
// auth via connection_init payload is what this spike tests). Fallback: polling.
function watchViaSubscription(deploymentId: string, phase: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(v); } };
    const ws = new WebSocket(WS_ENDPOINT, "graphql-transport-ws");
    const timer = setTimeout(() => done(null), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init", payload: authHeaders }));
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type !== "next" && msg.type !== "ping") console.log(`  [ws frame] ${msg.type}`);
      if (msg.type === "connection_ack") {
        ws.send(JSON.stringify({
          id: "1", type: "subscribe",
          payload: { query: "subscription($id:String!){ deployment(id:$id){ id status } }", variables: { id: deploymentId } },
        }));
        // The subscription only emits CHANGES (run-20260929021424: silent for 3 min on a
        // deploy that was already SUCCESS). Subscribe first, then read a snapshot, so a
        // transition can't fall in the gap between the two.
        gql<{ deployment: { status: string } }>("query($id:String!){ deployment(id:$id){ status } }",
          { id: deploymentId }, `snapshot:${phase}`)
          .then((d) => {
            const s = d.deployment.status;
            statusTrail.push({ phase, status: s, at: new Date().toISOString(), via: "snapshot" });
            console.log(`  [snapshot] ${s}`);
            if (TERMINAL.has(s)) done(s);
          })
          .catch((e) => console.log(`  snapshot failed: ${e instanceof Error ? e.message : e}`));
      } else if (msg.type === "next") {
        if (msg.payload?.errors) { console.log("  ws errors:", JSON.stringify(msg.payload.errors)); return done(null); }
        const status = msg.payload?.data?.deployment?.status;
        if (status) {
          statusTrail.push({ phase, status, at: new Date().toISOString(), via: "ws" });
          console.log(`  [ws] ${status}`);
          if (TERMINAL.has(status)) done(status);
        }
      } else if (msg.type === "error") {
        console.log("  ws error frame:", JSON.stringify(msg.payload)); done(null);
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    };
  });
}

async function watchViaPolling(deploymentId: string, phase: string, timeoutMs: number, stopOn = TERMINAL): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let delay = 3000;
  let last = "";
  while (Date.now() < deadline) {
    const d = await gql<{ deployment: { status: string } }>(
      "query($id:String!){ deployment(id:$id){ status } }", { id: deploymentId }, `poll:${phase}`);
    const s = d.deployment.status;
    if (s !== last) { statusTrail.push({ phase, status: s, at: new Date().toISOString(), via: "poll" }); console.log(`  [poll] ${s}`); last = s; }
    if (stopOn.has(s)) return s;
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15000);
  }
  return null;
}

async function watch(deploymentId: string, phase: string): Promise<{ status: string | null; via: string }> {
  const before = await probeRemaining(`before-ws:${phase}`);
  console.log(`  watching deployment ${deploymentId} (${phase}) via ws, up to 3 min`);
  const wsStatus = await watchViaSubscription(deploymentId, phase, 3 * 60_000);
  const after = await probeRemaining(`after-ws:${phase}`);
  if (wsStatus) {
    // The two probes + the snapshot cost 1 point each; anything beyond that was charged to the socket.
    wsCost.push({ phase, pointsUsed: before !== null && after !== null ? before - after - 2 : null });
    return { status: wsStatus, via: "ws" };
  }
  console.log("  subscription gave nothing, falling back to polling");
  return { status: await watchViaPolling(deploymentId, phase, 8 * 60_000), via: "poll" };
}
const wsCost: { phase: string; pointsUsed: number | null }[] = [];

async function probeRemaining(label: string): Promise<number | null> {
  try { await gql("query{ __typename }", {}, label); } catch {}
  return lastRemaining;
}

async function latestDeploymentId(projectId: string, environmentId: string, serviceId: string): Promise<string | null> {
  const d = await gql<{ deployments: { edges: { node: { id: string; status: string } }[] } }>(
    "query($input:DeploymentListInput!){ deployments(input:$input, first:1){ edges{ node{ id status } } } }",
    { input: { projectId, environmentId, serviceId } }, "latestDeployment");
  return d.deployments.edges[0]?.node.id ?? null;
}

// ---------- the run ----------
const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const findings: Record<string, unknown> = { runId, tokenKind: KIND, image: IMAGE };
let serviceId: string | null = null;

async function main() {
  // 0. identity + plan. Fail fast: the API does NOT reject a bad token -- it treats
  // the caller as anonymous, and anonymous callers can still create temporary
  // projects and services (only deploying is refused). Verified 2026-09-29.
  let workspaceId: string | undefined = env.RAILWAY_WORKSPACE_ID;
  let projectId: string | undefined = env.RAILWAY_PROJECT_ID;
  let environmentId: string | undefined;

  if (KIND === "project") {
    const pt = await step("identity:projectToken", () =>
      gql<{ projectToken: { projectId: string; environmentId: string } }>("query{ projectToken{ projectId environmentId } }"));
    if (!pt) fail("project token rejected (identity:projectToken failed); aborting before any write");
    projectId = pt.projectToken.projectId;
    environmentId = pt.projectToken.environmentId;
  } else {
    const me = await step("identity:me", () =>
      gql<{ me: { name: string; workspaces: { id: string; name: string; plan: string; subscriptionPlanLimit: unknown; apiTokenRateLimit: unknown }[] } }>(
        "query{ me{ name workspaces{ id name plan subscriptionPlanLimit apiTokenRateLimit{ remainingPoints resetsAt } } } }"),
      "fails with a workspace token (account-scoped query)");
    if (me) {
      findings.workspaces = me.me.workspaces.map(({ id, name, plan, subscriptionPlanLimit, apiTokenRateLimit }) =>
        ({ id, name, plan, subscriptionPlanLimit, apiTokenRateLimit }));
      workspaceId ??= me.me.workspaces[0]?.id;
    } else {
      // Workspace token: `me` is not allowed, so prove auth with the workspace itself.
      if (!workspaceId) fail("identity:me failed. Bad token, or a workspace token without RAILWAY_WORKSPACE_ID; aborting before any write");
      const ws = await step("identity:workspace", () =>
        gql<{ workspace: { id: string; name: string; plan: string; subscriptionPlanLimit: unknown } }>(
          "query($id:String!){ workspace(workspaceId:$id){ id name plan subscriptionPlanLimit } }", { id: workspaceId }));
      if (!ws) fail("token rejected for this workspace; aborting before any write");
      findings.workspaces = [ws.workspace];
    }
  }

  // 1. project + environment
  if (!projectId) {
    const p = await step("projectCreate", () =>
      gql<{ projectCreate: { id: string } }>("mutation($input:ProjectCreateInput!){ projectCreate(input:$input){ id } }",
        { input: { name: "railway-spike", workspaceId } }));
    projectId = p?.projectCreate.id;
    findings.createdProjectId = projectId;
  }
  if (!projectId) fail("no project; set RAILWAY_PROJECT_ID or use an account token");
  if (!environmentId) {
    const p = await step("project:environments", () =>
      gql<{ project: { environments: { edges: { node: { id: string; name: string } }[] } } }>(
        "query($id:String!){ project(id:$id){ environments{ edges{ node{ id name } } } } }", { id: projectId }));
    environmentId = p?.project.environments.edges.find((e) => e.node.name === "production")?.node.id
      ?? p?.project.environments.edges[0]?.node.id;
  }
  if (!environmentId) fail("no environment found in project");
  findings.projectId = projectId;
  findings.environmentId = environmentId;

  // 2. spin up: create service from image  (unknown #3: token scope)
  const name = `spike-${runId}`;
  const created = await step("serviceCreate", () =>
    gql<{ serviceCreate: { id: string } }>("mutation($input:ServiceCreateInput!){ serviceCreate(input:$input){ id } }",
      { input: { projectId, environmentId, name, source: { image: IMAGE } } }));
  findings.tokenCanCreateService = Boolean(created);
  if (!created) return;
  serviceId = created.serviceCreate.id;

  // 3. unknown #1: did it auto-deploy?
  await sleep(8000);
  let deploymentId = await step("check:autoDeploy", () => latestDeploymentId(projectId, environmentId, serviceId!));
  findings.serviceCreateAutoDeploys = Boolean(deploymentId);
  if (!deploymentId) {
    deploymentId = await step("serviceInstanceDeployV2", async () =>
      (await gql<{ serviceInstanceDeployV2: string }>(
        "mutation($s:String!,$e:String!){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e) }",
        { s: serviceId, e: environmentId })).serviceInstanceDeployV2);
  }
  if (!deploymentId) return;
  console.log(`  deployment ${deploymentId} (${findings.serviceCreateAutoDeploys ? "auto-deployed on create" : "triggered manually"})`);

  // 4. public URL
  const dom = await step("serviceDomainCreate", () =>
    gql<{ serviceDomainCreate: { domain: string } }>(
      "mutation($input:ServiceDomainCreateInput!){ serviceDomainCreate(input:$input){ domain } }",
      { input: { serviceId, environmentId, targetPort: IMAGE_PORT } }));
  findings.domain = dom?.serviceDomainCreate.domain;

  // 5. watch until running  (unknown #2: subscription auth)
  const up = await step("watch:up", () => watch(deploymentId!, "up"));
  findings.up = up;
  findings.subscriptionWorks = up?.via === "ws";

  // 6. is it actually serving?
  if (up?.status === "SUCCESS" && findings.domain) {
    findings.httpCheck = await step("http:get", () => httpCheck(`https://${findings.domain}`), "not an API request");
  }

  // 7. spin down (reversible): deploymentStop
  await step("deploymentStop", () => gql("mutation($id:String!){ deploymentStop(id:$id) }", { id: deploymentId }));
  const stopped = await step("watch:stop", async () => {
    await sleep(3000);
    const d = await gql<{ deployment: { status: string; deploymentStopped: boolean } }>(
      "query($id:String!){ deployment(id:$id){ status deploymentStopped } }", { id: deploymentId }, "stop:read");
    statusTrail.push({ phase: "stop", status: d.deployment.status, at: new Date().toISOString(), via: "poll" });
    return d.deployment;
  });
  findings.afterStop = stopped;

  // 8. start again: serviceInstanceRedeploy, then the new deployment id
  await step("serviceInstanceRedeploy", () =>
    gql("mutation($s:String!,$e:String!){ serviceInstanceRedeploy(serviceId:$s, environmentId:$e) }",
      { s: serviceId, e: environmentId }));
  await sleep(5000);
  const redeployId = await step("check:redeployId", () => latestDeploymentId(projectId!, environmentId!, serviceId!));
  findings.redeployCreatesNewDeployment = Boolean(redeployId && redeployId !== deploymentId);
  if (redeployId) findings.restart = await step("watch:restart", () => watch(redeployId, "restart"));
}

async function httpCheck(url: string) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return { status: r.status, attempts: i + 1 };
    } catch {}
    await sleep(5000);
  }
  return { status: "unreachable", attempts: 10 };
}

async function cleanup() {
  if (!serviceId) return;
  await step("serviceDelete", () => gql("mutation($id:String!){ serviceDelete(id:$id) }", { id: serviceId }));
  const gone = await step("verify:deleted", async () => {
    try {
      const s = await gql<{ service: { deletedAt: string | null } | null }>(
        "query($id:String!){ service(id:$id){ deletedAt } }", { id: serviceId }, "verify:deleted");
      return { deletedAt: s.service?.deletedAt ?? null, found: Boolean(s.service) };
    } catch (e) { return { found: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  findings.afterDelete = gone;
}

// ---------- helpers ----------
function loadEnv(path: string): Record<string, string> {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { fail(`token file not found: ${path}`); }
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function fail(msg: string): never { console.error(msg); process.exit(1); }

// A killed run must not leave a live container: on Ctrl-C / SIGTERM, delete the
// service and write the partial report before exiting.
let finishing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (finishing) return;
    console.log(`\n${sig} received: cleaning up before exit`);
    findings.interruptedBy = sig;
    await finish();
    process.exit(130);
  });
}

try {
  await main();
} finally {
  await finish();
}

async function finish() {
  if (finishing) return;
  finishing = true;
  await cleanup();
  const report = {
    ...findings,
    totals: { requests, remainingAtEnd: lastRemaining },
    wsCost, steps, statusTrail, remainingSamples,
  };
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `run-${runId}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nrequests: ${requests}, remaining: ${lastRemaining}\nreport: ${outFile}`);
}
