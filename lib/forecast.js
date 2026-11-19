'use strict';
// Core forecasting logic (no external packages needed).
// This file is a direct JavaScript port of the Python code in app.py:
//   - load the weekly sales history (was pandas.read_csv)
//   - build the 10 model features for the next week
//   - run the trained gradient-boosting model (was model.predict)
//   - apply the stockout risk rule

const fs = require('fs');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_HISTORY_WEEKS = 8;

// "2010-11-29" -> milliseconds at midnight UTC (avoids timezone surprises)
function parseDate(text) {
  const [year, month, day] = text.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

// Read weekly_history.csv into a Map: StockCode -> rows sorted by week.
function loadHistory(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = lines[0].split(',').map((name) => name.trim());
  const column = (name) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`weekly_history.csv is missing the column "${name}"`);
    return index;
  };
  const iCode = column('StockCode');
  const iWeek = column('Week');
  const iDemand = column('Demand');
  const iPrice = column('UnitPrice');

  const byCode = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const code = cells[iCode].trim();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({
      week: parseDate(cells[iWeek].trim()),
      demand: Number(cells[iDemand]),
      unitPrice: Number(cells[iPrice]),
    });
  }
  for (const rows of byCode.values()) rows.sort((a, b) => a.week - b.week);
  return byCode;
}

// Load the exported model (trees + baseline + feature order).
// Created by scripts/export_model.py from the original demand_model.joblib.
function loadModel(jsonPath) {
  const model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return { features: model.features, baseline: model.baseline, trees: model.trees };
}

// ISO week number (same as pandas' isocalendar().week).
function isoWeek(ms) {
  const date = new Date(ms);
  const dayNumber = (date.getUTCDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  // The Thursday of this date's ISO week decides which year the week belongs to.
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - dayNumber + 3);
  const thursdayYear = new Date(thursday).getUTCFullYear();
  // Week 1 is the week containing January 4th.
  const jan4 = Date.UTC(thursdayYear, 0, 4);
  const jan4DayNumber = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Thursday = jan4 - jan4DayNumber * DAY_MS + 3 * DAY_MS;
  return 1 + Math.round((thursday - week1Thursday) / (7 * DAY_MS));
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Sample standard deviation (divides by n - 1, same as pandas' default).
function sampleStd(values) {
  const avg = mean(values);
  const squared = values.reduce((sum, v) => sum + (v - avg) ** 2, 0);
  return Math.sqrt(squared / (values.length - 1));
}

// Build the same 10 features the Python version built.
function buildFeatures(rows, nextWeek) {
  const demand = rows.map((row) => row.demand);
  const n = demand.length;
  const nextDate = new Date(nextWeek);
  const values = {
    lag_1: demand[n - 1],
    lag_2: demand[n - 2],
    lag_3: demand[n - 3],
    lag_4: demand[n - 4],
    rolling_mean_4: mean(demand.slice(-4)),
    rolling_std_4: sampleStd(demand.slice(-4)),
    rolling_mean_8: mean(demand.slice(-8)),
    month: nextDate.getUTCMonth() + 1,
    week_of_year: isoWeek(nextWeek),
    UnitPrice: rows[n - 1].unitPrice,
  };
  return values;
}

// Walk one decision tree. Splits go left when value <= threshold.
function treeOutput(nodes, x) {
  let node = nodes[0];
  while (!node.leaf) {
    const value = x[node.f];
    const goLeft = Number.isNaN(value) ? node.miss_left : value <= node.t;
    node = nodes[goLeft ? node.l : node.r];
  }
  return node.v;
}

// Predict next week's demand: baseline + sum of all trees (same as sklearn).
function predictDemand(model, features) {
  const x = model.features.map((name) => features[name]);
  let total = model.baseline;
  for (const tree of model.trees) total += treeOutput(tree, x);
  return total;
}

function riskLabel(currentStock, predicted) {
  if (currentStock < predicted) return 'HIGH RISK';
  if (currentStock < 1.5 * predicted) return 'MEDIUM RISK';
  return 'LOW RISK';
}

// Main entry point used by the server.
// Returns { ok: true, data } or { ok: false, error }.
function forecastStockout({ history, model, stockCode, currentStock }) {
  const rows = history.get(stockCode);
  if (!rows || rows.length < MIN_HISTORY_WEEKS) {
    return { ok: false, error: 'Not enough history for this product code.' };
  }

  const lastWeek = rows[rows.length - 1].week;
  const nextWeek = lastWeek + 7 * DAY_MS;
  const features = buildFeatures(rows, nextWeek);

  const predicted = Math.max(predictDemand(model, features), 0);
  const roundedDemand = Math.round(predicted * 10) / 10;

  return {
    ok: true,
    data: {
      stock_code: stockCode,
      next_week: new Date(nextWeek).toISOString().slice(0, 10),
      predicted_demand: roundedDemand,
      current_stock: currentStock,
      risk: riskLabel(currentStock, predicted),
    },
  };
}

module.exports = { loadHistory, loadModel, forecastStockout, isoWeek, buildFeatures, predictDemand };
