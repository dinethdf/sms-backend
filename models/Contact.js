const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
    clinicId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    number: { type: String, required: true },
    category: { type: String, required: true, default: 'General' }
}, {
    timestamps: true
});

module.exports = mongoose.model('Contact', contactSchema);
