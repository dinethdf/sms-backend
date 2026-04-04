const mongoose = require('mongoose');

const smsLogSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true },
    clinicId: { type: String, required: true, index: true },
    type: { type: String, enum: ['single', 'bulk'], required: true },
    recipient: { type: String, required: true }, // number or category
    messageContent: { type: String, required: true },
    simSlot: { type: String, default: '0' },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
    errorMessage: { type: String },
    createdAt: { type: Date, default: Date.now, index: true }
});

const SmsLog = mongoose.models.SmsLog || mongoose.model('SmsLog', smsLogSchema);

module.exports = SmsLog;
