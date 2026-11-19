'use strict';
// Stock Provider abstraction for live warehouse stock data.
// Supports: mock (demo), REST API (WMS/ERP), and future database providers.

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 60000;

// Simple in-memory cache with TTL
class Cache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear() {
    this.store.clear();
  }
}

// Base provider class
class StockProvider {
  async getStockLevels(codes) {
    throw new Error('getStockLevels not implemented');
  }

  async getStockLevel(code) {
    throw new Error('getStockLevel not implemented');
  }

  async healthCheck() {
    return { ok: false, error: 'Not implemented' };
  }
}

// Mock provider: generates realistic stock levels based on forecasts
// Useful for demos, testing, and development without external dependencies
class MockStockProvider extends StockProvider {
  constructor(history, forecasts) {
    super();
    this.history = history;
    this.forecasts = forecasts;
    // Build a lookup for quick forecast access
    this.forecastMap = new Map(forecasts.map(f => [f.code, f.predicted_demand]));
  }

  // Generate stock level for a single product
  // Strategy: forecast * multiplier (0.3 to 2.5) with some randomness
  // This creates a mix of HIGH/MEDIUM/LOW risk scenarios
  _generateStock(code, forecast) {
    if (!forecast || forecast <= 0) return 0;

    // Deterministic pseudo-random based on product code for consistency
    let hash = 0;
    for (let i = 0; i < code.length; i++) {
      hash = ((hash << 5) - hash) + code.charCodeAt(i);
      hash |= 0;
    }
    const seededRandom = Math.abs(Math.sin(hash) * 10000) % 1000 / 1000; // 0-1

    // Bias toward interesting scenarios:
    // ~15% HIGH risk (stock < forecast)
    // ~25% MEDIUM risk (stock < 1.5 * forecast)
    // ~60% LOW risk
    let multiplier;
    if (seededRandom < 0.15) {
      multiplier = 0.3 + seededRandom * 0.7; // 0.3 - 1.0
    } else if (seededRandom < 0.40) {
      multiplier = 1.0 + (seededRandom - 0.15) / 0.25 * 0.5; // 1.0 - 1.5
    } else {
      multiplier = 1.5 + (seededRandom - 0.40) / 0.60 * 1.0; // 1.5 - 2.5
    }

    return Math.round(forecast * multiplier);
  }

  async getStockLevels(codes) {
    const result = new Map();
    for (const code of codes) {
      const forecast = this.forecastMap.get(code) || 0;
      result.set(code, this._generateStock(code, forecast));
    }
    return result;
  }

  async getStockLevel(code) {
    const forecast = this.forecastMap.get(code) || 0;
    return this._generateStock(code, forecast);
  }

  async healthCheck() {
    return { ok: true, latencyMs: 1, provider: 'mock' };
  }
}

// REST API provider: calls external WMS/ERP API
class RestStockProvider extends StockProvider {
  constructor(config = {}) {
    super();
    this.baseUrl = config.baseUrl || process.env.WMS_BASE_URL;
    this.apiKey = config.apiKey || process.env.WMS_API_KEY;
    this.timeoutMs = config.timeoutMs || Number(process.env.WMS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.cache = new Cache(config.cacheTtlMs || Number(process.env.WMS_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS);

    if (!this.baseUrl) {
      console.warn('[RestStockProvider] WMS_BASE_URL not configured');
    }
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async _fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Bulk endpoint: POST /stock/bulk with { codes: [...] }
  // Expected response: { stock: { "CODE1": 100, "CODE2": 50 } }
  async getStockLevels(codes) {
    const cacheKey = `bulk:${codes.sort().join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!this.baseUrl) {
      throw new Error('WMS_BASE_URL not configured');
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/stock/bulk`;
    const response = await this._fetchWithTimeout(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ codes })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`WMS API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const stockMap = new Map();

    // Support multiple response formats
    if (data.stock && typeof data.stock === 'object') {
      for (const [code, qty] of Object.entries(data.stock)) {
        stockMap.set(code.toUpperCase(), Number(qty) || 0);
      }
    } else if (Array.isArray(data)) {
      for (const item of data) {
        if (item.code && typeof item.qty === 'number') {
          stockMap.set(item.code.toUpperCase(), item.qty);
        }
      }
    }

    this.cache.set(cacheKey, stockMap);
    return stockMap;
  }

  // Single endpoint: GET /stock/{code}
  // Expected response: { code: "CODE1", qty: 100 } or { stock: 100 }
  async getStockLevel(code) {
    const cacheKey = `single:${code.toUpperCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== null) return cached;

    if (!this.baseUrl) {
      throw new Error('WMS_BASE_URL not configured');
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/stock/${encodeURIComponent(code.toUpperCase())}`;
    const response = await this._fetchWithTimeout(url, {
      method: 'GET',
      headers: this._headers()
    });

    if (!response.ok) {
      if (response.status === 404) return 0;
      const text = await response.text().catch(() => '');
      throw new Error(`WMS API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    let qty = 0;
    if (typeof data.qty === 'number') qty = data.qty;
    else if (typeof data.stock === 'number') qty = data.stock;
    else if (typeof data.quantity === 'number') qty = data.quantity;

    this.cache.set(cacheKey, qty);
    return qty;
  }

  async healthCheck() {
    if (!this.baseUrl) {
      return { ok: false, error: 'WMS_BASE_URL not configured', provider: 'rest' };
    }

    const start = Date.now();
    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/health`;
      const response = await this._fetchWithTimeout(url, { method: 'GET', headers: this._headers() });
      const latencyMs = Date.now() - start;
      return { ok: response.ok, latencyMs, provider: 'rest', status: response.status };
    } catch (error) {
      return { ok: false, error: error.message, latencyMs: Date.now() - start, provider: 'rest' };
    }
  }

  clearCache() {
    this.cache.clear();
  }
}

// Factory function to create the appropriate provider
function createStockProvider(type, config, history, forecasts) {
  const providerType = (type || process.env.STOCK_PROVIDER || 'mock').toLowerCase();

  switch (providerType) {
    case 'rest':
      return new RestStockProvider(config.rest || {});
    case 'database':
      throw new Error('Database provider not yet implemented. Use "mock" or "rest".');
    case 'mock':
    default:
      return new MockStockProvider(history, forecasts);
  }
}

module.exports = {
  StockProvider,
  MockStockProvider,
  RestStockProvider,
  createStockProvider,
  Cache
};