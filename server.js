require('dotenv').config(); // Added to load variables locally
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const EventEmitter = require('events');
const statusEmitter = new EventEmitter();

// ==========================================
// 1. ENVIRONMENT CONFIGURATION
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3080;

// ==========================================
// 2. VERCEL-PROOF MONGODB CACHE
// ==========================================
// This stops Vercel from opening 100+ connections and crashing MongoDB
let cachedDb = global.mongoose;
if (!cachedDb) {
    cachedDb = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
    if (cachedDb.conn) return cachedDb.conn;

    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000,
        }).then((mongoose) => {
            console.log('✅ Global MongoDB Connected Successfully!');
            return mongoose;
        }).catch(err => {
            console.error('❌ MONGODB CONNECTION FATAL ERROR:', err.message);
            cachedDb.promise = null; // reset if it fails
            throw err;
        });
    }

    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
}

// ==========================================
// 3. INITIALIZE FIREBASE
// ==========================================
let rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

// MAGIC FIX: If the key exists, force the \n characters to become real line breaks
if (rawPrivateKey) {
    // This Regex looks for literal \n and replaces it with an actual newline
    // It also removes any accidental quotes you might have pasted
    rawPrivateKey = rawPrivateKey.replace(/\\n/g, '\n').replace(/"/g, '');
}

const serviceAccount = {
    "type": "service_account",
    "project_id": process.env.FIREBASE_PROJECT_ID,
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": rawPrivateKey,
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL,
    "universe_domain": "googleapis.com"
};

try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Firebase Admin connected successfully!');
    }
} catch (e) {
    console.error("❌ Firebase initialization error:", e.message);
}

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 4. VERCEL DB MIDDLEWARE
// ==========================================
// This forces Express to verify the DB is connected before answering any route
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        res.status(500).json({ error: "Database connection failed" });
    }
});

// IN-MEMORY DEVICE STATE (FCM Tokens)
let registeredClinics = {};

// ==========================================
// 5. DATABASE MODELS
// ==========================================
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    clinicId: { type: String, required: true }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const contactSchema = new mongoose.Schema({
    clinicId: { type: String, required: true },
    name: { type: String, required: true },
    number: { type: String, required: true },
    category: { type: String, default: 'General' }
});
const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);

const SmsLog = require('./models/SmsLog');

// ==========================================
// 6. AUTH MIDDLEWARE
// ==========================================
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

// ==========================================
// 7. AUTHENTICATION ENDPOINTS
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'Username already exists' });

        const clinicId = "clinic_" + uuidv4();
        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({ username, password: hashedPassword, clinicId });
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

