
const crypto = require('crypto');
const { getDB } = require('../config/database');

// Sort object keys recursively as required by NOWPayments.
function sortObjectDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectDeep);
  }

  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortObjectDeep(value[key]);
        return result;
      }, {});
  }

  return value;
}

// Verify the NOWPayments IPN signature.
function verifyNowPaymentsSignature(payload, receivedSignature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;

  if (!secret || !receivedSignature) {
    return false;
  }

  const sortedPayload = sortObjectDeep(payload);
  const payloadString = JSON.stringify(sortedPayload);

  const expectedSignature = crypto
    .createHmac('sha512', secret)
    .update(payloadString)
    .digest('hex');

  const received = Buffer.from(receivedSignature, 'hex');
  const expected = Buffer.from(expectedSignature, 'hex');

  if (
    received.length !== expected.length ||
    received.length === 0
  ) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

// POST /api/payments/nowpayments/ipn
async function handleNowPaymentsIPN(req, res) {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const payload = req.body;

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification payload.',
      });
    }

    if (!process.env.NOWPAYMENTS_IPN_SECRET) {
      console.error('NOWPayments IPN secret is not configured.');

      return res.status(500).json({
        success: false,
        message: 'Payment notification configuration is incomplete.',
      });
    }

    if (!verifyNowPaymentsSignature(payload, signature)) {
      console.error('NOWPayments IPN signature verification failed.');

      return res.status(401).json({
        success: false,
        message: 'Invalid notification signature.',
      });
    }

    const {
      payment_id,
      invoice_id,
      order_id,
      payment_status,
      price_amount,
      price_currency,
      pay_currency,
      actually_paid,
    } = payload;

    if (
      !order_id ||
      !payment_status ||
      !payment_id ||
      !price_amount ||
      !price_currency
    ) {
      return res.status(400).json({
        success: false,
        message: 'Required payment information is missing.',
      });
    }

    const db = getDB();

    const order = await db.collection('orders').findOne({
      orderNumber: String(order_id),
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Matching order was not found.',
      });
    }

    // Ensure this notification belongs to an invoice
    // created for this order through NOWPayments.
    const savedPayment = order.payment || {};

    const matchingInvoice =
      invoice_id &&
      savedPayment.invoiceId &&
      String(invoice_id) === String(savedPayment.invoiceId);

    const matchingPayment =
      savedPayment.paymentId &&
      String(payment_id) === String(savedPayment.paymentId);

    if (
      savedPayment.provider !== 'nowpayments' ||
      (!matchingInvoice && !matchingPayment)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment does not match this order.',
      });
    }

    // Confirm that the fiat order amount and currency match.
    const expectedAmount = Math.round(
      Number(order.totalAmount) * 100
    );

    const receivedAmount = Math.round(
      Number(price_amount) * 100
    );

    if (
      !Number.isFinite(receivedAmount) ||
      receivedAmount !== expectedAmount ||
      String(price_currency).toLowerCase() !==
        String(order.currency).toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount or currency does not match the order.',
      });
    }

    const updates = {
      'payment.gatewayPaymentStatus': payment_status,
      'payment.paymentId': String(payment_id),
      'payment.payCurrency': pay_currency || null,
      'payment.actuallyPaid': Number(actually_paid) || 0,
      'payment.lastNotificationAt': new Date(),
      updatedAt: new Date(),
    };

    // Only mark an order paid when NOWPayments reports
    // that the payment is finished.
    if (payment_status === 'finished') {
      updates.paymentStatus = 'confirmed';

      if (order.orderStatus === 'awaiting_payment') {
        updates.orderStatus = 'processing';
      }
    } else if (
      ['failed', 'expired'].includes(payment_status)
    ) {
      updates.paymentStatus = 'failed';
    } else if (payment_status === 'refunded') {
      updates.paymentStatus = 'refunded';
    }

    await db.collection('orders').updateOne(
      { _id: order._id },
      { $set: updates }
    );

    console.log(
      `NOWPayments notification processed for ${order.orderNumber}: ${payment_status}`
    );

    return res.status(200).json({
      success: true,
      message: 'Payment notification received.',
    });

  } catch (error) {
    console.error('NOWPayments IPN error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to process payment notification.',
    });
  }
}


async function createNowPaymentsInvoice(req, res) {
  try {
    const { orderNumber, customerEmail } = req.body;

    const email = String(customerEmail || '').trim().toLowerCase();

    if (!orderNumber || !email) {
      return res.status(400).json({
        success: false,
        message: 'Order reference and customer email are required.',
      });
    }

    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    const callbackUrl =
      'https://d-maret-backend.onrender.com/api/payments/nowpayments/ipn';

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: 'Payment gateway is not configured.',
      });
    }

    const db = getDB();

    const orders = db.collection('orders');

    const order = await orders.findOne({
      orderNumber: String(orderNumber).trim(),
      'customer.email': email,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found.',
      });
    }

    if (
      order.paymentStatus !== 'pending' ||
      order.orderStatus !== 'awaiting_payment'
    ) {
      return res.status(400).json({
        success: false,
        message: 'This order is not awaiting payment.',
      });
    }

    // Reuse an existing invoice rather than creating duplicates.
    if (
      order.payment?.provider === 'nowpayments' &&
      order.payment?.invoiceUrl
    ) {
      return res.status(200).json({
        success: true,
        invoiceUrl: order.payment.invoiceUrl,
        invoiceId: order.payment.invoiceId,
        message: 'Existing payment invoice retrieved.',
      });
    }

    const invoiceResponse = await fetch(
      'https://api.nowpayments.io/v1/invoice',
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          price_amount: Number(order.totalAmount),
          price_currency: 'usd',
          order_id: order.orderNumber,
          order_description: `DigitalMarket order ${order.orderNumber}: ${order.product.name}`,
          ipn_callback_url: callbackUrl,
        }),
      }
    );

    const invoiceData = await invoiceResponse.json();

    if (
      !invoiceResponse.ok ||
      !invoiceData.id ||
      !invoiceData.invoice_url
    ) {
      console.error('NOWPayments invoice error:', invoiceData);

      return res.status(502).json({
        success: false,
        message: 'Unable to create a payment invoice. Please try again.',
      });
    }

    await orders.updateOne(
      {
        _id: order._id,
        paymentStatus: 'pending',
        'payment.invoiceId': { $exists: false },
      },
      {
        $set: {
          payment: {
            provider: 'nowpayments',
            invoiceId: String(invoiceData.id),
            invoiceUrl: invoiceData.invoice_url,
            gatewayPaymentStatus: 'waiting',
            createdAt: new Date(),
          },
          updatedAt: new Date(),
        },
      }
    );

    const savedOrder = await orders.findOne({ _id: order._id });

    if (
      !savedOrder.payment ||
      String(savedOrder.payment.invoiceId) !== String(invoiceData.id)
    ) {
      return res.status(409).json({
        success: false,
        message: 'A payment invoice may already exist for this order. Please retry.',
      });
    }

    return res.status(201).json({
      success: true,
      invoiceId: String(invoiceData.id),
      invoiceUrl: invoiceData.invoice_url,
      message: 'Payment invoice created successfully.',
    });

  } catch (error) {
    console.error('Create NOWPayments invoice error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to create payment invoice.',
    });
  }
}

module.exports = {
  handleNowPaymentsIPN,
  createNowPaymentsInvoice,
};

