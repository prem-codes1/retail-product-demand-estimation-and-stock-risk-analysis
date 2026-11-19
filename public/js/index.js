'use strict';
// Browser code for the dashboard and the product search screen.

// ---------- shared state ----------
const state = {
  forecasts: [],          // every product: { code, name, predicted_demand, next_week, live_stock, stock_source }
  metrics: null,          // model accuracy from /metrics
  stock: loadStock(),     // { productCode: units } entered on the dashboard, saved in this browser
  filter: 'all',
  tableQuery: '',
  liveStock: {},          // { productCode: units } from live provider
};

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);

function loadStock() {
  try { return JSON.parse(localStorage.getItem('stockLevels') || '{}'); } catch (e) { return {}; }
}
function saveStock() {
  try { localStorage.setItem('stockLevels', JSON.stringify(state.stock)); } catch (e) { /* storage unavailable */ }
}
function hasStock(code) {
  return state.stock[code] !== undefined && state.stock[code] !== null && state.stock[code] !== '';
}
function typicalError() {
  return state.metrics ? state.metrics.mae_model : 0;
}
// Same rule as the server: HIGH below forecast, MEDIUM below 1.5x forecast, else LOW
function riskOf(stock, forecast) {
  if (stock < forecast) return 'HIGH';
  if (stock < 1.5 * forecast) return 'MEDIUM';
  return 'LOW';
}
function suggestedOrder(forecast, stock) {
  return Math.max(0, Math.round(forecast + typicalError() - stock));
}
function fmt(n) { return Math.round(n).toLocaleString(); }
function badge(risk) {
  if (!risk) return '<span class="badge risk-none">ENTER STOCK</span>';
  return `<span class="badge risk-${risk.toLowerCase()}">${risk}</span>`;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- view switching ----------
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $('view-dashboard').hidden = btn.dataset.view !== 'dashboard';
    $('view-search').hidden = btn.dataset.view !== 'search';
  });
});

