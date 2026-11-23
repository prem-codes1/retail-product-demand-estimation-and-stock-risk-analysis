'use strict';
// Script to import local files from ./data into MongoDB
// Run with: node scripts/importToMongo.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || 'stockout_predictor';
const DATA_DIR = path.join(__dirname, '..', 'data');

async function importData() {
  console.log(`Connecting to MongoDB at ${MONGO_URI}...`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(`Connected to database: ${DB_NAME}\n`);

  // 1. Import Products
  const productsPath = path.join(DATA_DIR, 'products.json');
  if (fs.existsSync(productsPath)) {
    console.log('Importing products...');
    const raw = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
    const products = raw.products || raw;
    const col = db.collection('products');
    await col.deleteMany({});
    if (products.length > 0) {
      await col.insertMany(products);
      await col.createIndex({ code: 1 }, { unique: true });
      await col.createIndex({ name: 'text' });
    }
    console.log(`✓ Imported ${products.length} products with indexes (code, text: name).\n`);
  }

  // 2. Import Metrics
  const metricsPath = path.join(DATA_DIR, 'metrics.json');
  if (fs.existsSync(metricsPath)) {
    console.log('Importing metrics...');
    const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    const col = db.collection('metrics');
    await col.deleteMany({});
    await col.insertOne({ ...metrics, importedAt: new Date() });
    console.log('✓ Imported model metrics.\n');
  }

  // 3. Import Model Trees
  const modelPath = path.join(DATA_DIR, 'model_trees.json');
  if (fs.existsSync(modelPath)) {
    console.log('Importing model trees...');
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const col = db.collection('models');
    await col.deleteMany({});
    await col.insertOne({
      name: 'demand_gbdt_trees',
      features: model.features,
      baseline: model.baseline,
      trees: model.trees,
      active: true,
      importedAt: new Date(),
    });
    console.log(`✓ Imported model with ${model.trees.length} trees.\n`);
  }

  // 4. Import Weekly History in streaming batches
  const historyPath = path.join(DATA_DIR, 'weekly_history.csv');
  if (fs.existsSync(historyPath)) {
    console.log('Importing weekly history (streaming 205k+ rows)...');
    const col = db.collection('weekly_history');
    await col.deleteMany({});

    const fileStream = fs.createReadStream(historyPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let iCode = 0, iWeek = 1, iDemand = 2, iPrice = 3;
    let batch = [];
    const BATCH_SIZE = 5000;
    let totalImported = 0;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isHeader) {
        const header = trimmed.split(',').map(s => s.trim());
        iCode = header.indexOf('StockCode');
        iWeek = header.indexOf('Week');
        iDemand = header.indexOf('Demand');
        iPrice = header.indexOf('UnitPrice');
        isHeader = false;
        continue;
      }

      const parts = trimmed.split(',');
      batch.push({
        code: parts[iCode].trim(),
        week: new Date(parts[iWeek].trim() + 'T00:00:00Z'),
        demand: Number(parts[iDemand]),
        unitPrice: Number(parts[iPrice] || 0),
      });

      if (batch.length >= BATCH_SIZE) {
        await col.insertMany(batch);
        totalImported += batch.length;
        process.stdout.write(`\rImported ${totalImported} weekly records...`);
        batch = [];
      }
    }

    if (batch.length > 0) {
      await col.insertMany(batch);
      totalImported += batch.length;
      process.stdout.write(`\rImported ${totalImported} weekly records...\n`);
    }

    console.log('Creating indexes on weekly_history...');
    await col.createIndex({ code: 1, week: 1 });
    console.log(`✓ Completed history import: ${totalImported} documents indexed by code and week.\n`);
  }

  console.log('All data imported into MongoDB successfully!');
  await client.close();
}

importData().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
