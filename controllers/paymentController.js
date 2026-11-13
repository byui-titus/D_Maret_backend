
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

module.exports = {
  handleNowPaymentsIPN,
};
