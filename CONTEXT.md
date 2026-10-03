# Railway Container Control

A small app that spins containers up and down on Railway through its public GraphQL API, and shows each container's lifecycle live.

## Language

**Container**:
What the user sees and acts on: one Railway service running a fixed image, together with its current deployment. Only services this app created are containers; anything else in the sandbox project is ignored.
_Avoid_: App, instance, box

**Service**:
The Railway resource that gives a container its stable identity; it outlives any single deployment.
_Avoid_: Container (when the Railway resource specifically is meant)

**Deployment**:
One attempt by Railway to run a service. Each start produces a new deployment with a new identity.
_Avoid_: Deploy (as a noun), release, build

**Current deployment**:
The one deployment of a service whose state is the container's state; older deployments are history.
_Avoid_: Latest deployment, active deployment

**Stop**:
Taking a container offline while keeping its service, so it can be started again.
_Avoid_: Spin down (ambiguous), pause, sleep

**Start**:
Bringing a stopped container back online, which creates a new current deployment.
_Avoid_: Restart, resume

**Destroy**:
Removing a container's service and every deployment it had; irreversible.
_Avoid_: Delete (in the UI), spin down, remove

**Sandbox project**:
The Railway project where containers live, kept separate from the project that runs this app.
_Avoid_: Workspace, environment

**Container limit**:
The most containers that may exist at once, counting stopped ones, since each holds a service slot.
_Avoid_: Quota, max running

**Lifetime**:
How long a container may exist, counted from its creation; when it runs out, the container is destroyed whatever its state.
_Avoid_: TTL (in the UI), expiry, timeout

## Operations

**Operation**:
One requested action on a container (create, stop, start or destroy), recorded before anything is sent to Railway.
_Avoid_: Job, task, command, request

**Active operation**:
The one operation of a container that has not finished yet; a container has at most one, except that a destroy may always be requested.
_Avoid_: Pending operation, lock

**Idempotency key**:
The identity the browser gives each click, so that the same click sent twice becomes one operation.
_Avoid_: Request id, dedupe key, nonce

**Ambiguous outcome**:
A call to Railway that ended without a response, so the app cannot tell whether Railway acted on it.
_Avoid_: Timeout, network error, unknown state

**Timeline**:
The record of everything the app did for one container, step by step: each request, each call to Railway and how it ended, each look before repeating a call, and what Railway reported. Kept for people to read; nothing is decided from it.
_Avoid_: Log, history, audit trail

## Container states

**Transitional state**:
The state of a container while it has an active operation: creating, starting, stopping or destroying.
_Avoid_: Pending, in progress, busy

**Running**:
A container whose current deployment succeeded and has not been stopped.
_Avoid_: Up, live, active

**Stopped**:
A container whose current deployment succeeded and was then stopped.
_Avoid_: Paused, down, sleeping

**Failed**:
A container whose last operation could not be completed; the fault is in the request, not in the container.
_Avoid_: Errored, broken, crashed

**Crashed**:
A container that Railway reports as down after it had been running; the fault is in the container, not in the request.
_Avoid_: Failed, dead, errored

**Observed state**:
What Railway last reported about a container. When it disagrees with what the app recorded, the observed state wins.
_Avoid_: Real state, actual state, live state

**Deployment phase**:
What a deployment's observed state means for its container: serving, stopped, coming up, down or going away.
_Avoid_: Status (that is Railway's raw value), health

**Missing**:
A container the app recorded whose service no longer exists on Railway because something outside the app removed it.
_Avoid_: Orphan, deleted, lost

**Read-only mode**:
The state of the app when it cannot confirm who its Railway token belongs to: it shows containers but refuses every operation.
_Avoid_: Degraded mode, safe mode, maintenance mode
