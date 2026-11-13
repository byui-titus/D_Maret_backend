const { ObjectId } = require('mongodb');
const { randomBytes } = require('crypto');
const { getDB } = require('../config/database');

function generateOrderNumber() {
  return `DM-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

// POST /api/orders
// Create a customer order.
async function createOrder(req, res) {
  try {
    const { productId, customerName, customerEmail } = req.body;

    if (!ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: 'A valid product is required.',
      });
    }

    if (
      typeof customerName !== 'string' ||
      customerName.trim().length < 2 ||
      customerName.trim().length > 100
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid customer name.',
      });
    }

    const email = String(customerEmail || '').trim().toLowerCase();

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address.',
      });
    }

    const db = getDB();

    const product = await db.collection('products').findOne({
      _id: new ObjectId(productId),
      available: true,
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'This product is unavailable or no longer exists.',
      });
    }

    const now = new Date();
    const orderNumber = generateOrderNumber();

    const order = {
      orderNumber,

      customer: {
        name: customerName.trim(),
        email,
      },

      product: {
        productId: product._id,
        name: product.name,
        category: product.category,
        price: product.price,
      },

      currency: 'USD',
      totalAmount: product.price,

      paymentStatus: 'pending',
      orderStatus: 'awaiting_payment',
      deliveryStatus: 'not_started',

      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('orders').insertOne(order);

    res.status(201).json({
      success: true,
      message: 'Your order has been created successfully.',
      order: {
        ...order,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    console.error('Create order error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to create your order. Please try again.',
    });
  }
}

// GET /api/orders/track/:orderNumber
// Customers can check their order using their reference and email.
async function trackOrder(req, res) {
  try {
    const orderNumber = String(req.params.orderNumber || '').trim();
    const email = String(req.query.email || '').trim().toLowerCase();

    if (!orderNumber || !email) {
      return res.status(400).json({
        success: false,
        message: 'Order reference and email are required.',
      });
    }

    const db = getDB();

    const order = await db.collection('orders').findOne({
      orderNumber,
      'customer.email': email,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'No order was found with those details.',
      });
    }

    res.status(200).json({
      success: true,
      order: {
        orderNumber: order.orderNumber,
        product: order.product,
        totalAmount: order.totalAmount,
        currency: order.currency,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        deliveryStatus: order.deliveryStatus,
        createdAt: order.createdAt,
      },
    });
  } catch (error) {
    console.error('Track order error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to retrieve order details.',
    });
  }
}

// GET /api/orders/admin/all
// Administrator-only order listing.
async function getAllOrders(req, res) {
  try {
    const db = getDB();

    const orders = await db.collection('orders')
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.status(200).json({
      success: true,
      total: orders.length,
      orders,
    });
  } catch (error) {
    console.error('Get orders error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to retrieve orders.',
    });
  }
}


// PATCH /api/orders/admin/:orderId/status
// Administrator-only order status update.
async function updateOrderStatus(req, res) {
  try {
    const { orderId } = req.params;
    const {
      paymentStatus,
      orderStatus,
      deliveryStatus,
    } = req.body;

    if (!ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID.',
      });
    }

    const allowedPaymentStatuses = [
      'pending',
      'confirmed',
      'failed',
      'refunded',
    ];

    const allowedOrderStatuses = [
      'awaiting_payment',
      'processing',
      'completed',
      'cancelled',
    ];

    const allowedDeliveryStatuses = [
      'not_started',
      'processing',
      'delivered',
    ];

    const updates = {};

    if (paymentStatus !== undefined) {
      if (!allowedPaymentStatuses.includes(paymentStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment status.',
        });
      }

      updates.paymentStatus = paymentStatus;
    }

    if (orderStatus !== undefined) {
      if (!allowedOrderStatuses.includes(orderStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid order status.',
        });
      }

      updates.orderStatus = orderStatus;
    }

    if (deliveryStatus !== undefined) {
      if (!allowedDeliveryStatuses.includes(deliveryStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid delivery status.',
        });
      }

      updates.deliveryStatus = deliveryStatus;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one status must be provided.',
      });
    }

    updates.updatedAt = new Date();

    const db = getDB();

    const result = await db.collection('orders').updateOne(
      { _id: new ObjectId(orderId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found.',
      });
    }

    const updatedOrder = await db.collection('orders').findOne({
      _id: new ObjectId(orderId),
    });

    res.status(200).json({
      success: true,
      message: 'Order status updated successfully.',
      order: updatedOrder,
    });

  } catch (error) {
    console.error('Update order status error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to update order status.',
    });
  }
}


module.exports = {
  createOrder,
  trackOrder,
  getAllOrders,
  updateOrderStatus,
};