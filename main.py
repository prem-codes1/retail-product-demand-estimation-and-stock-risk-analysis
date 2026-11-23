"""FastAPI Service for Retail Stockout Risk Prediction Model.
Conforms to academic lab standard:
  - Root: GET /
  - Swagger Docs: GET /docs
  - Health check: GET /health
  - Prediction: POST /predict
  - Explainability: POST /explain
Runs on port 8000 by default (uvicorn main:app --reload).
Connects to MongoDB with fallback to local JSON/CSV data files.
"""

import os
import re
import json
import math
import urllib.request
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"

app = FastAPI(
    title="Stockout Risk & Demand Forecast API",
    description="Machine Learning API for Retail Demand Estimation, Stockout Risk Analysis, and Gemini Explainability",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if PUBLIC_DIR.exists():
    if (PUBLIC_DIR / "css").exists():
        app.mount("/css", StaticFiles(directory=str(PUBLIC_DIR / "css")), name="css")
    if (PUBLIC_DIR / "js").exists():
        app.mount("/js", StaticFiles(directory=str(PUBLIC_DIR / "js")), name="js")


DATA_DIR = Path(__file__).parent / "data"
MONGO_URI = os.getenv("MONGODB_URI", "mongodb://127.0.0.1:27017")
DB_NAME = os.getenv("MONGODB_DB_NAME", "stockout_predictor")

# Global state
db_client = None
db = None
mongo_connected = False
products_map: Dict[str, str] = {}  # code -> name
products_list: List[Dict[str, str]] = []
history_by_code: Dict[str, List[Dict[str, Any]]] = {}
model_data: Dict[str, Any] = {}
metrics_data: Dict[str, Any] = {}


def load_local_data():
    global products_map, products_list, model_data, metrics_data, history_by_code

    # 1. Model
    model_path = DATA_DIR / "model_trees.json"
    if model_path.exists():
        with open(model_path, "r", encoding="utf-8") as f:
            model_data = json.load(f)

    # 2. Products
    products_path = DATA_DIR / "products.json"
    if products_path.exists():
        with open(products_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
            p_items = raw.get("products", raw) if isinstance(raw, dict) else raw
            products_list = p_items
            products_map = {p["code"]: p["name"] for p in p_items}

    # 3. Metrics
    metrics_path = DATA_DIR / "metrics.json"
    if metrics_path.exists():
        with open(metrics_path, "r", encoding="utf-8") as f:
            metrics_data = json.load(f)

    # 4. History (CSV load if mongo down)
    history_path = DATA_DIR / "weekly_history.csv"
    if history_path.exists() and not history_by_code:
        try:
            import csv
            with open(history_path, mode="r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    c = row.get("StockCode", "").strip().upper()
                    if c not in history_by_code:
                        history_by_code[c] = []
                    history_by_code[c].append({
                        "week": row["Week"],
                        "demand": float(row.get("Demand", 0)),
                        "unitPrice": float(row.get("UnitPrice", 0.0))
                    })
            print(f"[FastAPI] Loaded history for {len(history_by_code)} products from CSV")
        except Exception as e:
            print(f"[FastAPI] CSV history load error: {e}")



@app.on_event("startup")
def startup_db():
    global db_client, db, mongo_connected, products_map, products_list, model_data, metrics_data, history_by_code
    try:
        db_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=2000)
        db_client.admin.command("ping")
        db = db_client[DB_NAME]
        mongo_connected = True
        print(f"[FastAPI] Connected to MongoDB ({DB_NAME})")

        # Load products from Mongo
        p_docs = list(db.products.find({}, {"_id": 0}))
        if p_docs:
            products_list = p_docs
            products_map = {p["code"]: p["name"] for p in p_docs}

        # Load model from Mongo
        m_doc = db.models.find_one({"active": True}, {"_id": 0})
        if m_doc:
            model_data = {
                "features": m_doc["features"],
                "baseline": m_doc["baseline"],
                "trees": m_doc["trees"],
            }

        # Load metrics
        met_doc = db.metrics.find_one({}, {"_id": 0})
        if met_doc:
            metrics_data = met_doc

    except Exception as e:
        mongo_connected = False
        print(f"[FastAPI] MongoDB offline ({e}). Using local file fallback.")
        load_local_data()

    if not model_data or not products_map:
        load_local_data()


# ---------------- Pydantic Schemas ----------------
class PredictRequest(BaseModel):
    product: Optional[str] = Field("21212", example="21212", description="Product StockCode or name")
    current_stock: Optional[float] = Field(None, example=400, description="Units currently in warehouse (optional: defaults to live/simulated stock)")
    lag_1: Optional[float] = None
    lag_2: Optional[float] = None
    lag_3: Optional[float] = None
    lag_4: Optional[float] = None
    rolling_mean_4: Optional[float] = None
    rolling_std_4: Optional[float] = None
    rolling_mean_8: Optional[float] = None
    month: Optional[int] = None
    week_of_year: Optional[int] = None
    UnitPrice: Optional[float] = None

    model_config = {
        "json_schema_extra": {
            "example": {
                "product": "21212",
                "current_stock": 400
            }
        }
    }


class PredictResponse(BaseModel):
    stock_code: str
    product_name: Optional[str]
    next_week: str
    predicted_demand: float
    current_stock: float
    risk: str
    stock_source: str


class HealthResponse(BaseModel):
    status: str
    database: str
    products_available: int
    model_loaded: bool


# ---------------- ML Inference Logic ----------------
def get_product_history(code: str) -> List[Dict[str, Any]]:
    code_upper = code.upper().strip()
    if mongo_connected and db is not None:
        docs = list(db.weekly_history.find({"code": code_upper}, {"_id": 0}).sort("week", 1))
        if docs:
            return docs

    # Fallback to in-memory or CSV
    if code_upper in history_by_code:
        return history_by_code[code_upper]

    # Lazy-load from weekly_history.csv on demand when database is offline
    history_path = DATA_DIR / "weekly_history.csv"
    if history_path.exists():
        try:
            import csv
            matched_rows = []
            with open(history_path, mode="r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    if row.get("StockCode", "").strip().upper() == code_upper:
                        matched_rows.append({
                            "week": row["Week"],
                            "demand": float(row.get("Demand", 0)),
                            "unitPrice": float(row.get("UnitPrice", 0.0))
                        })
            if matched_rows:
                history_by_code[code_upper] = matched_rows
                return matched_rows
        except Exception as e:
            print(f"[FastAPI] CSV fallback read error: {e}")

    return []


def tree_predict(tree_nodes: list, features: list) -> float:
    node = tree_nodes[0]
    while not node.get("leaf", False):
        feat_idx = node["f"]
        val = features[feat_idx]
        go_left = node["miss_left"] if (val is None or math.isnan(val)) else (val <= node["t"])
        child_idx = node["l"] if go_left else node["r"]
        node = tree_nodes[child_idx]
    return float(node["v"])


def predict_demand_for_features(features_dict: dict) -> float:
    feat_names = model_data.get("features", [])
    x = [features_dict.get(name, 0.0) for name in feat_names]
    total = float(model_data.get("baseline", 0.0))
    for tree in model_data.get("trees", []):
        total += tree_predict(tree, x)
    return max(0.0, total)


def calculate_features(rows: list, next_date: datetime) -> dict:
    demands = [float(r.get("demand", 0)) for r in rows]
    n = len(demands)
    last_4 = demands[-4:]
    mean_4 = sum(last_4) / 4.0
    mean_8 = sum(demands[-8:]) / min(8, n)

    variance = sum((d - mean_4) ** 2 for d in last_4) / 3.0 if len(last_4) > 1 else 0.0
    std_4 = math.sqrt(variance)

    cal = next_date.isocalendar()
    return {
        "lag_1": demands[n - 1] if n >= 1 else 0.0,
        "lag_2": demands[n - 2] if n >= 2 else 0.0,
        "lag_3": demands[n - 3] if n >= 3 else 0.0,
        "lag_4": demands[n - 4] if n >= 4 else 0.0,
        "rolling_mean_4": mean_4,
        "rolling_std_4": std_4,
        "rolling_mean_8": mean_8,
        "month": next_date.month,
        "week_of_year": cal[1],
        "UnitPrice": float(rows[-1].get("unitPrice", 0.0)),
    }


def compute_risk(stock: float, predicted: float) -> str:
    if stock < predicted:
        return "HIGH RISK"
    if stock < 1.5 * predicted:
        return "MEDIUM RISK"
    return "LOW RISK"


# ---------------- API Endpoints ----------------
@app.get("/", summary="Stockout Risk Dashboard Frontend")
def read_root():
    index_file = PUBLIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {
        "message": "Retail Product Demand Estimation & Stock Risk API is online",
        "documentation": "/docs",
        "health": "/health",
    }


@app.get("/health", response_model=HealthResponse, summary="Health Check")
def health_check():
    return {
        "status": "ok",
        "database": "mongodb" if mongo_connected else "local_fallback",
        "products_available": len(products_map),
        "model_loaded": len(model_data.get("trees", [])) > 0,
    }


@app.post("/predict", response_model=PredictResponse, summary="Predict Stockout Risk")
def predict(req: PredictRequest):
    query = req.product.strip()
    code = None

    # Check if exact code
    if query.upper() in products_map:
        code = query.upper()
    else:
        # Match by name
        q_lower = query.lower()
        for p_code, p_name in products_map.items():
            if q_lower == p_name.lower():
                code = p_code
                break

    if not code:
        # Partial match
        matches = [c for c, name in products_map.items() if query.lower() in name.lower() or query.upper() in c]
        if not matches:
            raise HTTPException(status_code=404, detail=f"Product '{query}' not found.")
        code = matches[0]

    # Check if raw features are provided directly in payload (e.g. from Postman test payload)
    if req.lag_1 is not None and req.rolling_mean_4 is not None:
        features = {
            "lag_1": float(req.lag_1),
            "lag_2": float(req.lag_2 if req.lag_2 is not None else req.lag_1),
            "lag_3": float(req.lag_3 if req.lag_3 is not None else req.lag_1),
            "lag_4": float(req.lag_4 if req.lag_4 is not None else req.lag_1),
            "rolling_mean_4": float(req.rolling_mean_4),
            "rolling_std_4": float(req.rolling_std_4 if req.rolling_std_4 is not None else 0.0),
            "rolling_mean_8": float(req.rolling_mean_8 if req.rolling_mean_8 is not None else req.rolling_mean_4),
            "month": int(req.month if req.month is not None else 12),
            "week_of_year": int(req.week_of_year if req.week_of_year is not None else 50),
            "UnitPrice": float(req.UnitPrice if req.UnitPrice is not None else 2.5),
        }
        predicted_demand = round(predict_demand_for_features(features), 1)
        next_dt = datetime.now(timezone.utc)
    else:
        rows = get_product_history(code)
        if not rows or len(rows) < 8:
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient historical data for product '{code}' to generate forecast.",
            )

        # Calculate next week date
        last_week = rows[-1]["week"]
        if isinstance(last_week, str):
            last_dt = datetime.fromisoformat(last_week.replace("Z", "+00:00"))
        elif isinstance(last_week, (int, float)):
            last_dt = datetime.fromtimestamp(last_week / 1000.0, tz=timezone.utc)
        else:
            last_dt = last_week

        next_dt = datetime.fromtimestamp(last_dt.timestamp() + 7 * 86400, tz=timezone.utc)
        features = calculate_features(rows, next_dt)
        predicted_demand = round(predict_demand_for_features(features), 1)

    # Stock determination
    if req.current_stock is not None and req.current_stock >= 0:
        current_stock = float(req.current_stock)
        stock_source = "manual"
    else:
        # Simulated live stock deterministic hash
        code_hash = abs(hash(code)) % 1000 / 1000.0
        current_stock = round(predicted_demand * (0.5 + code_hash * 1.5))
        stock_source = "live"

    risk = compute_risk(current_stock, predicted_demand)

    return {
        "stock_code": code,
        "product_name": products_map.get(code, code),
        "next_week": next_dt.strftime("%Y-%m-%d"),
        "predicted_demand": predicted_demand,
        "current_stock": current_stock,
        "risk": risk,
        "stock_source": stock_source,
    }


@app.get("/products", summary="List All Products or Search Suggestions")
def get_products(q: Optional[str] = Query(None, description="Search term")):
    if q and q.strip():
        term = q.strip().lower()
        exact_prefix = []
        substring_match = []
        for p in products_list:
            code = str(p.get("code", "")).lower()
            name = str(p.get("name", "")).lower()
            if code.startswith(term) or name.startswith(term):
                exact_prefix.append(p)
                if len(exact_prefix) >= 15:
                    break
            elif term in code or term in name:
                substring_match.append(p)
        combined = (exact_prefix + substring_match)[:15]
        return {"products": combined}
    return {"products": products_list}


@app.get("/model", summary="Get Active Model Configuration")
def get_model():
    if not model_data or not model_data.get("trees"):
        raise HTTPException(status_code=404, detail="Model data not loaded")
    return model_data


@app.get("/metrics", summary="Get Model Performance Metrics")
def get_metrics():
    if not metrics_data:
        raise HTTPException(status_code=404, detail="Metrics not loaded")
    return metrics_data


forecast_cache = None


@app.get("/forecasts", summary="All Product Forecasts for Dashboard")
def get_forecasts():
    global forecast_cache
    if not forecast_cache:
        forecast_cache = []
        codes = list(history_by_code.keys())[:120]
        for c in codes:
            rows = history_by_code[c]
            if len(rows) >= 4:
                last_week = rows[-1]["week"]
                if isinstance(last_week, str):
                    last_dt = datetime.fromisoformat(last_week.replace("Z", "+00:00"))
                elif isinstance(last_week, (int, float)):
                    last_dt = datetime.fromtimestamp(last_week / 1000.0, tz=timezone.utc)
                else:
                    last_dt = last_week
                next_dt = datetime.fromtimestamp(last_dt.timestamp() + 7 * 86400, tz=timezone.utc)
                feat = calculate_features(rows, next_dt)
                pred = round(predict_demand_for_features(feat), 1)
                forecast_cache.append({
                    "code": c,
                    "name": products_map.get(c, c),
                    "predicted_demand": pred,
                    "next_week": next_dt.strftime("%Y-%m-%d"),
                })
        forecast_cache.sort(key=lambda x: x["predicted_demand"], reverse=True)
    return {"forecasts": forecast_cache}


@app.get("/stock/bulk", summary="Bulk Warehouse Stock Levels")
def get_stock_bulk():
    stock = {}
    for code in history_by_code.keys():
        code_hash = abs(hash(code)) % 1000 / 1000.0
        stock[code] = int(20 + code_hash * 250)
    return {"stock": stock, "source": "live", "count": len(stock)}


@app.get("/stock/{code}", summary="Single Product Stock Level")
def get_stock_single(code: str):
    code_upper = code.upper().strip()
    code_hash = abs(hash(code_upper)) % 1000 / 1000.0
    return {"code": code_upper, "stock": int(20 + code_hash * 250), "source": "live"}


def call_gemini_api(product_name: str, code: str, forecast: dict, features: dict, history: list) -> Optional[dict]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None
    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

    pred = float(forecast.get("predicted_demand", 0))
    stock = float(forecast.get("current_stock", 0))
    risk = forecast.get("risk", "MEDIUM")
    next_week = forecast.get("next_week", "next week")

    recent_history = [w.get("demand", 0) for w in history[-12:]] if history else []
    history_str = ", ".join(str(int(d)) for d in recent_history) or "N/A"

    prompt = f"""You are a supply chain analyst. Explain this demand forecast in plain English for a warehouse manager.

PRODUCT: {product_name} ({code})
FORECAST WEEK: {next_week}
PREDICTED DEMAND: {pred:.1f} units
CURRENT STOCK: {stock:.0f} units
RISK LEVEL: {risk}

KEY METRICS:
- Recent 4-week average: {features.get('rolling_mean_4', pred):.1f} units
- 8-week baseline average: {features.get('rolling_mean_8', pred):.1f} units
- Demand volatility std dev: {features.get('rolling_std_4', 0):.1f}
- Unit price: ${features.get('UnitPrice', 0):.2f}

RECENT HISTORY: {history_str} units

INSTRUCTIONS:
- Write 3-4 sentences maximum
- Focus on actionable insights: why this forecast, what to watch
- Avoid technical ML jargon (no "features", "model", "trees")
- Output raw JSON only without markdown formatting.

OUTPUT FORMAT:
{{
  "summary": "One-sentence executive summary of the forecast",
  "drivers": ["Specific driver 1", "Specific driver 2", "Specific driver 3"],
  "risks": ["Risk factor 1", "Risk factor 2"],
  "confidence": "HIGH|MEDIUM|LOW"
}}"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    req_body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}]
    }).encode("utf-8")

    req = urllib.request.Request(url, data=req_body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            m = re.search(r"\{[\s\S]*\}", text)
            if m:
                parsed = json.loads(m.group(0))
                if "summary" in parsed:
                    parsed["source"] = "gemini"
                    parsed["model"] = model
                    if not isinstance(parsed.get("drivers"), list):
                        parsed["drivers"] = [str(parsed.get("drivers", ""))]
                    if not isinstance(parsed.get("risks"), list):
                        parsed["risks"] = [str(parsed.get("risks", ""))]
                    return parsed
    except Exception as e:
        print(f"[FastAPI] Gemini request error: {e}")
    return None


def generate_analytical_explanation(code: str, name: str, forecast: dict, features: dict, history: list) -> dict:
    pred = round(float(forecast.get("predicted_demand", 0)), 1)
    stock = float(forecast.get("current_stock", 0))
    risk = forecast.get("risk", "LOW" if stock >= pred * 1.5 else "HIGH" if stock < pred else "MEDIUM")
    next_week = forecast.get("next_week", "next week")

    r4 = float(features.get("rolling_mean_4", pred))
    r8 = float(features.get("rolling_mean_8", pred))
    trend = "rising" if r4 > r8 + 2 else "falling" if r4 < r8 - 2 else "stable"
    std4 = float(features.get("rolling_std_4", 0))
    volatility = "high" if std4 > 5 else "low"

    summary = f"Expected demand for {name} is projected at {pred} units for week {next_week}, driven by {trend} recent sales velocity."
    drivers = [
        f"4-week recent sales average of {round(r4, 1)} units/week ({trend} trend relative to 8-week baseline of {round(r8, 1)} units)",
        f"Short-term purchasing velocity exhibits {volatility} volatility (std dev ±{round(std4, 1)} units)",
        f"Warehouse stock is currently at {int(stock)} units (stockout risk: {risk})"
    ]
    risks = [
        "Unanticipated bulk order spikes exceeding historical baseline",
        "Replenishment or supplier lead-time delays during active fulfillment"
    ]
    confidence = "HIGH" if abs(r4 - pred) < 10 else "MEDIUM"
    return {
        "summary": summary,
        "drivers": drivers,
        "risks": risks,
        "confidence": confidence,
        "source": "analytical_rules"
    }


@app.post("/explain", summary="Gemini Explainability Summary")
def explain_forecast(payload: dict):
    product = payload.get("product", "")
    code = str(product.get("code", "") if isinstance(product, dict) else product).upper().strip()
    name = products_map.get(code, code)
    if (not name or name == code) and isinstance(product, dict) and product.get("name"):
        name = product["name"]
    forecast = payload.get("forecast", {})
    features = payload.get("features", {})
    history = payload.get("history", [])

    explanation = None
    if os.getenv("GEMINI_API_KEY"):
        try:
            explanation = call_gemini_api(name, code, forecast, features, history)
        except Exception as e:
            print(f"[FastAPI] Gemini explain error: {e}")

    if not explanation:
        explanation = generate_analytical_explanation(code, name, forecast, features, history)

    return {"explanation": explanation}


@app.get("/history/{code}", summary="Get History for Specific Product")
def get_history(code: str):
    code_upper = code.upper().strip()
    rows = get_product_history(code_upper)
    if not rows:
        raise HTTPException(status_code=404, detail=f"No history found for product '{code}'")

    # Format weeks to match frontend expectations
    formatted_weeks = []
    for r in rows:
        formatted_weeks.append({
            "week": str(r.get("week", ""))[:10],
            "demand": float(r.get("demand", 0)),
            "unit_price": float(r.get("unitPrice", 0.0)),
        })

    last_week = rows[-1]["week"]
    if isinstance(last_week, str):
        last_dt = datetime.fromisoformat(last_week.replace("Z", "+00:00"))
    elif isinstance(last_week, (int, float)):
        last_dt = datetime.fromtimestamp(last_week / 1000.0, tz=timezone.utc)
    else:
        last_dt = last_week

    next_dt = datetime.fromtimestamp(last_dt.timestamp() + 7 * 86400, tz=timezone.utc)
    feat = calculate_features(rows, next_dt)
    pred = round(predict_demand_for_features(feat), 1)

    return {
        "code": code_upper,
        "name": products_map.get(code_upper, code_upper),
        "weeks": formatted_weeks,
        "forecast": {
            "predicted_demand": pred,
            "next_week": next_dt.strftime("%Y-%m-%d"),
        },
    }