// ---------- dashboard ----------
function dashboardRows() {
  // Products with stock entered, plus the 50 with the highest forecast
  const map = new Map();
  for (const f of state.forecasts) {
    if (hasStock(f.code)) map.set(f.code, f);
  }
  for (const f of state.forecasts.slice(0, 50)) map.set(f.code, f);

  let rows = [...map.values()].map((f) => {
    // Priority: manual entry > live stock > none
    const manualStocked = hasStock(f.code);
    const liveStocked = state.liveStock[f.code] !== undefined && state.liveStock[f.code] !== null;
    const stock = manualStocked ? Number(state.stock[f.code]) : (liveStocked ? Number(state.liveStock[f.code]) : null);
    const stockSource = manualStocked ? 'manual' : (liveStocked ? 'live' : 'none');

    return {
      ...f,
      stock,
      stockSource,
      risk: stock !== null ? riskOf(stock, f.predicted_demand) : null,
      shortage: stock !== null ? Math.max(0, f.predicted_demand - stock) : null,
      order: stock !== null ? suggestedOrder(f.predicted_demand, stock) : null,
    };
  });

  if (state.filter === 'nostock') rows = rows.filter((r) => r.risk === null);
  else if (state.filter !== 'all') rows = rows.filter((r) => r.risk === state.filter.toUpperCase());

  if (state.tableQuery) {
    const q = state.tableQuery.toLowerCase();
    rows = rows.filter((r) => (r.name || '').toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
  }

  // Products with stock first, biggest shortage at the top; then by forecast
  rows.sort((a, b) => {
    if (a.shortage !== null && b.shortage !== null) return b.shortage - a.shortage;
    if (a.shortage !== null) return -1;
    if (b.shortage !== null) return 1;
    return b.predicted_demand - a.predicted_demand;
  });
  return rows;
}

function renderCards() {
  // Count products with any stock (manual or live)
  const withStock = state.forecasts.filter((f) => hasStock(f.code) || (state.liveStock[f.code] !== undefined && state.liveStock[f.code] !== null));
  const risks = withStock.map((f) => {
    const stock = hasStock(f.code) ? Number(state.stock[f.code]) : Number(state.liveStock[f.code]);
    return riskOf(stock, f.predicted_demand);
  });
  const high = risks.filter((r) => r === 'HIGH').length;
  const medium = risks.filter((r) => r === 'MEDIUM').length;

  $('cardHigh').textContent = withStock.length ? high.toLocaleString() : '–';
  $('cardHighSub').textContent = withStock.length
    ? `of ${withStock.length} products with stock data`
    : 'No stock data available';
  $('cardMedium').textContent = withStock.length ? medium.toLocaleString() : '–';
  $('cardMediumSub').textContent = withStock.length
    ? `of ${withStock.length} products with stock data`
    : 'No stock data available';

  const total = state.forecasts.reduce((sum, f) => sum + f.predicted_demand, 0);
  $('cardForecast').textContent = fmt(total);
  $('cardForecastSub').textContent = state.forecasts[0]
    ? `units next week (week of ${state.forecasts[0].next_week})`
    : 'units next week';

  if (state.metrics) {
    $('cardMae').textContent = `±${state.metrics.mae_model}`;
    $('cardMaeSub').textContent = `units per product. A simple 4-week average gives ±${state.metrics.mae_4week_average}`;
  }
}

function renderTable() {
  const body = $('tableBody');
  const rows = dashboardRows();
  if (rows.length === 0) {
    body.replaceChildren(Object.assign(document.createElement('tr'), {
      innerHTML: '<td colspan="6" class="empty">No products match this filter.</td>',
    }));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');

    const nameCell = el('td', 'product-cell');
    nameCell.append(document.createTextNode(r.name || r.code), el('small', null, r.code));

    const stockCell = el('td', 'num');
    const input = el('input', 'stock-input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.placeholder = 'enter';
    // Show manual entry if exists, otherwise show live stock as placeholder
    const displayValue = hasStock(r.code) ? state.stock[r.code] : (r.stockSource === 'live' ? r.stock : '');
    input.value = displayValue;
    input.setAttribute('aria-label', `Stock for ${r.name || r.code}`);
    // Add visual indicator for live stock
    if (r.stockSource === 'live' && !hasStock(r.code)) {
      input.classList.add('live-stock');
      input.title = 'Live stock data (click to override)';
    }
    input.addEventListener('change', () => {
      const value = input.value.trim();
      if (value === '' || Number(value) < 0 || Number.isNaN(Number(value))) {
        delete state.stock[r.code];
      } else {
        state.stock[r.code] = Number(value);
      }
      saveStock();
      refreshDashboard();
    });
    stockCell.append(input);

    // Add source badge
    if (r.stockSource === 'live' && !hasStock(r.code)) {
      const badge = el('span', 'stock-source live', 'live');
      stockCell.append(badge);
    } else if (hasStock(r.code)) {
      const badge = el('span', 'stock-source manual', 'manual');
      stockCell.append(badge);
    }

    const riskCell = el('td');
    riskCell.innerHTML = badge(r.risk);

    tr.append(
      nameCell,
      el('td', 'num', fmt(r.predicted_demand)),
      stockCell,
      el('td', 'num', r.shortage === null ? '–' : fmt(r.shortage)),
      riskCell,
      el('td', 'num', r.order === null ? '–' : fmt(r.order)),
    );
    frag.append(tr);
  }
  body.replaceChildren(frag);
}

function refreshDashboard() {
  renderCards();
  renderTable();
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderTable();
  });
});

$('tableSearch').addEventListener('input', (event) => {
  state.tableQuery = event.target.value.trim();
  renderTable();
});

async function loadDashboard() {
  try {
    const [forecastRes, metricsRes] = await Promise.all([fetch('/forecasts'), fetch('/metrics')]);
    const forecastData = await forecastRes.json();
    state.forecasts = forecastData.forecasts;
    state.metrics = metricsRes.ok ? await metricsRes.json() : null;

    // Load live stock data
    try {
      const stockRes = await fetch('/stock/bulk');
      if (stockRes.ok) {
        const stockData = await stockRes.json();
        state.liveStock = stockData.stock || {};
      }
    } catch (e) {
      console.warn('Could not load live stock:', e);
    }

    refreshDashboard();
  } catch (error) {
    $('tableBody').replaceChildren(Object.assign(document.createElement('tr'), {
      innerHTML: '<td colspan="6" class="empty">Could not load products. Is the server running?</td>',
    }));
  }
}

