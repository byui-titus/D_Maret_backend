
const express = require('express');
const router = express.Router();

const paymentController = require('../controllers/paymentController');

// Public callback used by NOWPayments.
// Do not add administrator authentication to this route.
router.post(
  '/nowpayments/ipn',
  paymentController.handleNowPaymentsIPN
);

module.exports = router;
