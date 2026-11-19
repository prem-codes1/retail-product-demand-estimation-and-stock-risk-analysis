'use strict';
// Run with:  npm test
// Checks the JavaScript forecast against predictions from the scikit-learn model
// (same logic as the original Python app).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { loadHistory, loadModel, forecastStockout, isoWeek } = require('../lib/forecast');

const dataDir = path.join(__dirname, '..', 'data');
const history = loadHistory(path.join(dataDir, 'weekly_history.csv'));
const model = loadModel(path.join(dataDir, 'model_trees.json'));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

test('loads all products from the history file', () => {
  assert.equal(history.size, 3803);
  assert.equal(history.get('15036').length, 54);
});

test('ISO week numbers match pandas for edge dates', () => {
  // Expected values come from pandas: Timestamp(...).isocalendar().week
  const cases = { '2010-01-03': 53, '2010-01-04': 1, '2011-12-12': 50, '2020-12-28': 53, '2021-01-04': 1 };
  for (const [date, week] of Object.entries(cases)) {
    assert.equal(isoWeek(Date.parse(date + 'T00:00:00Z')), week, date);
  }
});

test('predictions and risk labels match the original Python server', () => {
  for (const fx of fixtures) {
    const result = forecastStockout({
      history,
      model,
      stockCode: fx.input.stock_code,
      currentStock: fx.input.current_stock,
    });
    const expected = fx.expected;
    if (expected.error) {
      assert.equal(result.ok, false, JSON.stringify(fx.input));
      assert.equal(result.error, expected.error);
      continue;
    }
    assert.equal(result.ok, true, JSON.stringify(fx.input));
    assert.equal(result.data.next_week, expected.next_week, JSON.stringify(fx.input));
    assert.equal(result.data.risk, expected.risk, JSON.stringify(fx.input));
    assert.ok(
      Math.abs(result.data.predicted_demand - expected.predicted_demand) <= 0.05 + 1e-9,
      `demand ${result.data.predicted_demand} vs ${expected.predicted_demand} for ${JSON.stringify(fx.input)}`
    );
  }
});
