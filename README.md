# Stockout Risk Predictor (Node.js version)

This app predicts how many units of a product will sell **next week**, and tells you whether your current stock is enough.

Type a **product name** (for example `wh`) or a **product code**, pick the product, and the prediction appears.

This is a **Node.js + Express** app with a plain HTML page. It uses the trained model from the original Online Retail sales data. You do not need Python to run the app.

---

## 1. What you need

- **Node.js 18 or newer.** Check with: `node -v`
  If you don't have it, download it from https://nodejs.org (choose the LTS version).

---

## 2. How to start the server

Open a terminal inside the `sdc-project-node` folder and run:

```bash
npm install
npm start
```

- `npm install` downloads the Express library. You only need to do this once.
- `npm start` starts the server.

When you see this message, the server is ready:

```
Stockout risk server running at http://localhost:3000
Loaded 3803 products. Press Ctrl+C to stop.
```

Open your browser at **http://localhost:3000**.

To stop the server, press `Ctrl + C`.

> **Want a different port?** Run `PORT=4000 npm start` (Windows PowerShell: `$env:PORT=4000; npm start`), then open http://localhost:4000.

### Quick checks

- http://localhost:3000/health should show `{"status":"ok","products":3803}`
- To run the automatic tests: `npm test`

---

## 3. How to use the screens

The page has two screens. Switch between them with the buttons at the top.

### Dashboard (for managers and buyers)
- **Four cards:** products at HIGH risk, products at MEDIUM risk, total forecast demand for next week, and the typical error of the forecast.
- **Table:** the 50 products with the highest forecast, plus any product where you enter stock.
- **Your stock:** type the stock you have for a product in the "Your stock" box and press Enter. The risk, shortage, and suggested order are then calculated for that product.
- **Filters:** All, High, Medium, Low, and No stock entered. The filter box searches by name or code.
- Stock numbers are saved in your browser, so they are still there when you come back.

### Product search (for analysts)
1. Type a product name (for example `wh`) or a code, and pick it from the list.
2. The forecast appears with:
   - a **range bar**: the forecast, the likely range (forecast ± typical error), and your stock
   - the **risk**, the **shortage**, and the **suggested order**
   - a **chart** of the last 12 weeks of sales, with next week's forecast as a point
   - a **"what the forecast is based on"** panel: the last 4 weeks, their average, the latest unit price, and the forecast month
3. Change the stock number and press Predict again.

Typing a full name or a code and pressing Enter also works. If a name matches more than one product, the page lists the matches so you can choose.

### Changing the colours
Open `public/css/index.css`. The colours are listed at the top, under `:root`. Change a value there, then refresh the browser with `Ctrl + F5`.

### How the suggested order is calculated
`Suggested order = forecast + typical error − your stock` (never below 0). The typical error is the model's test error, which is saved in `data/metrics.json`.

---

### Live Warehouse Stock Integration (NEW)

The app now supports **automatic live stock data** from your warehouse management system (WMS/ERP), eliminating manual entry.

#### How it works
- **Dashboard**: Stock levels are auto-loaded for all products on page load via `/stock/bulk`
- **Product Search**: When you select a product, its live stock is auto-fetched
- **Manual Override**: You can still type a stock number to override the live data
- **Visual Indicators**: Live stock shows a blue "live" badge; manual entry shows a green "manual" badge

#### Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `STOCK_PROVIDER` | `mock` | `mock` \| `rest` \| `database` (future) |
| `WMS_BASE_URL` | - | Base URL for REST API (e.g., `https://wms.example.com/api`) |
| `WMS_API_KEY` | - | Bearer token for authentication |
| `WMS_TIMEOUT_MS` | `5000` | Request timeout in milliseconds |
| `WMS_CACHE_TTL_MS` | `60000` | Cache TTL for bulk requests (1 min default) |

