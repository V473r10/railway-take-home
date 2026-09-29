# Two layers of idempotency, because `serviceCreate` takes no key

Railway's API accepts no idempotency key on `serviceCreate`, and its docs say not to assume exactly-once semantics. A double click, or a retry after a dropped connection, could therefore create two services and take two of the five slots in the sandbox project. We guard each boundary separately:

1. **Our API.** The browser sends an `Idempotency-Key` with every click, and the operations table has a unique constraint on it. The same click arriving twice resolves to the same operation. The operation is recorded before anything is sent to Railway.
2. **Railway's API.** The service is named after the operation's id. When a create ends with an ambiguous outcome (no response), the app looks the service up by name in the sandbox project before retrying, and adopts it if it exists.

Only calls with no response are retried automatically (with backoff, up to 5 attempts, respecting `Retry-After` on 429). A response carrying `errors[]` marks the operation failed at once and is never retried, since Railway did answer.

## Considered Options

- **Only the database constraint.** Rejected: it stops duplicate clicks but not a retry after Railway created the service and the response was lost.
- **Only lookup by name.** Rejected: two concurrent clicks would both look, both miss, and both create.
- **No automatic retries.** Rejected: pushes the ambiguous-outcome problem onto the user, who has no way to know whether the first click worked.
