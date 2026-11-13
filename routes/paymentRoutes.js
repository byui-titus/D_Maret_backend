
const express = require('express');
const router = express.Router();

const paymentController = require('../controllers/paymentController');

// Customer requests a hosted payment invoice.
router.post(
  '/nowpayments/invoice',
  paymentController.createNowPaymentsInvoice
);

// NOWPayments sends payment notifications.
router.post(
  '/nowpayments/ipn',
  paymentController.handleNowPaymentsIPN
);

module.exports = router;
