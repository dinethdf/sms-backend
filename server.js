require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

// Mongoose Models
const User = require('./models/User');
const Contact = require('./models/Contact');

// Constants
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";
const PORT = process.env.PORT || 3080;
const MONGODB_URI = process.env.MONGODB_URI;

// 1. Initialize MongoDB
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log('✅ Connected to MongoDB Atlas'))
        .catch(err => console.error('❌ MongoDB Connection Error:', err));
} else {
    console.error('❌ MONGODB_URI is missing from .env');
}

// 2. Initialize Firebase Admin
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
app.use(cors());
app.use(express.json());

// IN-MEMORY DEVICE STATE
let registeredClinics = {}; // Stores Firebase FCM tokens mapping (clinicId -> Android Device FCM token)


// --- MIDDLEWARE: JWT Auth ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.status(401).json({ error: "Unauthorized: Token missing" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Forbidden: Invalid token" });
        req.user = user;
        next();
    });
};


// --- ENDPOINTS: AUTHENTICATION ---

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'Username already exists' });

        const clinicId = "clinic_" + uuidv4();
        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            username,
            password: hashedPassword,
            clinicId
        });
        await newUser.save();

        console.log(`\n[👤 REGISTER DB] New Clinic: ${username} -> ${clinicId}`);
        res.status(201).json({ message: "Registration successful", clinicId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(401).json({ error: 'Invalid username or password' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Invalid username or password' });

        const token = jwt.sign({ clinicId: user.clinicId, username: user.username }, JWT_SECRET, { expiresIn: '24h' });

        console.log(`\n[🔐 LOGIN DB] Clinic Auth: ${username} -> ${user.clinicId}`);
        res.json({ token, clinicId: user.clinicId, message: "Login successful" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- ENDPOINTS: CONTACTS MANAGEMENT ---

app.post('/api/contacts', authenticateToken, async (req, res) => {
    const { name, number, category } = req.body;
    try {
        const contact = new Contact({
            clinicId: req.user.clinicId,
            name,
            number,
            category: category || 'General'
        });
        await contact.save();
        res.status(201).json(contact);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/contacts', authenticateToken, async (req, res) => {
    try {
        const contacts = await Contact.find({ clinicId: req.user.clinicId });
        res.json(contacts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/contacts/categories', authenticateToken, async (req, res) => {
    try {
        const categories = await Contact.distinct('category', { clinicId: req.user.clinicId });
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- ENDPOINTS: MOBILE APP REGISTRATION ---

app.post('/register', (req, res) => {
    const { clinicId, token } = req.body;
    if (!clinicId || !token) return res.status(400).send('Error: Missing clinicId or token');

    registeredClinics[clinicId] = token;
    console.log(`\n[🔗 CONNECTED] Phone linked to Clinic: ${clinicId}`);
    res.send('Phone registered successfully!');
});


// --- ENDPOINTS: WEB APP SMS DISPATCHER (PROTECTED) ---

app.post('/trigger', authenticateToken, async (req, res) => {
    const { number, message, sim } = req.body;
    const clinicId = req.user.clinicId;

    if (!number || !message) return res.status(400).json({ error: 'Missing number or message' });

    const targetToken = registeredClinics[clinicId];
    if (!targetToken) return res.status(404).json({ error: `Not connected` });

    const messageId = "MSG-" + Date.now();
    const targetSimSlot = sim === '2' ? 1 : 0;

    const payload = {
        token: targetToken,
        data: {
            id: String(messageId),
            type: "single",
            number: String(number),
            message: String(message),
            simSlot: String(targetSimSlot)
        }
    };

    try {
        if (admin.apps.length > 0) {
            await admin.messaging().send(payload);
            res.json({ status: 'Success', messageId });
        } else {
            res.status(500).json({ error: "Firebase Admin is not configured." });
        }
    } catch (error) {
        res.status(500).json({ error: `Failed: ${error.message}` });
    }
});

app.post('/trigger-bulk', authenticateToken, async (req, res) => {
    const { category, message, sim } = req.body;
    const clinicId = req.user.clinicId;

    if (!category || !message) return res.status(400).json({ error: 'Missing category or message' });

    const targetToken = registeredClinics[clinicId];
    if (!targetToken) return res.status(404).json({ error: `No Android connected for ${clinicId}` });

    let filter = { clinicId };
    if (category !== 'All') filter.category = category;

    try {
        const contacts = await Contact.find(filter);
        if (!contacts || contacts.length === 0) {
            return res.status(400).json({ error: "No contacts found for this category" });
        }

        const numbers = contacts.map(c => c.number);
        const messageId = "BULK-" + Date.now();
        const targetSimSlot = sim === '2' ? 1 : 0;

        const payload = {
            token: targetToken,
            data: {
                id: String(messageId),
                type: "bulk",
                numbers: JSON.stringify(numbers), // Parse securely back on Mobile array
                message: String(message),
                simSlot: String(targetSimSlot)
            }
        };

        if (admin.apps.length > 0) {
            await admin.messaging().send(payload);
            console.log(`\n[🚀 PUSHED BULK] ${numbers.length} messages -> Android Queue`);
            res.json({ status: 'Success', messageId, count: numbers.length });
        } else {
            res.status(500).json({ error: "Firebase Admin not configured." });
        }
    } catch (err) {
        res.status(500).json({ error: `Failed: ${err.message}` });
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
    console.log(`🚀 MONGO-DB + FULL-AUTH SMS GATEWAY ON PORT ${PORT}`);
    console.log('================================================');
});