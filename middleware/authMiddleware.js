
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

async function protectAdmin(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const token = authorization.split(' ')[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'admin' || !ObjectId.isValid(decoded.id)) {
      return res.status(403).json({
        success: false,
        message: 'Administrator access required.',
      });
    }

    const admin = await getDB().collection('admins').findOne({
      _id: new ObjectId(decoded.id),
    });

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Administrator account no longer exists.',
      });
    }

    req.admin = {
      id: admin._id,
      name: admin.name,
      email: admin.email,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication token.',
    });
  }
}

module.exports = protectAdmin;
