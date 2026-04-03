# Backend Rules

1. **Tech Stack**: Use Node.js and Express.js for all API routing.
2. **Integration**: Interact with Firebase Admin SDK for communicating with the mobile Android app via FCM.
3. **Data format**: Ensure payload data in FCM pushes are stringified correctly to avoid failing deliveries.
4. **Error Handling**: Catch exceptions and report them gracefully HTTP 500 status back to callers or log them meaningfully.
