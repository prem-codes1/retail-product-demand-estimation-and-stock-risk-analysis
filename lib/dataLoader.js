'use strict';
// Unified Data Loader
// Priority:
// 1. Remote API (DATA_API_BASE_URL, e.g. https://jawline-clunky-perplexed.ngrok-free.dev)
// 2. MongoDB Database (MONGODB_URI)
// 3. Local data folder (fallback if exists)

const fs = require('fs');
const path = require('path');
const { isMongoConnected, getDb, getProductHistory: getMongoProductHistory } = require('./mongo');
const {
  fetchRemoteProducts,
  fetchRemoteModel,
  fetchRemoteMetrics,
  fetchRemoteHistory,
} = require('./remoteDataProvider');

async function loadProducts(localPath) {
  // 1. Try Remote ngrok endpoint
  try {
    const remote = await fetchRemoteProducts();
    if (remote && remote.length > 0) {
      console.log(`[Data] Loaded ${remote.length} products from remote API`);
      return remote;
    }
  } catch (err) {
    console.log(`[Data] Remote products endpoint not available (${err.message})`);
  }

  // 2. Try MongoDB
  if (isMongoConnected()) {
    try {
      const db = getDb();
      const docs = await db.collection('products').find({}, { projection: { _id: 0 } }).toArray();
      if (docs && docs.length > 0) {
        console.log(`[Data] Loaded ${docs.length} products from MongoDB`);
        return docs;
      }
    } catch (err) {
      console.warn(`[Data] MongoDB products query error: ${err.message}`);
    }
  }

  // 3. Local file fallback (if directory/file still present)
  if (localPath && fs.existsSync(localPath)) {
    const raw = fs.readFileSync(localPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.products || parsed;
  }

  return [];
}

async function loadModel(localPath) {
  // 1. Try Remote API
  try {
    const remote = await fetchRemoteModel();
    if (remote && remote.trees) {
      console.log(`[Data] Loaded model (${remote.trees.length} trees) from remote API`);
      return { features: remote.features, baseline: remote.baseline, trees: remote.trees };
    }
  } catch (err) {
    console.log(`[Data] Remote model endpoint not available (${err.message})`);
  }

  // 2. Try MongoDB
  if (isMongoConnected()) {
    try {
      const db = getDb();
      const doc = await db.collection('models').findOne({ active: true }, { projection: { _id: 0 } });
      if (doc && doc.trees) {
        console.log(`[Data] Loaded active model (${doc.trees.length} trees) from MongoDB`);
        return { features: doc.features, baseline: doc.baseline, trees: doc.trees };
      }
    } catch (err) {
      console.warn(`[Data] MongoDB model query error: ${err.message}`);
    }
  }

  // 3. Local fallback
  if (localPath && fs.existsSync(localPath)) {
    const { loadModel: loadLocalModel } = require('./forecast');
    return loadLocalModel(localPath);
  }

  throw new Error('No model source available (remote API, MongoDB, and local files all failed).');
}

async function loadMetrics(localPath) {
  // 1. Try Remote API
  try {
    const remote = await fetchRemoteMetrics();
    if (remote) {
      console.log(`[Data] Loaded metrics from remote API`);
      return remote;
    }
  } catch (err) {
    console.log(`[Data] Remote metrics endpoint not available (${err.message})`);
  }

  // 2. Try MongoDB
  if (isMongoConnected()) {
    try {
      const db = getDb();
      const doc = await db.collection('metrics').findOne({}, { projection: { _id: 0 } });
      if (doc) {
        console.log(`[Data] Loaded metrics from MongoDB`);
        return doc;
      }
    } catch (err) {
      console.warn(`[Data] MongoDB metrics error: ${err.message}`);
    }
  }

  // 3. Local fallback
  if (localPath && fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }

  return null;
}

async function loadHistory(localPath) {
  // 1. Try Remote API
  try {
    const remote = await fetchRemoteHistory();
    if (remote && (Array.isArray(remote) || typeof remote === 'object')) {
      const byCode = new Map();
      const entries = Array.isArray(remote) ? remote : Object.entries(remote);
      for (const item of entries) {
        const code = item.code || item[0];
        const rows = item.weeks || item.rows || item[1];
        if (code && Array.isArray(rows)) {
          byCode.set(code, rows.map(r => ({
            week: typeof r.week === 'number' ? r.week : new Date(r.week).getTime(),
            demand: Number(r.demand),
            unitPrice: Number(r.unitPrice || 0),
          })));
        }
      }
      if (byCode.size > 0) {
        console.log(`[Data] Loaded history for ${byCode.size} products from remote API`);
        return byCode;
      }
    }
  } catch (err) {
    console.log(`[Data] Remote history endpoint not available (${err.message})`);
  }

  // 2. Try MongoDB
  if (isMongoConnected()) {
    try {
      const db = getDb();
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

        for (const rows of byCode.values()) {
          rows.sort((a, b) => a.week - b.week);
        }

        console.log(`[Data] Loaded history for ${byCode.size} products from MongoDB`);
        return byCode;
      }
    } catch (err) {
      console.warn(`[Data] MongoDB history query error: ${err.message}`);
    }
  }

  // 3. Local fallback
  if (localPath && fs.existsSync(localPath)) {
    const { loadHistory: loadLocalHistory } = require('./forecast');
    return loadLocalHistory(localPath);
  }

  return new Map();
}

async function getProductHistory(code) {
  // 1. Try Remote API
  try {
    const remote = await fetchRemoteHistory(code);
    if (remote && remote.weeks && Array.isArray(remote.weeks)) {
      return remote.weeks.map(w => ({
        week: typeof w.week === 'number' ? w.week : new Date(w.week).getTime(),
        demand: Number(w.demand),
        unitPrice: Number(w.unitPrice || 0),
      }));
    }
  } catch (err) {
    // fallback to Mongo
  }

  // 2. Try MongoDB
  return getMongoProductHistory(code);
}

module.exports = {
  loadProducts,
  loadModel,
  loadMetrics,
  loadHistory,
  getProductHistory,
};
