const express = require('express');
const router = express.Router();
const {
    createGstDetail,
    getAllGstDetails,
    getGstDetailById,
    updateGstDetail,
    deleteGstDetail,verifyGstNumber
} = require('../../../controllers/Admin/gstDetailController/gstDetail');


router.post('/verify', verifyGstNumber);


router.post('/', createGstDetail);
router.get('/', getAllGstDetails);
router.get('/:id', getGstDetailById);
router.put('/:id', updateGstDetail);
router.delete('/:id', deleteGstDetail);

module.exports = router;