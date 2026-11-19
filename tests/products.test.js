'use strict';
// Tests for name search: typing a name or code finds the right product.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadProducts, buildIndex, searchProducts, resolveProduct } = require('../lib/products');
const { loadHistory } = require('../lib/forecast');

const dataDir = path.join(__dirname, '..', 'data');
const index = buildIndex(loadProducts(path.join(dataDir, 'products.json')));
const historyCodes = new Set(loadHistory(path.join(dataDir, 'weekly_history.csv')).keys());

test('typing "wh" shows WHITE HANGING HEART T-LIGHT HOLDER', () => {
  const names = searchProducts(index, 'wh', 50).map((p) => p.name);
  assert.ok(names.includes('WHITE HANGING HEART T-LIGHT HOLDER'));
});

test('search is case-insensitive and matches the start of any word', () => {
  const lower = searchProducts(index, 'hanging heart', 50).map((p) => p.code);
  const upper = searchProducts(index, 'HANGING HEART', 50).map((p) => p.code);
  assert.deepEqual(lower, upper);
  assert.ok(lower.includes('85123A'));
});

test('results are capped at the limit', () => {
  assert.equal(searchProducts(index, 'a', 10).length, 10);
});

test('empty text returns nothing', () => {
  assert.deepEqual(searchProducts(index, '   ', 10), []);
});

test('a code resolves to itself', () => {
  assert.deepEqual(resolveProduct(index, historyCodes, '85123A'), { status: 'found', code: '85123A' });
});

test('an exact name resolves to its code, any capitalization', () => {
  const r = resolveProduct(index, historyCodes, 'white hanging heart t-light holder');
  assert.deepEqual(r, { status: 'found', code: '85123A' });
});

test('a partial name that matches one product resolves to it', () => {
  const r = resolveProduct(index, historyCodes, 'HANGING HEART ZINC');
  assert.equal(r.status, 'found');
});

test('a word that matches many products asks the user to pick', () => {
  const r = resolveProduct(index, historyCodes, 'white');
  assert.equal(r.status, 'ambiguous');
  assert.ok(r.matches.length > 1 && r.matches.length <= 10);
});

test('unknown text is not found', () => {
  assert.deepEqual(resolveProduct(index, historyCodes, 'NOT A REAL PRODUCT XYZ'), { status: 'not_found' });
});