// ---------- product search: suggestions ----------
const productInput = $('product');
const suggestionList = $('suggestions');
const stockInput = $('currentStock');
const predictButton = $('predictBtn');
const result = $('result');

let selectedCode = null;
let activeIndex = -1;
let currentMatches = [];
let searchTimer = null;
let searchId = 0;

function hideSuggestions() {
  suggestionList.hidden = true;
  suggestionList.replaceChildren();
  activeIndex = -1;
}

function renderSuggestions(matches) {
  currentMatches = matches;
  activeIndex = -1;
  if (matches.length === 0) return hideSuggestions();
  suggestionList.replaceChildren(...matches.map((m) => {
    const li = el('li', 'suggestion');
    li.setAttribute('role', 'option');
    li.append(el('span', null, m.name), el('span', 'code', m.code));
    // mousedown runs before the input loses focus, so the choice is not lost
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectProduct(m.code, m.name);
    });
    return li;
  }));
  suggestionList.hidden = false;
}

function setActive(index) {
  const items = suggestionList.querySelectorAll('.suggestion');
  items.forEach((item) => item.classList.remove('active'));
  if (index >= 0 && index < items.length) {
    items[index].classList.add('active');
    activeIndex = index;
  }
}

async function fetchSuggestions(text) {
  const id = ++searchId;
  try {
    const res = await fetch(`/products?q=${encodeURIComponent(text)}`);
    const data = await res.json();
    if (id === searchId) renderSuggestions(data.products);
  } catch (e) {
    hideSuggestions();
  }
}

productInput.addEventListener('input', () => {
  selectedCode = null;
  const text = productInput.value.trim();
  clearTimeout(searchTimer);
  if (!text) return hideSuggestions();
  searchTimer = setTimeout(() => fetchSuggestions(text), 150);
});

productInput.addEventListener('keydown', (event) => {
  const open = !suggestionList.hidden && currentMatches.length > 0;
  if (event.key === 'ArrowDown' && open) {
    event.preventDefault();
    setActive(Math.min(activeIndex + 1, currentMatches.length - 1));
  } else if (event.key === 'ArrowUp' && open) {
    event.preventDefault();
    setActive(Math.max(activeIndex - 1, 0));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (open && activeIndex >= 0) {
      const m = currentMatches[activeIndex];
      selectProduct(m.code, m.name);
    } else {
      hideSuggestions();
      predict();
    }
  } else if (event.key === 'Escape') {
    hideSuggestions();
  }
});

productInput.addEventListener('blur', () => setTimeout(hideSuggestions, 100));

function selectProduct(code, name) {
  selectedCode = code;
  productInput.value = name;
  hideSuggestions();
  // Auto-fetch live stock for this product
  fetch(`/stock/${encodeURIComponent(code)}`)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data && typeof data.stock === 'number') {
        stockInput.value = data.stock;
        stockInput.classList.add('live-stock');
        stockInput.title = 'Live stock data (edit to override)';
      }
    })
    .catch(() => { /* ignore */ });
  predict();
}

// ---------- product search: result ----------
function showChoices(matches) {
  const heading = el('p', 'message', 'More than one product matches. Pick one:');
  const list = el('div', 'choices');
  for (const m of matches) {
    const b = el('button', 'choice', `${m.name} (${m.code})`);
    b.type = 'button';
    b.addEventListener('click', () => selectProduct(m.code, m.name));
    list.append(b);
  }
  result.replaceChildren(heading, list);
}

function showError(text) {
  result.replaceChildren(el('div', 'error', text));
}

// Forecast range bar: shaded band (forecast ± typical error), forecast marker, your stock line
function rangeBar(forecast, stock) {
  const m = typicalError();
  const low = Math.max(0, forecast - m);
  const high = forecast + m;
  const max = Math.max(high, stock, 1) * 1.15;
  const pct = (v) => `${((v / max) * 100).toFixed(2)}%`;

  const wrap = el('div', 'range-wrap');
  wrap.append(el('p', 'range-title', `Forecast range: ${fmt(low)} to ${fmt(high)} units`));
  const bar = el('div', 'range');
  const band = el('div', 'band');
  band.style.left = pct(low);
  band.style.width = pct(high - low);
  const marker = el('div', 'marker');
  marker.style.left = pct(forecast);
  const markerLabel = el('span', 'marker-label', `Forecast ${fmt(forecast)}`);
  markerLabel.style.left = pct(forecast);
  bar.append(band, marker, markerLabel);
  const stockLine = el('div', 'stock-marker');
  stockLine.style.left = pct(stock);
  const stockLabel = el('span', 'stock-label', `Stock ${fmt(stock)}`);
  stockLabel.style.left = pct(stock);
  bar.append(stockLine, stockLabel);
  wrap.append(bar);
  return wrap;
}

