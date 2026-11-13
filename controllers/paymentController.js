
const crypto = require('crypto');
const { getDB } = require('../config/database');

function getNowPaymentsConfig() {
  const mode = (process.env.NOWPAYMENTS_MODE || 'live').toLowerCase();

  if (mode === 'sandbox') {
    return {
      mode: 'sandbox',
      apiKey: process.env.NOWPAYMENTS_SANDBOX_API_KEY,
      ipnSecret: process.env.NOWPAYMENTS_SANDBOX_IPN_SECRET,
      baseUrl: 'https://api.sandbox.nowpayments.io/v1',
    };
  }

  if (mode === 'live') {
    return {
      mode: 'live',
      apiKey: process.env.NOWPAYMENTS_API_KEY,
      ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
      baseUrl: 'https://api.nowpayments.io/v1',
    };
  }

  throw new Error('Invalid NOWPAYMENTS_MODE. Use live or sandbox.');
}

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
function verifyNowPaymentsSignature(payload, receivedSignature, secret)  {
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

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification payload.',
      });
    }

    const config = getNowPaymentsConfig();

if (!config.ipnSecret) {
      console.error('NOWPayments IPN secret is not configured.');

      return res.status(500).json({
        success: false,
        message: 'Payment notification configuration is incomplete.',
      });
    }

    if (!verifyNowPaymentsSignature(payload, signature, config.ipnSecret)) {
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
      !payment_id ||
      !payment_status ||
      price_amount === undefined ||
      !price_currency
    ) {
      return res.status(400).json({
        success: false,
        message: 'Required payment information is missing.',
      });
    }

    const allowedStatuses = [
      'waiting',
      'confirming',
      'confirmed',
      'sending',
      'partially_paid',
      'finished',
      'failed',
      'expired',
      'refunded',
    ];

    if (!allowedStatuses.includes(payment_status)) {
      return res.status(400).json({
        success: false,
        message: 'Unknown payment status.',
      });
    }

    const db = getDB();
    const orders = db.collection('orders');

    const order = await orders.findOne({
      orderNumber: String(order_id),
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Matching order was not found.',
      });
    }

    const savedPayment = order.payment || {};

    // The order must have an invoice created by our backend.
    if (
      savedPayment.provider !== 'nowpayments' ||
      !savedPayment.invoiceId
    ) {
      return res.status(400).json({
        success: false,
        message: 'No matching payment invoice exists for this order.',
      });
    }

    // If NOWPayments includes invoice_id, verify it.
    // Some payment notifications may identify the order
    // through order_id without including invoice_id.
    if (
      invoice_id &&
      String(invoice_id) !== String(savedPayment.invoiceId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invoice reference does not match this order.',
      });
    }

    // Do not allow a different payment ID to replace
    // the payment already associated with this order.
    if (
      savedPayment.paymentId &&
      String(savedPayment.paymentId) !== String(payment_id)
    ) {
      return res.status(409).json({
        success: false,
        message: 'A different payment is already associated with this order.',
      });
    }

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

    // Do not let an older notification downgrade a completed payment.
    if (
      order.paymentStatus === 'confirmed' &&
      payment_status !== 'refunded'
    ) {
      return res.status(200).json({
        success: true,
        message: 'Order payment is already confirmed.',
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

    // Atomically associate the first payment ID with this order.
    const updateResult = await orders.updateOne(
      {
        _id: order._id,
        'payment.provider': 'nowpayments',
        'payment.invoiceId': savedPayment.invoiceId,
        $or: [
          { 'payment.paymentId': { $exists: false } },
          { 'payment.paymentId': null },
          { 'payment.paymentId': String(payment_id) },
        ],
      },
      {
        $set: updates,
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(409).json({
        success: false,
        message: 'Payment could not be matched safely to this order.',
      });
    }

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

    const config = getNowPaymentsConfig();
     const apiKey = config.apiKey;
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
  order.payment?.invoiceUrl &&
  (order.payment.environment || 'live') === config.mode
) {
  return res.status(200).json({
    success: true,
    invoiceUrl: order.payment.invoiceUrl,
    invoiceId: order.payment.invoiceId,
    message: 'Existing payment invoice retrieved.',
  });
}

    const invoiceResponse = await fetch(
     `${config.baseUrl}/invoice`,
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
            environment: config.mode,
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