#### Quick Start (Mock Provider - Default)
```bash
npm start
# Dashboard now shows live stock for all 3,803 products automatically
```

#### REST API Integration (Production)
```bash
# Windows PowerShell
$env:STOCK_PROVIDER="rest"
$env:WMS_BASE_URL="https://your-wms.com/api"
$env:WMS_API_KEY="your-api-key"
npm start

# Linux/Mac
STOCK_PROVIDER=rest WMS_BASE_URL=https://your-wms.com/api WMS_API_KEY=xxx npm start
```

#### Expected REST API Format

**Bulk endpoint** `POST /stock/bulk`
```json
// Request
{ "codes": ["ABC123", "DEF456"] }

// Response (either format works)
{ "stock": { "ABC123": 100, "DEF456": 50 } }
// or
[{ "code": "ABC123", "qty": 100 }, { "code": "DEF456", "qty": 50 }]
```

**Single endpoint** `GET /stock/{code}`
```json
// Response (any of these work)
{ "code": "ABC123", "qty": 100 }
{ "stock": 100 }
{ "quantity": 100 }
```

**Health endpoint** `GET /health` (optional but recommended)
```json
{ "status": "ok" }
```

---

### AI-Powered Demand Explainability (NEW)

The app now integrates **Google Gemini AI** to provide plain-English explanations of *why* a forecast was made — helping managers trust and act on predictions.

#### How it works
- **Product Search**: After predicting, click "🤖 Explain Forecast" button
- **AI Analysis**: Gemini analyzes the forecast drivers (trend, seasonality, price, volatility)
- **Structured Output**: Returns summary, key drivers, risks to monitor, and confidence level
- **Fallback Mode**: Works without API key (shows statistical fallback explanation)

#### Configuration (Environment Variables)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | No | - | Google AI Studio API key (get from https://aistudio.google.com) |
| `GEMINI_MODEL` | No | `gemini-1.5-flash` | Model to use (flash = fast/cheap, pro = higher quality) |
| `GEMINI_RATE_LIMIT` | No | `30` | Requests per minute (prevents quota exhaustion) |

#### Quick Start (Fallback Mode - Default)
```bash
npm start
# Click "🤖 Explain Forecast" after prediction - works without API key
```

#### With Gemini API (Production)
```bash
# Windows PowerShell
$env:GEMINI_API_KEY="your-api-key-from-aistudio"
npm start

# Linux/Mac
GEMINI_API_KEY=your-key npm start
```

#### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/gemini/health` | GET | Check Gemini connectivity |
| `/explain` | POST | Generate demand forecast explanation |

**Request to `/explain`:**
```json
{
  "product": "85123A",
  "forecast": { "predicted_demand": 600, "current_stock": 802, "risk": "MEDIUM RISK", "next_week": "2011-12-12" },
  "features": { "lag_1": 100, "lag_2": 90, "lag_3": 110, "lag_4": 95, "rolling_mean_4": 98.75, "rolling_mean_8": 95, "rolling_std_4": 8.5, "UnitPrice": 2.5, "month": 12, "week_of_year": 50 },
  "history": [{ "week": "2011-09-19", "demand": 80 }, ...]
}
```

**Response:**
```json
{
  "explanation": {
    "summary": "Demand is forecast at 600 units next week, driven by a rising trend and seasonal holiday demand.",
    "drivers": [
      "4-week average (98.8) exceeds 8-week baseline (95), indicating upward trend",
      "Holiday season (December) typically boosts demand for decorative items",
      "Current price ($2.50) is stable, supporting consistent demand"
    ],
    "risks": [
      "High volatility (std dev 8.5) means actual demand could swing significantly",
      "Stock (802) only covers 1.3x forecast - medium risk of stockout"
    ],
    "confidence": "MEDIUM",
    "generatedAt": "2026-11-19T15:47:48.128Z",
    "source": "gemini",
    "model": "gemini-1.5-flash"
  }
}
```

