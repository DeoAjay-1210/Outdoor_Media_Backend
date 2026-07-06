const mongoose = require('mongoose');

const gstDetailSchema = new mongoose.Schema({
    business_address: {
        type: String,
        required: true,
        trim: true
    },
    business_department_code: {
        type: String,
        required: true,
        trim: true
    },
    business_entity_type: {
        type: String,
        required: true,
        trim: true
    },
    business_name: {
        type: String,
        required: true,
        trim: true
    },
    business_pan: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
        validate: {
            validator: function(v) {
                return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(v);
            },
            message: props => `${props.value} is not a valid PAN number!`
        }
    },
    business_registration_date: {
        type: Date,
        required: true,
        set: function(value) {
            if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
                const [day, month, year] = value.split('/');
                return new Date(year, month - 1, day);
            }
            return value;
        }
    },
    business_registration_type: {
        type: String,
        required: true,
    },
    gst_number: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        validate: {
            validator: function(v) {
                return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(v);
            },
            message: props => `${props.value} is not a valid GST number!`
        }
    },
    nature_of_business: {
        type: String,
        required: true,
    },
    status: {
        type: String,
        enum: ['Active', 'Inactive', 'Suspended'],
        default: 'Active'
    }
}, {
    timestamps: true
});


// gstDetailSchema.index({ gst_number: 1 });
gstDetailSchema.index({ business_pan: 1 });
gstDetailSchema.index({ business_name: 1 });

const GstDetail = mongoose.model('gstDetail', gstDetailSchema);

module.exports = GstDetail;