// ==========================================
// 8. CONTACTS ENDPOINTS (Protected)
// ==========================================
app.post('/api/contacts', authenticateToken, async (req, res) => {
    const { name, number, category } = req.body;
    try {
        const contact = new Contact({
            clinicId: req.user.clinicId, name, number, category: category || 'General'
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

// ==========================================
// 9. SMS GATEWAY ENDPOINTS
// ==========================================
app.post('/register', authenticateToken, (req, res) => {
    const clinicId = req.user.clinicId;
    const { token } = req.body;
    if (!token) return res.status(400).send('Error: Missing token');

    registeredClinics[clinicId] = token;
    console.log(`\n[🔗 CONNECTED] Phone linked to Clinic: ${clinicId}`);
    res.send('Phone registered successfully!');
});

app.post('/trigger', authenticateToken, async (req, res) => {
    const { number, message, sim } = req.body;
    const clinicId = req.user.clinicId;

    if (!number || !message) return res.status(400).json({ error: 'Missing number or message' });

    const targetToken = registeredClinics[clinicId];
    if (!targetToken) return res.status(404).json({ error: `No Android connected for ${clinicId}` });

    const messageId = "MSG-" + Date.now();
    const targetSimSlot = sim === '2' ? 1 : 0;

    const payload = {
        token: targetToken,
        data: { id: String(messageId), type: "single", number: String(number), message: String(message), simSlot: String(targetSimSlot) }
    };

    try {
        if (admin.apps.length > 0) {
            await SmsLog.create({
                messageId: String(messageId),
                clinicId,
                type: 'single',
                recipient: String(number),
                messageContent: String(message),
                simSlot: String(targetSimSlot),
                status: 'PENDING'
            });

            await admin.messaging().send(payload);
            
            const getStatus = new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    statusEmitter.removeAllListeners(messageId);
                    resolve({ status: 'TIMEOUT' });
                }, 10000); // 10s wait

                statusEmitter.once(messageId, (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                });
            });

            const finalResult = await getStatus;
            
            if (finalResult.status === 'SUCCESS') {
                res.json({ status: 'SUCCESS', messageId });
            } else if (finalResult.status === 'TIMEOUT') {
                res.json({ status: 'PENDING', messageId });
            } else {
                res.status(400).json({ error: finalResult.errorMessage || 'Failed to send' });
            }
            
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
        if (!contacts || contacts.length === 0) return res.status(400).json({ error: "No contacts found for this category" });

        const numbers = contacts.map(c => c.number);
        const messageId = "BULK-" + Date.now();
        const targetSimSlot = sim === '2' ? 1 : 0;

        const payload = {
            token: targetToken,
            data: { id: String(messageId), type: "bulk", numbers: JSON.stringify(numbers), message: String(message), simSlot: String(targetSimSlot) }
        };

        if (admin.apps.length > 0) {
            const logs = numbers.map(num => ({
                messageId: `${messageId}-${num}`,
                clinicId,
                type: 'bulk',
                recipient: num,
                messageContent: message,
                simSlot: String(targetSimSlot),
                status: 'PENDING'
            }));
            await SmsLog.insertMany(logs);

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

app.post('/status', authenticateToken, async (req, res) => {
    const { id, status, androidResponse, reports, isBatch } = req.body;
    
    const updateLog = async (msgId, msgStatus, response) => {
        try {
            await SmsLog.findOneAndUpdate(
                { messageId: msgId },
                { 
                   status: msgStatus === 'SUCCESS' ? 'SUCCESS' : 'FAILED', 
                   errorMessage: msgStatus === 'SUCCESS' ? '' : String(response) 
                }
            );
            if (msgStatus === 'SUCCESS') {
                console.log(`[✅ DELIVERED] [${msgId}]: "${response}"`);
            } else {
                console.log(`[❌ FAILED] [${msgId}]: "${response}"`);
            }
            statusEmitter.emit(msgId, { status: msgStatus, errorMessage: response });
        } catch(e) {
            console.error("Error updating log:", e.message);
        }
    };

    if (isBatch && Array.isArray(reports)) {
        console.log(`\n[📥 BATCH STATUS] Received ${reports.length} offline reports.`);
        for (const report of reports) {
            await updateLog(report.id, report.status, report.androidResponse);
        }
    } else {
        await updateLog(id, status, androidResponse);
    }

    res.send('Status logged');
});

app.get('/api/sms/history', authenticateToken, async (req, res) => {
    try {
        const logs = await SmsLog.find({ clinicId: req.user.clinicId }).sort({ createdAt: -1 });
        const totalSent = logs.length;
        const totalFailed = logs.filter(l => l.status === 'FAILED').length;
        res.json({ logs, summary: { totalSent, totalFailed } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sms/resend', authenticateToken, async (req, res) => {
    const { messageId } = req.body;
    const clinicId = req.user.clinicId;

    try {
        const log = await SmsLog.findOne({ messageId, clinicId });
        if (!log) return res.status(404).json({ error: "No log found for this ID." });

        const targetToken = registeredClinics[clinicId];
        if (!targetToken) return res.status(404).json({ error: "Your Android device is not linked." });

        const payload = {
            token: targetToken,
            data: { 
                id: String(log.messageId), 
                type: log.type === 'bulk' ? 'bulk' : 'single', 
                number: String(log.recipient), 
                message: String(log.messageContent), 
                simSlot: String(log.simSlot || '0') 
            }
        };

        if (log.type === 'bulk') {
            payload.data.numbers = JSON.stringify([log.recipient]);
            payload.data.type = "single"; // Resending a single line from a bulk set as a single trigger
        }

        await SmsLog.updateOne({ messageId: log.messageId }, { status: 'PENDING', errorMessage: '' });
        await admin.messaging().send(payload);

        const getStatus = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                statusEmitter.removeAllListeners(log.messageId);
                resolve({ status: 'TIMEOUT' });
            }, 10000);

            statusEmitter.once(log.messageId, (result) => {
                clearTimeout(timeout);
                resolve(result);
            });
        });

        const finalResult = await getStatus;
        
        if (finalResult.status === 'FAILED') {
            return res.status(400).json({ error: finalResult.errorMessage || 'Failed to resend' });
        }

        console.log(`\n[🔄 RESENT] ${log.recipient} -> Target Mobile`);
        res.json({ message: "Resend triggered successfully!", status: finalResult.status === 'TIMEOUT' ? 'PENDING' : 'SUCCESS' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 10. START / EXPORT FOR VERCEL
// ==========================================
// This checks if we are running locally or on Vercel.
// Vercel requires us to EXPORT the app, local requires us to LISTEN.
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log('================================================');
        console.log(`🚀 MONGO-DB + FULL-AUTH SMS GATEWAY ON PORT ${PORT}`);
        console.log('================================================');
    });
}

// Export for Vercel Serverless
module.exports = app;