// 12 weeks of actual demand, with next week's forecast as a dashed point
function drawChart(container, weeks, forecast) {
  const last = weeks.slice(-12);
  const n = last.length;
  const W = 600, H = 200, P = 30;
  const values = last.map((w) => w.demand).concat([forecast]);
  const max = Math.max(...values, 1) * 1.15;
  const x = (i) => P + (i * (W - 2 * P)) / n;
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Weekly demand, last 12 weeks, with forecast' });
  // Horizontal guide lines
  for (let i = 0; i <= 4; i++) {
    const v = (max / 1.15) * (i / 4);
    svg.append(svgEl('line', { x1: P, x2: W - P, y1: y(v), y2: y(v), stroke: 'var(--border)' }));
    const label = svgEl('text', { x: 4, y: y(v) + 4 });
    label.textContent = fmt(v);
    svg.append(label);
  }
  // Actual demand line
  const points = last.map((w, i) => `${x(i)},${y(w.demand)}`).join(' ');
  svg.append(svgEl('polyline', { class: 'line-actual', points }));
  last.forEach((w, i) => svg.append(svgEl('circle', { class: 'dot-actual', cx: x(i), cy: y(w.demand), r: 3 })));
  // Forecast point, joined to the last actual week
  const fx = x(n);
  svg.append(svgEl('line', {
    class: 'line-forecast', x1: x(n - 1), y1: y(last[n - 1].demand), x2: fx, y2: y(forecast),
  }));
  svg.append(svgEl('circle', { class: 'dot-forecast', cx: fx, cy: y(forecast), r: 5 }));
  const fLabel = svgEl('text', { x: fx - 6, y: y(forecast) - 10, 'text-anchor': 'end' });
  fLabel.textContent = `forecast ${fmt(forecast)}`;
  svg.append(fLabel);

  const wrap = el('div', 'chart');
  wrap.append(svg, el('p', 'note', 'Blue line: actual weekly demand (last 12 weeks). Dashed orange point: next week’s forecast.'));
  container.replaceChildren(wrap);
}

function whyPanel(weeks, forecastInfo) {
  const last4 = weeks.slice(-4);
  const avg4 = last4.reduce((s, w) => s + w.demand, 0) / last4.length;
  const latest = weeks[weeks.length - 1];
  const month = forecastInfo ? new Date(forecastInfo.next_week + 'T00:00:00Z').toLocaleString('en', { month: 'long', timeZone: 'UTC' }) : '–';

  const panel = el('div', 'panel');
  panel.append(el('h3', null, 'What the forecast is based on'));
  const list = el('ul');
  for (const w of last4) {
    const li = el('li');
    li.append(el('span', null, `Week ${w.week}`), el('strong', null, `${fmt(w.demand)} units`));
    list.append(li);
  }
  const rows = [
    ['4-week average', `${fmt(avg4)} units`],
    ['Latest unit price', latest.unit_price.toFixed(2)],
    ['Forecast month', month],
  ];
  for (const [label, value] of rows) {
    const li = el('li');
    li.append(el('span', null, label), el('strong', null, value));
    list.append(li);
  }
  panel.append(list);
  return panel;
}