`source` values: `"gemini"` (AI-generated), `"fallback"` (no API key), `"rate_limited"`, `"error"`

#### Cost Estimation
- **Model**: `gemini-1.5-flash` (~$0.075/1M input tokens, $0.30/1M output)
- **Per explanation**: ~500 input + 200 output tokens ≈ **$0.0001**
- **30 req/min limit**: ~$0.18/hour max
- **Monthly (heavy use)**: **<$5**

---

## 4. How the project works (simple explanation)

| Part | File(s) | What it does |
|---|---|---|
| **Sales history** | `data/weekly_history.csv` | Weekly demand and unit price for every product, from the Online Retail sheet |
| **Product names** | `data/products.json` | Product code and name, used for the search |
| **Trained model** | `data/model_trees.json` | The "brain" that learned how sales change over time |
| **Server** | `server.js`, `lib/` | Searches products, prepares the numbers, asks the model, sends back the answer |
| **Web page** | `public/` | The search box and result page you see in the browser |

### What happens when you predict

1. **Browser** sends the product text (a name or a code) and the stock number to the server.
2. **Server** finds the product:
   - an exact code is used as it is
   - an exact name, or a single match, is used
   - if several products match, the server sends the list back and the page asks you to pick one
3. **Server** looks up that product's past weekly sales.
4. **Server** builds 10 numbers from the history:
   - the sales of the last 1, 2, 3 and 4 weeks
   - the average sales of the last 4 and 8 weeks, and how much the last 4 weeks vary
   - the month and week number of the coming week
   - the latest unit price
5. **Server** gives those numbers to the model. The model has 150 small decision trees. Each one gives a small guess, and the guesses are added together. The total is the predicted demand for next week (never below 0).
6. **Server** compares your stock with the predicted demand:
   - stock **less than** predicted demand → **HIGH RISK** (you may run out)
   - stock **less than 1.5 times** predicted demand → **MEDIUM RISK**
   - otherwise → **LOW RISK**
7. **Server** sends the answer back as JSON, and the page shows it.

### How the browser and the model talk to each other

```
Browser (search box)  --->  GET /products?q=wh   --->  Server  --->  product list
Browser (Predict)     --->  POST /predict        --->  Server  --->  model + history
                      <---  JSON answer          <---  Server  <---  prediction
```

**Request sent when you predict (current_stock is now optional):**

```json
{ "product": "WHITE HANGING HEART T-LIGHT HOLDER" }
// or with manual override:
{ "product": "85123A", "current_stock": 100 }
```

**Answer from the server (includes `stock_source`):**

```json
{
  "stock_code": "85123A",
  "next_week": "2011-12-12",
  "predicted_demand": 600,
  "current_stock": 802,
  "risk": "MEDIUM RISK",
  "product_name": "WHITE HANGING HEART T-LIGHT HOLDER",
  "stock_source": "live"
}
```

`stock_source` values: `"live"` (auto-fetched), `"manual"` (user provided), `"fallback"` (provider error, defaulted to 0)

**When a name matches several products (status 409):**

```json
{
  "error": "More than one product matches. Please pick one.",
  "matches": [
    { "code": "18094C", "name": "WHITE AND BLUE CERAMIC OIL BURNER" },
    { "code": "18097C", "name": "WHITE TALL PORCELAIN T-LIGHT HOLDER" }
  ]
}
```

### Routes (addresses) in the server

| Address | Method | Purpose |
|---|---|---|
| `/` | GET | Shows the web page |
| `/products?q=text` | GET | Returns up to 10 products whose name or code matches the text |
| `/predict` | POST | Returns the prediction for one product (name or code) — `current_stock` now optional |
| `/forecasts` | GET | Returns the next-week forecast for every product with live stock (used by the dashboard) |
| `/history/:code` | GET | Returns the past 54 weeks of one product, with its forecast (used by the chart) |
| `/metrics` | GET | Returns the model's accuracy and a data summary |
| `/health` | GET | Checks that the server is running |
| `/stock/health` | GET | Checks stock provider connectivity |
| `/stock/bulk` | GET | Returns live stock for all products (or `?codes=CODE1,CODE2`) |
| `/stock/:code` | GET | Returns live stock for a single product |
| `/gemini/health` | GET | Checks Gemini AI connectivity |
| `/explain` | POST | Generates AI explanation for a forecast |

