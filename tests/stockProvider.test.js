'use strict';
// Tests for stock provider

const { MockStockProvider, RestStockProvider, Cache, createStockProvider } = require('../lib/stockProvider');

// Mock history and forecasts for testing
const mockHistory = new Map([
  ['TEST001', [{ week: Date.UTC(2020, 0, 1), demand: 100, unitPrice: 10 }]],
  ['TEST002', [{ week: Date.UTC(2020, 0, 1), demand: 50, unitPrice: 20 }]],
]);

const mockForecasts = [
  { code: 'TEST001', predicted_demand: 100 },
  { code: 'TEST002', predicted_demand: 50 },
];

// Test MockStockProvider
async function testMockProvider() {
  const provider = new MockStockProvider(mockHistory, mockForecasts);

  // Test single stock level
  const stock1 = await provider.getStockLevel('TEST001');
  console.assert(typeof stock1 === 'number' && stock1 >= 0, 'Single stock should be a non-negative number');

  // Test bulk stock levels
  const stockMap = await provider.getStockLevels(['TEST001', 'TEST002']);
  console.assert(stockMap instanceof Map, 'Should return a Map');
  console.assert(stockMap.has('TEST001'), 'Should have TEST001');
  console.assert(stockMap.has('TEST002'), 'Should have TEST002');
  console.assert(typeof stockMap.get('TEST001') === 'number', 'Stock values should be numbers');

  // Test health check
  const health = await provider.healthCheck();
  console.assert(health.ok === true, 'Health check should be ok');
  console.assert(health.provider === 'mock', 'Should identify as mock provider');

  console.log('MockStockProvider tests passed');
}

// Test Cache
async function testCache() {
  const cache = new Cache(100); // 100ms TTL

  cache.set('key1', 'value1');
  console.assert(cache.get('key1') === 'value1', 'Should retrieve cached value');

  cache.set('key2', 'value2');
  console.assert(cache.get('key2') === 'value2', 'Should retrieve second cached value');

  // Test expiration
  const expiredCache = new Cache(1); // 1ms TTL
  expiredCache.set('expired', 'value');
  // Wait for expiration
  await new Promise(resolve => setTimeout(resolve, 10));
  console.assert(expiredCache.get('expired') === null, 'Expired entries should return null');

  console.log('Cache tests passed');
}

// Test factory function
async function testCreateStockProvider() {
  // Test mock (default)
  const mockProvider = createStockProvider('mock', {}, mockHistory, mockForecasts);
  console.assert(mockProvider instanceof MockStockProvider, 'Should create MockStockProvider for "mock"');

  const defaultProvider = createStockProvider('unknown', {}, mockHistory, mockForecasts);
  console.assert(defaultProvider instanceof MockStockProvider, 'Should default to MockStockProvider');

  // Test rest (requires config)
  const restProvider = createStockProvider('rest', { rest: { baseUrl: 'http://test.com' } }, mockHistory, mockForecasts);
  console.assert(restProvider instanceof RestStockProvider, 'Should create RestStockProvider for "rest"');

  // Test database throws
  try {
    createStockProvider('database', {}, mockHistory, mockForecasts);
    console.assert(false, 'Should throw for database provider');
  } catch (e) {
    console.assert(e.message.includes('not yet implemented'), 'Should throw appropriate error');
  }

  console.log('Factory function tests passed');
}

// Run all tests
async function runTests() {
  await testMockProvider();
  await testCache();
  await testCreateStockProvider();
  console.log('\nAll stock provider tests passed!');
}

runTests().catch(console.error);