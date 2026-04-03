const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// 1. Initialize Firebase Admin
// Make sure firebase-key.json (Service Account) is in the same folder!
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(cors());
app.use(express.json());

// Stores FCM Tokens mapping (Clinic ID -> Phone Token)
let registeredClinics = {};

// --- 1. LINK THE PHONE ---
app.post('/register', (req, res) => {
    const { clinicId, token } = req.body;

    if (!clinicId || !token) {
        return res.status(400).send('Error: Missing clinicId or token');
    }

    registeredClinics[clinicId] = token;
    console.log(`\n[🔗 CONNECTED] Phone linked to Clinic: ${clinicId}`);
    res.send('Phone registered successfully!');
});

// --- 2. TRIGGER THE SMS (Called by your Spring Boot Backend) ---
app.post('/trigger', async (req, res) => {
    const { clinicId, number, message, sim } = req.body;

    if (!clinicId || !number || !message) {
        return res.status(400).send('Error: Missing clinicId, number, or message.');
    }

    const targetToken = registeredClinics[clinicId];
    if (!targetToken) {
        return res.status(404).send(`Error: No phone connected for Clinic: ${clinicId}`);
    }

    const messageId = "MSG-" + Date.now();
    const targetSimSlot = sim === '2' ? 1 : 0;

    // Firebase payload (must be strings)
    const payload = {
        token: targetToken,
        data: {
            id: String(messageId),
            number: String(number),
            message: String(message),
            simSlot: String(targetSimSlot)
        }
    };

    try {
        const response = await admin.messaging().send(payload);
        console.log(`\n[🚀 PUSHED] ${messageId} -> ${number} via SIM ${targetSimSlot + 1}`);
        res.send({ status: 'Success', messageId });
    } catch (error) {
        console.error(`[❌ FIREBASE ERROR]`, error.message);
        res.status(500).send(`Failed: ${error.message}`);
    }
});

// --- 3. STATUS REPORTING ---
app.post('/status', (req, res) => {
    const { id, status, androidResponse } = req.body;

    if (status === 'SUCCESS') {
        console.log(`[✅ DELIVERED] [${id}]: "${androidResponse}"`);
    } else {
        console.log(`[❌ FAILED] [${id}]: "${androidResponse}"`);
    }

    res.send('Status logged');
});

app.listen(3080, '0.0.0.0', () => {
    console.log('================================================');
    console.log('🔥 FIREBASE SMS GATEWAY RUNNING ON PORT 3000');
    console.log('================================================');
});