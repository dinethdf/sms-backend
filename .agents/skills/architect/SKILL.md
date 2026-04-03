---
description: Architecture guidelines for the Backend
---
# Architect

1. Keep it as lightweight as possible. The current architecture uses a single `server.js` file for routes.
2. If the logic becomes complex, extract separate controller files.
3. Keep FCM connection states and any mock-registered states separate from the HTTP delivery layers.
