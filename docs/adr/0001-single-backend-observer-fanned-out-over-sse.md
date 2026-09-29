# One backend process observes Railway; browsers get state over SSE

Railway's Hobby rate limit is 1000 requests/hour, so one browser tab polling every 2 s (1800 req/h) would exceed it on its own. One backend process is the only thing that watches Railway: it subscribes to the deployment, reads its state once right after subscribing (subscriptions were observed not to send the current state on connect), and falls back to polling with backoff. It fans state out to browsers over Server-Sent Events. Browsers never talk to Railway.

## Considered Options

- **Browsers poll the backend, the backend polls Railway behind a cache.** Rejected: Railway traffic still grows with activity instead of with the number of containers, and "live" becomes a cache TTL.
- **Browsers talk to Railway directly.** Rejected: it would expose the account token and put the rate limit in every reviewer's hands.

## Consequences

The app runs as a single backend instance; scaling it out would need a leader or a shared pub/sub, which is out of scope.
