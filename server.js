'use strict';
// Load environment variables from .env file
require('dotenv').config();
// Node.js + Express server.
//   GET  /                   -> the web page (public/index.html)
//   GET  /products?q=text    -> product matches for the search box
//   POST /predict            -> prediction for one product (name or code)
//   GET  /forecasts          -> next-week forecast for every product (for the dashboard)
//   GET  /history/:code      -> past 54 weeks of one product + its forecast
//   GET  /metrics            -> model accuracy and data summary
//   GET  /health             -> quick "is the server alive?" check
//   GET  /db/status          -> MongoDB connection and collection status

const fs = require('fs');
const path = require('path');
const express = require('express');
const { forecastStockout, buildFeatures, isoWeek } = require('./lib/forecast');
const { buildIndex, searchProducts, resolveProduct } = require('./lib/products');
const { createStockProvider } = require('./lib/stockProvider');
const { getGeminiService } = require('./lib/gemini');
const {
  loadProducts,
  loadModel,
  loadMetrics,
  loadHistory,
  getProductHistory,
} = require('./lib/dataLoader');
const { connectToMongo, isMongoConnected, getDb } = require('./lib/mongo');
const { REMOTE_DATA_BASE_URL } = require('./lib/remoteDataProvider');

const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = path.join(__dirname, 'data');

