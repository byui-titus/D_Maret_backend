
const express = require('express');
const router = express.Router();

const orderController = require('../controllers/orderController');
const protectAdmin = require('../middleware/authMiddleware');

// Customer routes
router.post('/', orderController.createOrder);
router.get('/track/:orderNumber', orderController.trackOrder);

// Administrator routes
router.get('/admin/all', protectAdmin, orderController.getAllOrders);
router.patch(
  '/admin/:orderId/status',
  protectAdmin,
  orderController.updateOrderStatus
);

module.exports = router;
