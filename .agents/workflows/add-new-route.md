---
description: Steps to add a new API route
---
# Adding a New Route

1. Open `server.js`.
2. Define the exact purpose of the new route.
3. Create an `app.post` or `app.get` block depending on the REST verb.
4. Always catch any Firebase action asynchronously to avoid unhandled rejections.
