#!/usr/bin/env node
// Pause or resume the deployed app and its Postgres, so they don't burn
// plan credit between demos.
//
//   RAILWAY_TOKEN=... SANDBOX_PROJECT_ID=... node scripts/railway-power.mjs pause|resume|restart|configure|status
//
// pause:  refuses while the sandbox still has services (nothing would enforce
//         their lifetime with the app down), then stops app, then Postgres.
// resume: redeploys Postgres, waits for it, then redeploys the app. The app's
//         startup reconciler and lifetime sweep run as usual on boot.
// The Postgres volume is kept while stopped; only its compute stops.

const API = "https://backboard.railway.com/graphql/v2";
const APP_PROJECT_ID = process.env.APP_PROJECT_ID ?? "2a63b98d-f1a5-4f0d-a09c-ed3823b65445";
const ORDER = ["app", "Postgres"]; // pause order; resume is the reverse

const token = process.env.RAILWAY_TOKEN;
const sandboxId = process.env.SANDBOX_PROJECT_ID;
const command = process.argv[2];

if (!token || !["pause", "resume", "restart", "configure", "status"].includes(command)) {
  console.error("usage: RAILWAY_TOKEN=... [SANDBOX_PROJECT_ID=...] node scripts/railway-power.mjs pause|resume|restart|configure|status");
  process.exit(2);
}

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

async function services() {
  const data = await gql(
    `query($id: String!) { project(id: $id) { services { edges { node { id name
      serviceInstances { edges { node { environmentId latestDeployment { id status deploymentStopped } } } } } } } } }`,
    { id: APP_PROJECT_ID },
  );
  return data.project.services.edges.map(({ node }) => {
    const instance = node.serviceInstances.edges[0]?.node;
    return {
      id: node.id,
      name: node.name,
      environmentId: instance?.environmentId,
      deployment: instance?.latestDeployment ?? null,
    };
  });
}

const describe = (s) =>
  `${s.name}: ${s.deployment ? `${s.deployment.status}${s.deployment.deploymentStopped ? " (stopped)" : ""}` : "no deployment"}`;

const isUp = (s) => s.deployment?.status === "SUCCESS" && !s.deployment.deploymentStopped;

async function waitFor(name, predicate, timeoutMs = 180_000) {
  const start = Date.now();
  for (;;) {
    const s = (await services()).find((x) => x.name === name);
    if (predicate(s)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${name} (${describe(s)})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const byName = (list, name) => {
  const s = list.find((x) => x.name === name);
  if (!s) throw new Error(`service ${name} not found in the app project`);
  return s;
};

async function pause() {
  if (!sandboxId) throw new Error("SANDBOX_PROJECT_ID is required to pause safely");
  const sandbox = await gql(`query($id: String!) { project(id: $id) { services { edges { node { name } } } } }`, {
    id: sandboxId,
  });
  const left = sandbox.project.services.edges.map((e) => e.node.name);
  if (left.length) {
    throw new Error(`the sandbox still has ${left.join(", ")}; destroy them from the app before pausing`);
  }
  const list = await services();
  for (const name of ORDER) {
    const s = byName(list, name);
    if (!isUp(s)) {
      console.log(`${describe(s)} -- already down`);
      continue;
    }
    await gql(`mutation($id: String!) { deploymentStop(id: $id) }`, { id: s.deployment.id });
    await waitFor(name, (x) => !isUp(x));
    console.log(`${name}: stopped`);
  }
}

async function resume() {
  const list = await services();
  for (const name of [...ORDER].reverse()) {
    const s = byName(list, name);
    if (isUp(s)) {
      console.log(`${describe(s)} -- already up`);
      continue;
    }
    await gql(`mutation($s: String!, $e: String!) { serviceInstanceRedeploy(serviceId: $s, environmentId: $e) }`, {
      s: s.id,
      e: s.environmentId,
    });
    // A redeploy creates a new deployment; wait until one is up.
    await waitFor(name, (x) => isUp(x) && x.deployment.id !== s.deployment?.id);
    console.log(`${name}: running`);
  }
}

// The app service's deploy settings. Railway ignores railway.json for services created
// after Config as Code was deprecated, so they are applied through the API instead.
const APP_SETTINGS = {
  // node directly: npm reports the SIGTERM of a stop as a failure, so a clean stop showed as CRASHED.
  startCommand: "node src/server/main.ts",
  healthcheckPath: "/api/health",
  healthcheckTimeout: 120,
  restartPolicyType: "ON_FAILURE",
  restartPolicyMaxRetries: 10,
};

// Write the settings, then redeploy: a running deployment keeps the settings it started with.
async function configure() {
  const s = byName(await services(), "app");
  await gql(`mutation($s: String!, $e: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $input) }`, {
    s: s.id,
    e: s.environmentId,
    input: APP_SETTINGS,
  });
  console.log(`app: settings written (${Object.keys(APP_SETTINGS).join(", ")}); redeploying`);
  await gql(`mutation($s: String!, $e: String!) { serviceInstanceRedeploy(serviceId: $s, environmentId: $e) }`, {
    s: s.id,
    e: s.environmentId,
  });
  await waitFor("app", (x) => isUp(x) && x.deployment.id !== s.deployment?.id, 300_000);
  console.log("app: running with the new settings");
}

// Restart the app's process in place, for the walkthrough's "kill it mid-create" demo.
async function restart() {
  const s = byName(await services(), "app");
  if (!isUp(s)) throw new Error(`${describe(s)}; resume it first`);
  await gql(`mutation($id: String!) { deploymentRestart(id: $id) }`, { id: s.deployment.id });
  console.log("app: restart requested");
}

try {
  if (command === "restart") await restart();
  if (command === "configure") await configure();
  if (command === "pause") await pause();
  if (command === "resume") await resume();
  for (const s of await services()) console.log(describe(s));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
