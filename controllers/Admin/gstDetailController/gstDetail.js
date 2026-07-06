
require("dotenv").config();
const GstDetail = require('../../../models/Admin/GSTDetailsSchema/gstdetails');
const { successResponse, errorResponse } = require('../../../utils/response');


const parseDate = (dateString) => {
    if (!dateString) return null;
    
   
    const ddmmyyyyPattern = /^(\d{2})\/(\d{2})\/(\d{4})$/;
    const match = dateString.match(ddmmyyyyPattern);
    
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]) - 1; 
        const year = parseInt(match[3]);
        return new Date(year, month, day);
    }
    
   
    return new Date(dateString);
};


const createGstDetail = async (req, res) => {
    try {
        const {
            business_address,
            business_department_code,
            business_entity_type,
            business_name,
            business_pan,
            business_registration_date,
            business_registration_type,
            gst_number,
            nature_of_business
        } = req.body;

    
        const existingGst = await GstDetail.findOne({ gst_number });
        if (existingGst) {
            return errorResponse(res, 'GST number already exists', null, 400);
        }

     
        const existingPan = await GstDetail.findOne({ business_pan });
        if (existingPan) {
            return errorResponse(res, 'PAN number already registered', null, 400);
        }

     
        const parsedDate = parseDate(business_registration_date);
        if (isNaN(parsedDate.getTime())) {
            return errorResponse(res, 'Invalid date format. Please use DD/MM/YYYY format', null, 400);
        }

      
        const gstDetail = await GstDetail.create({
            business_address,
            business_department_code,
            business_entity_type,
            business_name,
            business_pan,
            business_registration_date: parsedDate,
            business_registration_type,
            gst_number,
            nature_of_business
        });

        return successResponse(res, 'GST detail created successfully', gstDetail, 201);

    } catch (error) {
     
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            return errorResponse(res, 'Validation Error', messages, 400);
        }

        return errorResponse(res, 'Server Error', error.message, 500);
    }
};


const verifyGstNumber = async (req, res) => {
    try {
        const { gst_number } = req.body;

        if (!gst_number?.trim()) {
            return errorResponse(res, 'GST number is required', null, 400);
        }

        const gstUpper = gst_number.trim().toUpperCase();

      
        const existing = await GstDetail.findOne({ gst_number: gstUpper });
        if (existing) {
            return successResponse(res, 'GST verified from database', {
                gstDetailId: existing._id,
                business_name: existing.business_name,
                business_address: existing.business_address,
                gst_number: existing.gst_number,
                nature_of_business: existing.nature_of_business,
                source: 'database',
            });
        }

      
        // Token
        const tokenRes = await fetch('https://ocr.meon.co.in/get_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                company_id: process.env.MEON_COMPANY_ID,
                email: process.env.MEON_EMAIL,
                password: process.env.MEON_PASSWORD,
            }),
        });

        const tokenData = await tokenRes.json();
        const token = tokenData?.token;

        if (!token) {
            return errorResponse(res, 'Failed to get verification token', null, 500);
        }

        // GST details fetch 
        const gstRes = await fetch('https://ocr.meon.co.in/gst/search_business_name', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ gst_number: gstUpper }),
        });

        const gstData = await gstRes.json();

     
        if (!gstRes.ok || !gstData?.gst_number) {
            return errorResponse(res, 'GST number not found or invalid', null, 404);
        }

        // ── STEP 3: DB
        const parseDate = (dateString) => {
            if (!dateString) return new Date();
            const ddmmyyyyPattern = /^(\d{2})\/(\d{2})\/(\d{4})$/;
            const match = dateString.match(ddmmyyyyPattern);
            if (match) {
                return new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
            }
            return new Date(dateString);
        };

        const newGst = await GstDetail.create({
            business_address: gstData.business_address || '',
            business_department_code: gstData.business_department_code || '',
            business_entity_type: gstData.business_entity_type || '',
            business_name: gstData.business_name || '',
            business_pan: gstData.business_pan || '',
            business_registration_date: parseDate(gstData.business_registration_date),
            business_registration_type: gstData.business_registration_type || '',
            gst_number: gstData.gst_number,
            nature_of_business: gstData.nature_of_business || '',
        });

        return successResponse(res, 'GST verified and saved successfully', {
            gstDetailId: newGst._id,
            business_name: newGst.business_name,
            business_address: newGst.business_address,
            gst_number: newGst.gst_number,
            source: 'api',
        });

    } catch (error) {
        return errorResponse(res, 'GST verification failed', error.message, 500);
    }
};


const getAllGstDetails = async (req, res) => {
    try {
        const { search, status } = req.query;
        
        let query = {};
        
       
        if (search) {
            query.$or = [
                { business_name: { $regex: search, $options: 'i' } },
                { gst_number: { $regex: search, $options: 'i' } },
                { business_pan: { $regex: search, $options: 'i' } }
            ];
        }
        
      
        if (status) {
            query.status = status;
        }

        const gstDetails = await GstDetail.find(query).sort({ createdAt: -1 });

        return successResponse(res, 'GST details fetched successfully', gstDetails);

    } catch (error) {
        return errorResponse(res, 'Server Error', error.message, 500);
    }
};


const getGstDetailById = async (req, res) => {
    try {
        const gstDetail = await GstDetail.findById(req.params.id);

        if (!gstDetail) {
            return errorResponse(res, 'GST detail not found', null, 404);
        }

        return successResponse(res, 'GST detail fetched successfully', gstDetail);

    } catch (error) {
        if (error.kind === 'ObjectId') {
            return errorResponse(res, 'Invalid ID format', null, 400);
        }
        
        return errorResponse(res, 'Server Error', error.message, 500);
    }
};


const updateGstDetail = async (req, res) => {
    try {
        const updateData = { ...req.body };
        
       
        if (updateData.business_registration_date) {
            const parsedDate = parseDate(updateData.business_registration_date);
            if (isNaN(parsedDate.getTime())) {
                return errorResponse(res, 'Invalid date format. Please use DD/MM/YYYY format', null, 400);
            }
            updateData.business_registration_date = parsedDate;
        }

        const gstDetail = await GstDetail.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true, runValidators: true }
        );

        if (!gstDetail) {
            return errorResponse(res, 'GST detail not found', null, 404);
        }

        return successResponse(res, 'GST detail updated successfully', gstDetail);

    } catch (error) {
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            return errorResponse(res, 'Validation Error', messages, 400);
        }

        return errorResponse(res, 'Server Error', error.message, 500);
    }
};


const deleteGstDetail = async (req, res) => {
    try {
        const gstDetail = await GstDetail.findByIdAndDelete(req.params.id);

        if (!gstDetail) {
            return errorResponse(res, 'GST detail not found', null, 404);
        }

        return successResponse(res, 'GST detail deleted successfully', null);

    } catch (error) {
        return errorResponse(res, 'Server Error', error.message, 500);
    }
};

module.exports = {
    createGstDetail,
    getAllGstDetails,
    getGstDetailById,
    updateGstDetail,
    deleteGstDetail,
    verifyGstNumber
};