async function showResult(data, weeks) {
  const forecast = data.predicted_demand;
  const stock = Number(data.current_stock);
  const risk = riskOf(stock, forecast);
  const stockSource = data.stock_source || 'manual';

  const card = el('div', 'result-card');
  const head = el('div', 'result-head');
  const titleBox = el('div');
  titleBox.append(el('h2', null, data.product_name || data.stock_code), el('div', 'code', `Code ${data.stock_code} · next week ${data.next_week}`));
  const badgeBox = el('div');
  badgeBox.innerHTML = badge(risk);
  head.append(titleBox, badgeBox);

  const grid = el('div', 'stat-grid');
  const stats = [
    ['Forecast next week', `${fmt(forecast)} units`],
    ['Current stock', `${fmt(stock)} units`],
    ['Shortage', `${fmt(Math.max(0, forecast - stock))} units`],
    ['Suggested order', `${fmt(suggestedOrder(forecast, stock))} units`],
  ];
  for (const [label, value] of stats) {
    const box = el('div', 'stat');
    box.append(el('span', null, label), el('strong', null, value));
    grid.append(box);
  }

  // Add stock source indicator
  if (stockSource === 'live') {
    const sourceNote = el('p', 'stock-source-note');
    sourceNote.innerHTML = '<span class="badge live">Live stock data</span> (edit above to override)';
    grid.append(sourceNote);
  }

  const analysis = el('div', 'analysis');
  const chartBox = el('div');
  analysis.append(chartBox);
  if (weeks) {
    analysis.append(whyPanel(weeks, { next_week: data.next_week }));
    drawChart(chartBox, weeks, forecast);
  }

  card.append(head, rangeBar(forecast, stock), grid, analysis);
  result.replaceChildren(card);

  // Add AI explanation button
  addExplainButton(data, weeks);

  // Update the stock input with the actual stock used (in case it was auto-fetched)
  stockInput.value = stock;
  if (stockSource === 'live') {
    stockInput.classList.add('live-stock');
    stockInput.title = 'Live stock data (edit to override)';
  } else {
    stockInput.classList.remove('live-stock');
    stockInput.title = '';
  }
}

async function predict() {
  const text = productInput.value.trim();
  const product = selectedCode || text;
  const currentStock = parseFloat(stockInput.value);

  if (!product) return showError('Please type a product name or code.');
  // current_stock is now optional - server will auto-fetch if not provided
  if (!Number.isNaN(currentStock) && currentStock < 0) return showError('Please enter a valid stock number (0 or more).');

  predictButton.disabled = true;
  predictButton.textContent = 'Predicting…';
  result.replaceChildren(el('p', 'message', 'Predicting…'));

  try {
    const body = { product };
    if (!Number.isNaN(currentStock)) body.current_stock = currentStock;

    const response = await fetch('/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    if (response.status === 409 && data.matches) {
      showChoices(data.matches);
    } else if (!response.ok || data.error) {
      showError(data.error || 'The server returned an error. Please try again.');
    } else {
      // Past weeks for the chart and the "what the forecast is based on" panel
      let weeks = null;
      try {
        const hist = await fetch(`/history/${encodeURIComponent(data.stock_code)}`);
        if (hist.ok) weeks = (await hist.json()).weeks;
      } catch (e) { /* the chart is optional */ }
      await showResult(data, weeks);
    }
  } catch (error) {
    showError('Could not reach the server. Make sure it is running (npm start) and reload the page.');
  } finally {
    predictButton.disabled = false;
    predictButton.textContent = 'Predict';
  }
}

predictButton.addEventListener('click', () => { hideSuggestions(); predict(); });

// ---------- AI Explanation ----------
async function fetchExplanation(productCode, productName, forecastData, features, historyData) {
  try {
    const response = await fetch('/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: productCode,
        forecast: forecastData,
        features,
        history: historyData,
      }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Failed to fetch explanation');
    }
    return data.explanation;
  } catch (error) {
    console.error('Explanation fetch error:', error);
    return null;
  }
}

function renderExplanation(explanation) {
  if (!explanation) return el('div', 'ai-explanation', 'Forecast analysis details are unavailable at this moment.');

  const container = el('div', 'ai-explanation');

  // Source indicator - subtle and professional
  const sourceBadge = el('div', 'ai-source');
  sourceBadge.textContent = '📊 Forecast Analysis & Executive Breakdown';

  // Summary
  const summary = el('p', 'ai-summary', explanation.summary);

  // Drivers
  const driversSection = el('div', 'ai-section');
  const driversTitle = el('h4', null, 'Key Drivers');
  const driversList = el('ul', 'ai-list');
  explanation.drivers.forEach(d => {
    const li = el('li', null, d);
    driversList.append(li);
  });
  driversSection.append(driversTitle, driversList);

  // Risks
  const risksSection = el('div', 'ai-section');
  const risksTitle = el('h4', null, 'Risks to Monitor');
  const risksList = el('ul', 'ai-list');
  explanation.risks.forEach(r => {
    const li = el('li', null, r);
    risksList.append(li);
  });
  risksSection.append(risksTitle, risksList);

  // Confidence
  const confidenceColors = { HIGH: 'var(--low)', MEDIUM: 'var(--medium)', LOW: 'var(--high)' };
  const confidence = el('div', 'ai-confidence');
  confidence.innerHTML = `Forecast Confidence: <strong style="color: ${confidenceColors[explanation.confidence] || 'var(--text)'}">${explanation.confidence}</strong>`;

  container.append(sourceBadge, summary, driversSection, risksSection, confidence);
  return container;
}

