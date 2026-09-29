# Verify the token's identity at startup and fall back to read-only mode

Railway does not reject an invalid token: the request goes through as anonymous, and an anonymous caller can still create projects and services (only deploying requires login). So "the first mutation will fail" is not a safe assumption. At startup the backend asks Railway who the token belongs to; if that check fails, the app starts in read-only mode with a visible banner and refuses every operation, instead of refusing to start.

## Considered Options

- **Refuse to start.** Rejected: Railway restarts crashed services, so a bad token becomes a silent crash loop with no explanation visible to the person looking at the app.
- **Trust the first mutation to fail.** Rejected: with an invalid token it does not fail, it creates resources under an anonymous identity.
