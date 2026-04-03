const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// Constants
const JWT_SECRET = "super_secret_jwt_key_for_simple_test_app"; // Use environment var in prod!
const PORT = 3080;

// 1. Initialize Firebase Admin
let serviceAccount;
try {
    serviceAccount = require('./firebase-key.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error("Firebase key missing or invalid, proceeding without notifications.");
}

const app = express();

// Standard CORS rule across all.
app.use(cors());
app.use(express.json());

// IN-MEMORY DATABASES (Use real DB in production!)
let registeredClinics = {}; // Stores Firebase FCM tokens mapping (clinicId -> FCM token)
let dbUsers = {}; // Stores Clinic User Accounts mapping (username -> User Object)


// --- MIDDLEWARE: JWT Auth ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extract from "Bearer <token>"
    
    if (token == null) return res.status(401).json({ error: "Unauthorized: Token missing" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Forbidden: Invalid token" });
        req.user = user; // Now req.user has { clinicId }
        next();
    });
};


// --- ENDPOINTS: AUTHENTICATION ---

// User Registration
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (dbUsers[username]) {
        return res.status(400).json({ error: 'Username already exists' });
    }

    // Generate Clinic UUID and secure password
    const clinicId = "clinic_" + uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

    // Save to Database
    dbUsers[username] = {
        username,
        password: hashedPassword,
        clinicId
    };

    console.log(`\n[👤 REGISTER] New Clinic: ${username} -> ${clinicId}`);
    
    res.status(201).json({ message: "Registration successful", clinicId });
});

// User Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    const user = dbUsers[username];
    if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate JWT Token
    const token = jwt.sign({ clinicId: user.clinicId, username: user.username }, JWT_SECRET, { expiresIn: '24h' });

    console.log(`\n[🔐 LOGIN] Clinic Auth: ${username} -> ${user.clinicId}`);
    res.json({ token, clinicId: user.clinicId, message: "Login successful" });
});


// --- ENDPOINTS: MOBILE APP REGISTRATION ---

// Mobile phone connecting FCM Token securely.
app.post('/register', (req, res) => {
    const { clinicId, token } = req.body;

    if (!clinicId || !token) {
        return res.status(400).send('Error: Missing clinicId or token');
    }

    registeredClinics[clinicId] = token;
    console.log(`\n[🔗 CONNECTED] Phone linked to Clinic: ${clinicId}`);
    res.send('Phone registered successfully!');
});


// --- ENDPOINTS: WEB APP SMS DISPATCHER (PROTECTED) ---

app.post('/trigger', authenticateToken, async (req, res) => {
    const { number, message, sim } = req.body;
    const clinicId = req.user.clinicId; // DYNAMICALLY EXTRACTED FROM JWT TOKEN!

    if (!number || !message) {
        return res.status(400).json({ error: 'Missing number or message' });
    }

    const targetToken = registeredClinics[clinicId];
    if (!targetToken) {
        return res.status(404).json({ error: `No Android phone connected to your Clinic: ${clinicId}` });
    }

    const messageId = "MSG-" + Date.now();
    const targetSimSlot = sim === '2' ? 1 : 0;

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
        if(admin.apps.length > 0) {
            await admin.messaging().send(payload);
            console.log(`\n[🚀 PUSHED] ${messageId} -> ${number} via SIM ${targetSimSlot + 1} (Triggered by ${req.user.username})`);
            res.json({ status: 'Success', messageId });
        } else {
             res.status(500).json({ error: "Firebase Admin is not configured. Cannot push." });
        }
    } catch (error) {
        console.error(`\n[❌ FIREBASE ERROR]`, error.message);
        res.status(500).json({ error: `Failed: ${error.message}` });
    }
});


// --- ENDPOINTS: MOBILE FEEDBACK REPORTS ---

app.post('/status', (req, res) => {
    const { id, status, androidResponse } = req.body;

    if (status === 'SUCCESS') {
        console.log(`[✅ DELIVERED] [${id}]: "${androidResponse}"`);
    } else {
        console.log(`[❌ FAILED] [${id}]: "${androidResponse}"`);
    }

    res.send('Status logged');
});


app.listen(PORT, '0.0.0.0', () => {
    console.log('================================================');
    console.log(`🔥 FULL-AUTH SMS GATEWAY RUNNING ON PORT ${PORT}`);
    console.log('================================================');
});