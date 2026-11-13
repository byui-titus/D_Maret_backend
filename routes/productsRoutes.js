const express = require('express');
const router = express.Router();

const productController = require('../controllers/productControllers');
const protectAdmin = require('../middleware/authMiddleware');

// Public routes
router.get('/', productController.getAllProducts);

// Administrator-only product listing
router.get('/admin/all', protectAdmin, productController.getAdminProducts);

router.get('/:id', productController.getProductById);

// Administrator-only product changes
router.post('/', protectAdmin, productController.createProduct);
router.put('/:id', protectAdmin, productController.updateProduct);
router.delete('/:id', protectAdmin, productController.deleteProduct);

module.exports = router;