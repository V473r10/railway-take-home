# Containers live in a separate sandbox project

The Hobby plan allows 2 projects with 5 services each. Containers go in their own sandbox project instead of the project that runs this app, so a buggy destroy can never reach the app or its database, and containers get all 5 service slots. The cost is that both allowed projects are used, which leaves no room for a staging copy of the app.
