
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

const allowedCategories = [
  'Software',
  'Apps',
  'APKs',
  'Gift Cards',
  'Gaming',
  'Other',
];

function validateProduct(data) {
  const errors = [];

  if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
    errors.push('Product name is required.');
  }

  if (!allowedCategories.includes(data.category)) {
    errors.push('A valid product category is required.');
  }

  if (!data.description || typeof data.description !== 'string' || !data.description.trim()) {
    errors.push('Product description is required.');
  }

  if (
    data.price === undefined ||
    typeof data.price !== 'number' ||
    !Number.isFinite(data.price) ||
    data.price < 0
  ) {
    errors.push('A valid product price is required.');
  }

  if (data.images !== undefined && !Array.isArray(data.images)) {
    errors.push('Images must be provided as an array.');
  }

  if (data.features !== undefined && !Array.isArray(data.features)) {
    errors.push('Features must be provided as an array.');
  }

  return errors;
}

// GET /api/products
async function getAllProducts(req, res) {
  try {
    const db = getDB();

    const {
      category,
      search,
      featured,
      page = 1,
      limit = 20,
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filter = {
      available: true,
    };

    if (category && category !== 'All Products') {
      filter.category = category;
    }

    if (search) {
      const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      filter.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { description: { $regex: safeSearch, $options: 'i' } },
      ];
    }

    if (featured === 'true') {
      filter.featured = true;
    }

    const productsCollection = db.collection('products');

    const [products, total] = await Promise.all([
      productsCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * limitNumber)
        .limit(limitNumber)
        .toArray(),

      productsCollection.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(total / limitNumber),
      products,
    });
  } catch (error) {
    console.error('Get products error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to retrieve products.',
    });
  }
}

// GET /api/products/:id
async function getProductById(req, res) {
  try {
    const db = getDB();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID.',
      });
    }

    const product = await db.collection('products').findOne({
      _id: new ObjectId(id),
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    res.status(200).json({
      success: true,
      product,
    });
  } catch (error) {
    console.error('Get product error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to retrieve product.',
    });
  }
}

// GET /api/products/admin/all
// Administrator-only: retrieve all products, including unavailable products.
async function getAdminProducts(req, res) {
  try {
    const db = getDB();

    const {
      search,
      page = 1,
      limit = 100,
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(100, Math.max(1, parseInt(limit, 10) || 100));

    const filter = {};

    if (search) {
      const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      filter.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { description: { $regex: safeSearch, $options: 'i' } },
      ];
    }

    const productsCollection = db.collection('products');

    const [products, total] = await Promise.all([
      productsCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * limitNumber)
        .limit(limitNumber)
        .toArray(),

      productsCollection.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(total / limitNumber),
      products,
    });
  } catch (error) {
    console.error('Get admin products error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to retrieve products.',
    });
  }
}

// POST /api/products
async function createProduct(req, res) {
  try {
    const db = getDB();
    const data = req.body;

    const errors = validateProduct(data);

    if (errors.length) {
      return res.status(400).json({
        success: false,
        errors,
      });
    }

    const now = new Date();

    const product = {
      name: data.name.trim(),
      category: data.category,
      description: data.description.trim(),
      price: data.price,
      images: data.images || [],
      features: data.features || [],
      badge: data.badge || '',
      featured: data.featured === true,
      available: data.available !== false,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('products').insertOne(product);

    res.status(201).json({
      success: true,
      message: 'Product created successfully.',
      product: {
        ...product,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    console.error('Create product error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to create product.',
    });
  }
}

// PUT /api/products/:id
async function updateProduct(req, res) {
  try {
    const db = getDB();
    const { id } = req.params;
    const data = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID.',
      });
    }

    const existingProduct = await db.collection('products').findOne({
      _id: new ObjectId(id),
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    const updatedData = {
      ...existingProduct,
      ...data,
    };

    const errors = validateProduct(updatedData);

    if (errors.length) {
      return res.status(400).json({
        success: false,
        errors,
      });
    }

    const allowedFields = [
      'name',
      'category',
      'description',
      'price',
      'images',
      'features',
      'badge',
      'featured',
      'available',
    ];

    const updateFields = {};

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updateFields[field] = data[field];
      }
    }

    if (typeof updateFields.name === 'string') {
      updateFields.name = updateFields.name.trim();
    }

    if (typeof updateFields.description === 'string') {
      updateFields.description = updateFields.description.trim();
    }

    updateFields.updatedAt = new Date();

    await db.collection('products').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    const updatedProduct = await db.collection('products').findOne({
      _id: new ObjectId(id),
    });

    res.status(200).json({
      success: true,
      message: 'Product updated successfully.',
      product: updatedProduct,
    });
  } catch (error) {
    console.error('Update product error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to update product.',
    });
  }
}

// DELETE /api/products/:id
async function deleteProduct(req, res) {
  try {
    const db = getDB();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID.',
      });
    }

    const result = await db.collection('products').deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully.',
    });
  } catch (error) {
    console.error('Delete product error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Unable to delete product.',
    });
  }
}

module.exports = {
  getAllProducts,
  getAdminProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