async function startServer() {
  // Connect to MongoDB (with automatic fallback to local files if unavailable)
  await connectToMongo(process.env.MONGODB_URI);

  // Load datasets: Remote ngrok API -> MongoDB -> Local fallback
  const model = await loadModel(path.join(DATA_DIR, 'model_trees.json'));
  const history = await loadHistory(path.join(DATA_DIR, 'weekly_history.csv'));
  const products = await loadProducts(path.join(DATA_DIR, 'products.json'));
  const productIndex = buildIndex(products);
  const nameByCode = new Map(products.map((p) => [p.code, p.name]));
  const metrics = await loadMetrics(path.join(DATA_DIR, 'metrics.json'));

  // Forecast for every product, calculated once and reused
  let forecastCache = null;
  function allForecasts() {
    if (!forecastCache) {
      forecastCache = [];
      for (const code of history.keys()) {
        const r = forecastStockout({ history, model, stockCode: code, currentStock: 0 });
        if (r.ok) {
          forecastCache.push({
            code,
            name: nameByCode.get(code) || null,
            predicted_demand: r.data.predicted_demand,
            next_week: r.data.next_week,
          });
        }
      }
      forecastCache.sort((a, b) => b.predicted_demand - a.predicted_demand);
    }
    return forecastCache;
  }
  const baseForecasts = allForecasts(); // calculate now so the first page load is fast

  // Initialize stock provider (mock by default, configurable via STOCK_PROVIDER env var)
  const stockProvider = createStockProvider(
    process.env.STOCK_PROVIDER,
    { rest: { baseUrl: process.env.WMS_BASE_URL, apiKey: process.env.WMS_API_KEY } },
    history,
    baseForecasts
  );
  console.log(`Stock provider: ${process.env.STOCK_PROVIDER || 'mock'}`);

  // Initialize Gemini service for AI explanations
  const geminiService = getGeminiService({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    rateLimit: Number(process.env.GEMINI_RATE_LIMIT),
  });
  console.log(`Gemini AI: ${geminiService.isConfigured() ? 'configured' : 'not configured (fallback mode)'}`);

  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/products', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ products: searchProducts(productIndex, query, 10) });
  });

  app.get('/forecasts', async (req, res) => {
    const forecasts = allForecasts();
    // Fetch live stock for all products
    const codes = forecasts.map(f => f.code);
    let liveStock = new Map();
    try {
      liveStock = await stockProvider.getStockLevels(codes);
    } catch (error) {
      console.warn('Failed to fetch live stock:', error.message);
    }
    const enriched = forecasts.map(f => ({
      ...f,
      live_stock: liveStock.has(f.code) ? liveStock.get(f.code) : null,
      stock_source: liveStock.has(f.code) ? 'live' : 'none'
    }));
    res.json({ forecasts: enriched });
  });

  app.get('/history/:code', async (req, res) => {
    const typed = req.params.code.trim();
    const code = history.has(typed) ? typed : typed.toUpperCase();
    
    // Check if we have history in memory or directly query MongoDB
    let rows = history.get(code);
    if (!rows && isMongoConnected()) {
      rows = await getProductHistory(code);
    }

    if (!rows) {
      return res.status(404).json({ error: `No history for product "${typed}".` });
    }

    const forecast = forecastStockout({ history, model, stockCode: code, currentStock: 0 });
    return res.json({
      code,
      name: nameByCode.get(code) || null,
      weeks: rows.map((r) => ({
        week: new Date(r.week).toISOString().slice(0, 10),
        demand: r.demand,
        unit_price: r.unitPrice,
      })),
      forecast: forecast.ok
        ? { next_week: forecast.data.next_week, predicted_demand: forecast.data.predicted_demand }
        : null,
    });
  });

  app.get('/metrics', (req, res) => {
    if (!metrics) return res.status(404).json({ error: 'metrics not found.' });
    return res.json(metrics);
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      products: history.size,
      mongoConnected: isMongoConnected(),
      remoteApiUrl: REMOTE_DATA_BASE_URL,
    });
  });

  // DB status endpoint
  app.get('/db/status', async (req, res) => {
    if (!isMongoConnected()) {
      return res.json({
        connected: false,
        source: 'local_files',
        message: 'MongoDB not connected, operating with local fallback files.',
      });
    }

    try {
      const db = getDb();
      const [productsCount, historyCount, modelsCount, metricsCount] = await Promise.all([
        db.collection('products').countDocuments(),
        db.collection('weekly_history').countDocuments(),
        db.collection('models').countDocuments(),
        db.collection('metrics').countDocuments(),
      ]);

      res.json({
        connected: true,
        source: 'mongodb',
        database: db.databaseName,
        collections: {
          products: productsCount,
          weekly_history: historyCount,
          models: modelsCount,
          metrics: metricsCount,
        },
      });
    } catch (err) {
      res.status(500).json({ connected: false, error: err.message });
    }
  });

  // Stock endpoints
  app.get('/stock/health', async (req, res) => {
    const health = await stockProvider.healthCheck();
    res.json(health);
  });

  app.get('/stock/bulk', async (req, res) => {
    let codes;
    if (req.query.codes) {
      codes = req.query.codes.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    } else {
      codes = Array.from(history.keys());
    }
    try {
      const stockMap = await stockProvider.getStockLevels(codes);
      const stock = {};
      for (const [code, qty] of stockMap) {
        stock[code] = qty;
      }
      res.json({ stock, source: 'live', count: Object.keys(stock).length });
    } catch (error) {
      console.error('Bulk stock fetch error:', error);
      res.status(502).json({ error: 'Failed to fetch stock from provider', detail: error.message });
    }
  });

  app.get('/stock/:code', async (req, res) => {
    const code = req.params.code.trim().toUpperCase();
    if (!history.has(code)) {
      return res.status(404).json({ error: `No such product: ${code}` });
    }
    try {
      const qty = await stockProvider.getStockLevel(code);
      res.json({ code, stock: qty, source: 'live' });
    } catch (error) {
      console.error('Stock fetch error:', error);
      res.status(502).json({ error: 'Failed to fetch stock from provider', detail: error.message });
    }
  });

  // Gemini AI endpoints
  app.get('/gemini/health', async (req, res) => {
    const health = await geminiService.healthCheck();
    res.json(health);
  });

  app.post('/explain', async (req, res) => {
    const body = req.body || {};
    const { product, forecast, features, history: historyData } = body;

    // Validate required fields
    if (!product || !forecast || !features || !historyData) {
      return res.status(400).json({
        error: 'Missing required fields: product, forecast, features, history',
      });
    }

    // Resolve product to get name and code
    const resolved = resolveProduct(productIndex, new Set(history.keys()), product);
    if (resolved.status !== 'found') {
      return res.status(404).json({ error: `Product not found: ${product}` });
    }

    const productName = nameByCode.get(resolved.code) || resolved.code;
    const currentStock = forecast.current_stock ?? 0;
    const risk = forecast.risk || 'UNKNOWN';
    const nextWeek = forecast.next_week || 'unknown';

    // Build explanation data
    const explanationData = {
      productName,
      code: resolved.code,
      predictedDemand: forecast.predicted_demand,
      currentStock,
      risk,
      features,
      history: historyData,
      nextWeek,
    };

    try {
      const explanation = await geminiService.generateExplanation(explanationData);
      res.json({ explanation });
    } catch (error) {
      console.error('Explanation generation error:', error);
      res.status(500).json({ error: 'Failed to generate explanation', detail: error.message });
    }
  });

  app.post('/predict', async (req, res) => {
    const body = req.body || {};

    // The product can be typed as a code or a name. "stock_code" is still accepted.
    const rawProduct = body.product ?? body.stock_code;
    const productText = typeof rawProduct === 'string' || typeof rawProduct === 'number'
      ? String(rawProduct).trim()
      : '';

    // current_stock is now OPTIONAL - if not provided, fetch from stock provider
    const hasExplicitStock = typeof body.current_stock === 'number' || typeof body.current_stock === 'string';
    let currentStock = hasExplicitStock ? Number(body.current_stock) : NaN;
    let stockSource = 'manual';

    if (!productText) {
      return res.status(400).json({ error: 'Please enter a product name or code.' });
    }

    const resolved = resolveProduct(productIndex, new Set(history.keys()), productText);
    if (resolved.status === 'not_found') {
      return res.status(404).json({ error: `No product matches "${productText}".` });
    }
    if (resolved.status === 'ambiguous') {
      return res.status(409).json({
        error: 'More than one product matches. Please pick one.',
        matches: resolved.matches,
      });
    }

    // Auto-fetch stock if not explicitly provided
    if (!hasExplicitStock || !Number.isFinite(currentStock) || currentStock < 0) {
      try {
        currentStock = await stockProvider.getStockLevel(resolved.code);
        stockSource = 'live';
      } catch (error) {
        console.warn('Failed to fetch live stock, defaulting to 0:', error.message);
        currentStock = 0;
        stockSource = 'fallback';
      }
    }

    const result = forecastStockout({ history, model, stockCode: resolved.code, currentStock });
    if (!result.ok) {
      return res.status(404).json({ error: result.error });
    }
    return res.json({ ...result.data, product_name: nameByCode.get(resolved.code) || null, stock_source: stockSource });
  });

  // Send JSON errors (for example, when the request body is not valid JSON)
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'The request body is not valid JSON.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  app.listen(PORT, () => {
    console.log(`Stockout risk server running at http://localhost:${PORT}`);
    console.log(`Loaded ${history.size} products. Press Ctrl+C to stop.`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