// Cache explanations per product code to keep view fast and toggleable
const explanationCache = new Map();

async function toggleForecastDetails(button, productCode, productName, forecastData, features, historyData) {
  let container = document.getElementById('ai-explanation-container');
  if (!container) {
    container = el('div', 'ai-explanation-container');
    container.id = 'ai-explanation-container';
    container.hidden = true;
    result.appendChild(container);
  }

  // If already visible for the current product, toggle it closed
  if (!container.hidden && container.dataset.productCode === productCode) {
    container.hidden = true;
    button.textContent = '📊 View Forecast Details';
    return;
  }

  // Check if we already fetched/cached it
  if (explanationCache.has(productCode)) {
    container.dataset.productCode = productCode;
    container.replaceChildren(renderExplanation(explanationCache.get(productCode)));
    container.hidden = false;
    button.textContent = '📊 Hide Forecast Details';
    return;
  }

  // Fetch in background while showing retrieval state
  button.disabled = true;
  button.textContent = 'Opening details…';
  container.hidden = false;
  container.dataset.productCode = productCode;
  container.innerHTML = '<div class="ai-loading">Retrieving forecast breakdown…</div>';

  const explanation = await fetchExplanation(productCode, productName, forecastData, features, historyData);

  button.disabled = false;
  if (explanation) {
    explanationCache.set(productCode, explanation);
    container.replaceChildren(renderExplanation(explanation));
    button.textContent = '📊 Hide Forecast Details';
  } else {
    container.innerHTML = '<div class="ai-error">Could not load forecast details. Please try again.</div>';
    button.textContent = '📊 View Forecast Details';
  }
}

function addExplainButton(data, weeks) {
  // Check if we already have the button
  if (document.getElementById('explain-btn')) return;

  // Find a good place to insert the button - after the stat-grid
  const statGrid = result.querySelector('.stat-grid');
  if (!statGrid) return;

  const btn = el('button', 'primary explain-btn', '📊 View Forecast Details');
  btn.id = 'explain-btn';
  btn.style.marginTop = '16px';
  btn.style.width = '100%';
  btn.addEventListener('click', () => {
    toggleForecastDetails(btn, data.stock_code, data.product_name || data.stock_code, data,
      // We need features - fetch from history endpoint which we already have in weeks
      {
        lag_1: weeks?.[weeks.length - 1]?.demand || 0,
        lag_2: weeks?.[weeks.length - 2]?.demand || 0,
        lag_3: weeks?.[weeks.length - 3]?.demand || 0,
        lag_4: weeks?.[weeks.length - 4]?.demand || 0,
        rolling_mean_4: weeks ? weeks.slice(-4).reduce((s, w) => s + w.demand, 0) / 4 : 0,
        rolling_mean_8: weeks ? weeks.slice(-8).reduce((s, w) => s + w.demand, 0) / Math.min(8, weeks.length) : 0,
        rolling_std_4: weeks ? Math.sqrt(weeks.slice(-4).reduce((s, w) => s + Math.pow(w.demand - (weeks.slice(-4).reduce((a, b) => a + b.demand, 0) / 4), 2), 0) / 3) : 0,
        UnitPrice: weeks?.[weeks.length - 1]?.unit_price || 0,
        month: new Date(data.next_week).getMonth() + 1,
        week_of_year: Math.ceil((new Date(data.next_week).getTime() - new Date(new Date(data.next_week).getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000)),
      },
      weeks || []
    );
  });

  statGrid.parentNode.insertBefore(btn, statGrid.nextSibling);
}

// ---------- start ----------
loadDashboard();
