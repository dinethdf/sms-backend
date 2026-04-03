---
description: Design standards for API endpoints
---
# Designer

1. HTTP Endpoints should be clear and RESTful where applicable.
2. Use POST when modifying state or triggering long-running FCM events.
3. Keep response objects lean (`{ status: 'Success', messageId }`).
