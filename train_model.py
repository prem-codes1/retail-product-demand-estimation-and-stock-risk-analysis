"""Model Training Script for Retail Demand & Stockout Risk Prediction.
Reads data/weekly_history.csv, builds training features, trains a Gradient Boosting
regressor, and serializes the model to 'demand_model.pkl'.
Conforms to Step 3 of the SDC Lab Guide ("python train_model.py").
"""

import json
from pathlib import Path
import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import HistGradientBoostingRegressor

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
HISTORY_CSV = DATA_DIR / "weekly_history.csv"
MODEL_PKL = ROOT / "demand_model.pkl"

FEATURES = [
    "lag_1", "lag_2", "lag_3", "lag_4",
    "rolling_mean_4", "rolling_std_4", "rolling_mean_8",
    "month", "week_of_year", "UnitPrice",
]

def train_and_save():
    print(f"Loading history from {HISTORY_CSV}...")
    df = pd.read_csv(HISTORY_CSV)
    df["Week"] = pd.to_datetime(df["Week"])
    df = df.sort_values(["StockCode", "Week"]).reset_index(drop=True)

    rows = []
    print("Building lag and rolling features across all products...")
    for code, group in df.groupby("StockCode"):
        if len(group) < 8:
            continue
        g = group.copy().reset_index(drop=True)
        demands = g["Demand"].values
        prices = g["UnitPrice"].values
        weeks = g["Week"].dt

        for i in range(7, len(g)):
            cal = g["Week"].iloc[i].isocalendar()
            feat = {
                "lag_1": demands[i - 1],
                "lag_2": demands[i - 2],
                "lag_3": demands[i - 3],
                "lag_4": demands[i - 4],
                "rolling_mean_4": np.mean(demands[i - 4 : i]),
                "rolling_std_4": np.std(demands[i - 4 : i], ddof=1) if len(demands[i - 4 : i]) > 1 else 0.0,
                "rolling_mean_8": np.mean(demands[max(0, i - 8) : i]),
                "month": g["Week"].iloc[i].month,
                "week_of_year": cal[1],
                "UnitPrice": prices[i - 1],
                "target": demands[i],
            }
            rows.append(feat)

    data = pd.DataFrame(rows)
    X = data[FEATURES]
    y = data["target"]

    print(f"Training HistGradientBoostingRegressor on {len(X)} samples...")
    model = HistGradientBoostingRegressor(max_iter=100, random_state=42)
    model.fit(X, y)

    joblib.dump(model, MODEL_PKL)
    print(f"Model pipeline saved as {MODEL_PKL.name}")
    print(f"Done! {MODEL_PKL} is ready for FastAPI inference.")

if __name__ == "__main__":
    train_and_save()