### How name search works

- Each word you type must match the **start of a word** in the product name. So `wh` finds `WHITE...`, and `hanging heart` finds `WHITE HANGING HEART...`.
- Names that start with what you typed are listed first.
- Capital letters don't matter.
- Codes also work in the search box.

---

## 5. What changed from the previous version

1. **Search by product name.** The box now finds products by name, and codes still work.
2. **Product names added.** `data/products.json` holds 3,775 named products from the sheet's Description column.
3. **Model retrained on all products.** The sample of 100 products became all 3,803 product codes from the Online Retail sheet. The model is trained on the same 10 features as before.
4. **Stock codes are case-insensitive.** The sheet has codes like `85123a` and `85123A` for the same product, so they are merged.
5. **Better accuracy check.** On the last 8 weeks, which the model never saw during training, the error is 28.2 units on average. A simple 4-week average gives 30.0 units.
6. **Clicking a product predicts it.** No code has to be typed.
7. **Ambiguous names are handled.** If a name matches several products, the page asks you to pick one.

### Data rules used when rebuilding from the sheet

- Only real sales are counted: rows with positive quantity and positive price. Returns, cancellations, and zero-price rows are left out.
- Weeks start on Monday.
- Weeks with no sales are counted as 0 units, and the unit price carries forward from the nearest week with a price.
- Fees, postage, discounts, bank charges, samples, and gift vouchers are not treated as products.
- When checked against your original 100-product file, the rebuilt history matches on every row.

---

## 6. Retraining or rebuilding the data

The `scripts/retrain.py` script rebuilds all three data files from the Excel sheet, retrains the model, and writes the results to `data/`.

```bash
pip install pandas openpyxl scikit-learn numpy
python scripts/retrain.py path/to/Online_Retail.xlsx
```

It prints the test error at the end. Then restart the server with `npm start`.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `npm: command not found` | Install Node.js from https://nodejs.org and open a new terminal. |
| `Error: Cannot find module 'express'` | Run `npm install` first. |
| `EADDRINUSE` (port already in use) | Run `PORT=4000 npm start` and open http://localhost:4000. |
| "Could not reach the server" | Make sure `npm start` is still running. |
| No suggestions appear | Make sure the server is running, then type at least one letter. |
| "No product matches" | Check the spelling, or try fewer words. |
| Changes to the page don't show up | Refresh the browser with `Ctrl + F5`. |

---

## 8. Folder structure

```
sdc-project-node/
├── server.js                  # Starts the server and defines the routes
├── package.json               # Project info, scripts, and the Express library
├── lib/
│   ├── forecast.js            # Builds the features, runs the model, applies the risk rules
│   └── products.js            # Name search and product resolution
├── data/
│   ├── weekly_history.csv     # Weekly demand and unit price per product
│   ├── metrics.json           # Model accuracy and data summary
│   ├── products.json          # Product codes and names
│   └── model_trees.json       # The trained model
├── public/
│   ├── index.html             # The web page (dashboard and product search)
│   ├── css/index.css          # Styles and colours (colours are at the top)
│   └── js/index.js            # Search box, selection and prediction in the browser
├── tests/
│   ├── forecast.test.js       # Prediction tests
│   ├── products.test.js       # Name search tests
│   └── fixtures.json          # Reference predictions from the scikit-learn model
└── scripts/
    └── retrain.py             # Rebuilds the data and retrains the model from the Excel sheet
```
