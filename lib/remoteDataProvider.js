'use strict';
// Remote Data Provider
// Fetches data (products, history, metrics, model) from an external service / remote ngrok endpoint.
// Designed to eliminate reliance on local ./data directory.

const REMOTE_DATA_BASE_URL = process.env.DATA_API_BASE_URL || 'https://jawline-clunky-perplexed.ngrok-free.dev';

async function fetchRemoteJson(endpoint) {
  const url = `${REMOTE_DATA_BASE_URL.replace(/\/$/, '')}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'ngrok-skip-browser-warning': 'true',
      'User-Agent': 'StockoutPredictor-Client',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Remote API returned HTTP ${response.status} for ${endpoint}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(`Expected JSON but got ${contentType}. Body preview: ${text.slice(0, 100)}`);
  }

  return response.json();
}

// Fetch products list: GET /products
async function fetchRemoteProducts() {
  const data = await fetchRemoteJson('/products');
  return Array.isArray(data) ? data : (data.products || []);
}

// Fetch model configuration and trees: GET /model
async function fetchRemoteModel() {
  return fetchRemoteJson('/model');
}

// Fetch model metrics: GET /metrics
async function fetchRemoteMetrics() {
  return fetchRemoteJson('/metrics');
}

// Fetch weekly sales history for all products or a single product
// GET /history or GET /history/:code
async function fetchRemoteHistory(code) {
  const endpoint = code ? `/history/${encodeURIComponent(code)}` : '/history';
  return fetchRemoteJson(endpoint);
}

module.exports = {
  REMOTE_DATA_BASE_URL,
  fetchRemoteProducts,
  fetchRemoteModel,
  fetchRemoteMetrics,
  fetchRemoteHistory,
  fetchRemoteJson,
};
