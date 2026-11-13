
const express = require('express');
const router = express.Router();

const {
  registerAdmin,
  loginAdmin,
} = require('../controllers/authController');

const protectAdmin = require('../middleware/authMiddleware');

router.post('/setup', registerAdmin);
router.post('/login', loginAdmin);

router.get('/me', protectAdmin, (req, res) => {
  res.status(200).json({
    success: true,
    admin: req.admin,
  });
});

module.exports = router;

