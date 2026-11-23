'use strict';
// MongoDB Connection and Data Access Layer
// Connects to MongoDB, falls back gracefully to local data files if MongoDB is unavailable.

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const DEFAULT_MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || 'stockout_predictor';

let client = null;
let db = null;
let isConnected = false;

async function connectToMongo(uri = DEFAULT_MONGO_URI) {
  if (client && isConnected) return db;

  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    db = client.db(DB_NAME);
    isConnected = true;
    console.log(`[MongoDB] Connected successfully to database: ${DB_NAME}`);
    return db;
  } catch (err) {
    console.warn(`[MongoDB] Connection failed: ${err.message}. Using local file fallback.`);
    isConnected = false;
    db = null;
    return null;
  }
}

function getDb() {
  return isConnected ? db : null;
}

function isMongoConnected() {
  return isConnected;
}

// Load products: Try MongoDB collection `products` first, fallback to JSON file
async function loadProductsData(dataPath) {
  if (isMongoConnected()) {
    try {
      const docs = await db.collection('products').find({}, { projection: { _id: 0 } }).toArray();
      if (docs && docs.length > 0) {
        console.log(`[Data] Loaded ${docs.length} products from MongoDB`);
        return docs;
      }
    } catch (err) {
      console.warn(`[MongoDB] Error reading products from DB: ${err.message}. Using fallback.`);
    }
  }

  // Fallback to local products.json
  const raw = fs.readFileSync(dataPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.products || parsed;
}

// Load history: Try MongoDB collection `weekly_history` first, fallback to CSV file
async function loadHistoryData(csvPath) {
  if (isMongoConnected()) {
    try {
      const count = await db.collection('weekly_history').countDocuments();
      if (count > 0) {
        console.log(`[Data] Loading history from MongoDB (${count} documents)...`);
        const cursor = db.collection('weekly_history').find({}, { projection: { _id: 0 } }).sort({ week: 1 });
        const byCode = new Map();

        await cursor.forEach((doc) => {
          const code = doc.code || doc.StockCode;
          if (!byCode.has(code)) byCode.set(code, []);
          byCode.get(code).push({
            week: typeof doc.week === 'number' ? doc.week : new Date(doc.week).getTime(),
            demand: Number(doc.demand || doc.Demand),
            unitPrice: Number(doc.unitPrice || doc.UnitPrice || 0),
          });
        });

        // Ensure sorted by week
        for (const rows of byCode.values()) {
          rows.sort((a, b) => a.week - b.week);
        }

        console.log(`[Data] Loaded history for ${byCode.size} products from MongoDB`);
        return byCode;
      }
    } catch (err) {
      console.warn(`[MongoDB] Error reading history from DB: ${err.message}. Using fallback.`);
    }
  }

  // Fallback to local CSV
  const { loadHistory } = require('./forecast');
  return loadHistory(csvPath);
}

// Load model: Try MongoDB collection `models` first, fallback to JSON file
async function loadModelData(jsonPath) {
  if (isMongoConnected()) {
    try {
      const doc = await db.collection('models').findOne({ active: true }, { projection: { _id: 0 } });
      if (doc && doc.trees) {
        console.log(`[Data] Loaded active model (${doc.trees.length} trees) from MongoDB`);
        return { features: doc.features, baseline: doc.baseline, trees: doc.trees };
      }
    } catch (err) {
      console.warn(`[MongoDB] Error reading model from DB: ${err.message}. Using fallback.`);
    }
  }

  // Fallback to local model_trees.json
  const { loadModel } = require('./forecast');
  return loadModel(jsonPath);
}

// Load metrics: Try MongoDB collection `metrics` first, fallback to JSON file
async function loadMetricsData(jsonPath) {
  if (isMongoConnected()) {
    try {
      const doc = await db.collection('metrics').findOne({}, { projection: { _id: 0 } });
      if (doc) {
        console.log(`[Data] Loaded metrics from MongoDB`);
        return doc;
      }
    } catch (err) {
      console.warn(`[MongoDB] Error reading metrics from DB: ${err.message}. Using fallback.`);
    }
  }

  // Fallback to local metrics.json
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  }
  return null;
}

// Helper to fetch history on demand for a single product directly from MongoDB
async function getProductHistory(code) {
  if (isMongoConnected()) {
    try {
      const docs = await db.collection('weekly_history')
        .find({ code })
        .sort({ week: 1 })
        .toArray();
      if (docs && docs.length > 0) {
        return docs.map(d => ({
          week: typeof d.week === 'number' ? d.week : new Date(d.week).getTime(),
          demand: Number(d.demand),
          unitPrice: Number(d.unitPrice || 0),
        }));
      }
    } catch (err) {
      console.warn(`[MongoDB] Error querying history for ${code}: ${err.message}`);
    }
  }
  return null;
}

module.exports = {
  connectToMongo,
  getDb,
  isMongoConnected,
  loadProductsData,
  loadHistoryData,
  loadModelData,
  loadMetricsData,
  getProductHistory,
};
