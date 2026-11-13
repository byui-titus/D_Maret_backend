const { MongoClient } = require('mongodb');

let client;
let database;

async function connectDB() {
  try {
    client = new MongoClient(process.env.MONGODB_URI);

    await client.connect();

    database = client.db(process.env.DB_NAME);

    console.log('MongoDB connected successfully');

    return database;
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
}

function getDB() {
  if (!database) {
    throw new Error('Database has not been initialized');
  }

  return database;
}

module.exports = {
  connectDB,
  getDB,
};