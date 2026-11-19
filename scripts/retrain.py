"""
Rebuilds the project data from the raw Online Retail sheet and retrains the model.

Writes:
  data/weekly_history.csv   weekly demand and unit price for every product code
  data/products.json        product code -> product name (for the search box)
  data/model_trees.json     the trained model, used by the Node server

Usage (run from the project folder):
  pip install pandas openpyxl scikit-learn numpy joblib
  python scripts/retrain.py path/to/Online_Retail.xlsx
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Stock codes that are fees, postage, adjustments and samples, not products
NON_PRODUCT_CODES = {
    "AMAZONFEE", "B", "BANK CHARGES", "C2", "CRUK", "D", "DOT",
    "M", "m", "PADS", "POST", "S",
}

FEATURES = [
    "lag_1", "lag_2", "lag_3", "lag_4",
    "rolling_mean_4", "rolling_std_4", "rolling_mean_8",
    "month", "week_of_year", "UnitPrice",
]
MIN_HISTORY_WEEKS = 8  # the same rule the server uses


def is_product(code):
    return code not in NON_PRODUCT_CODES and not code.startswith("gift_")


def load_sheet(xlsx_path):
    print("Reading the Excel sheet (this can take a minute)...")
    df = pd.read_excel(xlsx_path, dtype={"StockCode": str})
    # Codes are case-insensitive in the sheet ("85123a" and "85123A" are the same product)
    df["StockCode"] = df["StockCode"].str.strip().str.upper()
    df = df[df["StockCode"].map(is_product)].copy()
    # Weeks start on Monday, the same as the original weekly history
    df["Week"] = df["InvoiceDate"].dt.to_period("W-SUN").dt.start_time
    return df


def build_names(df):
    """Most common product name per code. Only all-capital descriptions count
    as names (this skips things like 'ebay' and 'Manual')."""
    d = df.dropna(subset=["Description"]).copy()
    d["Description"] = d["Description"].str.strip()
    d = d[(d["Description"] != "") & (d["Description"] == d["Description"].str.upper())]
    counts = (d.groupby(["StockCode", "Description"]).size()
                .reset_index(name="n")
                .sort_values(["StockCode", "n"], ascending=[True, False])
                .drop_duplicates("StockCode"))
    return dict(zip(counts["StockCode"], counts["Description"]))


def build_weekly_table(df):
    """One row per product per week, including weeks with no sales (demand 0)."""
    # Only real sales count: positive quantity and positive price
    sales = df[(df["Quantity"] > 0) & (df["UnitPrice"] > 0)]
    weekly = (sales.groupby(["StockCode", "Week"])
                   .agg(Demand=("Quantity", "sum"), UnitPrice=("UnitPrice", "mean"))
                   .reset_index())

    weeks = pd.date_range(df["Week"].min(), df["Week"].max(), freq="W-MON")
    codes = sorted(weekly["StockCode"].unique())
    grid = pd.MultiIndex.from_product([codes, weeks], names=["StockCode", "Week"]).to_frame(index=False)
    table = grid.merge(weekly, on=["StockCode", "Week"], how="left")
    table["Demand"] = table["Demand"].fillna(0.0)
    # Weeks with no sales keep the last known price (then the next known price)
    table = table.sort_values(["StockCode", "Week"])
    table["UnitPrice"] = table.groupby("StockCode")["UnitPrice"].transform(lambda s: s.ffill().bfill())
    return table.reset_index(drop=True)


def make_training_rows(table):
    """Each row: features from the weeks BEFORE a target week, target = that week's demand.
    This matches how the server predicts: it only looks at past weeks."""
    rows = []
    for code, group in table.groupby("StockCode", sort=False):
        demand = group["Demand"].to_numpy()
        price = group["UnitPrice"].to_numpy()
        weeks = group["Week"].to_numpy()
        for t in range(MIN_HISTORY_WEEKS, len(demand)):
            past = demand[t - MIN_HISTORY_WEEKS:t]
            target_week = pd.Timestamp(weeks[t])
            rows.append({
                "StockCode": code,
                "Week": target_week,
                "lag_1": past[-1], "lag_2": past[-2], "lag_3": past[-3], "lag_4": past[-4],
                "rolling_mean_4": past[-4:].mean(),
                "rolling_std_4": past[-4:].std(ddof=1),
                "rolling_mean_8": past.mean(),
                "month": target_week.month,
                "week_of_year": int(target_week.isocalendar().week),
                "UnitPrice": price[t - 1],
                "Demand": demand[t],
            })
    return pd.DataFrame(rows)


def export_model(model, path):
    trees = []
    for predictors in model._predictors:
        trees.append([
            {
                "leaf": bool(n["is_leaf"]),
                "v": float(n["value"]),
                "f": int(n["feature_idx"]),
                "t": float(n["num_threshold"]),
                "miss_left": bool(n["missing_go_to_left"]),
                "l": int(n["left"]),
                "r": int(n["right"]),
            }
            for n in predictors[0].nodes
        ])
    out = {
        "features": FEATURES,
        "baseline": float(model._baseline_prediction[0][0]),
        "trees": trees,
    }
    path.write_text(json.dumps(out, separators=(",", ":")))


def new_model():
    # Same tree settings as the original model. The loss is absolute error,
    # which matches the MAE we measure (it scored better than squared error on the test weeks).
    return HistGradientBoostingRegressor(loss="absolute_error", learning_rate=0.05,
                                         max_depth=5, max_iter=150, random_state=42)


def main():
    if len(sys.argv) < 2:
        sys.exit("Usage: python scripts/retrain.py path/to/Online_Retail.xlsx")

    df = load_sheet(sys.argv[1])
    names = build_names(df)
    table = build_weekly_table(df)
    print(f"Products: {table['StockCode'].nunique()}  (with names: {sum(c in names for c in table['StockCode'].unique())})")
    print(f"Weeks: {table['Week'].nunique()}  Rows: {len(table)}")

    # Save the data files the server uses
    DATA.mkdir(exist_ok=True)
    out = table.copy()
    out["Week"] = out["Week"].dt.strftime("%Y-%m-%d")
    out.to_csv(DATA / "weekly_history.csv", index=False, float_format="%.10g")
    products = [{"code": c, "name": names[c]} for c in sorted(names) if c in set(table["StockCode"])]
    (DATA / "products.json").write_text(json.dumps({"products": products}, ensure_ascii=False, indent=1))
    print(f"Wrote data/weekly_history.csv and data/products.json ({len(products)} named products)")

    # Build training rows and evaluate on the last 8 weeks (never seen in training)
    train_rows = make_training_rows(table)
    cutoff = sorted(train_rows["Week"].unique())[-8]
    train = train_rows[train_rows["Week"] < cutoff]
    test = train_rows[train_rows["Week"] >= cutoff]
    print(f"Training rows: {len(train)}   Test rows (last 8 weeks): {len(test)}")

    model = new_model().fit(train[FEATURES], train["Demand"])
    pred = np.maximum(model.predict(test[FEATURES]), 0)
    mae = np.mean(np.abs(pred - test["Demand"]))
    baseline_mae = np.mean(np.abs(test["rolling_mean_4"] - test["Demand"]))
    print(f"Test MAE, model: {mae:.2f} units   simple 4-week average: {baseline_mae:.2f} units")
    metrics = {
        "mae_model": round(float(mae), 2),
        "mae_4week_average": round(float(baseline_mae), 2),
        "test_weeks": 8,
        "data_from": table["Week"].min().strftime("%Y-%m-%d"),
        "data_to": table["Week"].max().strftime("%Y-%m-%d"),
        "products": int(table["StockCode"].nunique()),
        "products_named": len(products),
        "trained_on": pd.Timestamp.now().strftime("%Y-%m-%d"),
    }
    (DATA / "metrics.json").write_text(json.dumps(metrics, indent=2))

    # Final model uses all the data
    final = new_model().fit(train_rows[FEATURES], train_rows["Demand"])
    export_model(final, DATA / "model_trees.json")
    print("Wrote data/model_trees.json")


if __name__ == "__main__":
    main()
