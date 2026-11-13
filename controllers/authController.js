
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../config/database');

async function registerAdmin(req, res) {
  try {
    const db = getDB();

    const setupKey = req.headers['x-setup-key'];

    if (!process.env.ADMIN_SETUP_KEY ||
        setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({
        success: false,
        message: 'Invalid administrator setup key.',
      });
    }

    const adminCount = await db.collection('admins').countDocuments();

    if (adminCount > 0) {
      return res.status(403).json({
        success: false,
        message: 'Administrator registration is closed.',
      });
    }

    const { name, email, password } = req.body;

    if (
      typeof name !== 'string' ||
      !name.trim() ||
      typeof email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' ||
      password.length < 12
    ) {
      return res.status(400).json({
        success: false,
        message: 'Provide a valid name, email and password of at least 12 characters.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    await db.collection('admins').createIndex(
      { email: 1 },
      { unique: true }
    );

    const existingAdmin = await db.collection('admins').findOne({
      email: normalizedEmail,
    });

    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: 'An administrator with this email already exists.',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await db.collection('admins').insertOne({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: 'admin',
      createdAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Administrator account created successfully.',
      adminId: result.insertedId,
    });
  } catch (error) {
    console.error('Admin registration error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to create administrator account.',
    });
  }
}

async function loginAdmin(req, res) {
  try {
    const db = getDB();
    const { email, password } = req.body;

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    const admin = await db.collection('admins').findOne({
      email: email.trim().toLowerCase(),
    });

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      admin.password
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const token = jwt.sign(
      {
        id: admin._id.toString(),
        role: admin.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || '1d',
      }
    );

    res.status(200).json({
      success: true,
      message: 'Login successful.',
      token,
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
      },
    });
  } catch (error) {
    console.error('Admin login error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to log in.',
    });
  }
}

module.exports = {
  registerAdmin,
  loginAdmin,
};
