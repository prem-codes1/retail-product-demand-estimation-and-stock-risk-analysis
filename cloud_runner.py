"""Cloud 24/7 Runner for Retail Stockout Risk API.
Starts FastAPI server on port 8000 and tunnels through ngrok using your permanent static domain:
https://platter-unworried-securely.ngrok-free.dev
"""

import os
import sys
import time
import threading
import uvicorn
from pyngrok import ngrok, conf

# Configuration
PORT = int(os.environ.get("PORT", 8000))
NGROK_AUTHTOKEN = os.environ.get(
    "NGROK_AUTHTOKEN",
    "3MMIOfliTfuPebDbUfHNQeRYPdA_6eUfwRZSMaKpxZ4F51kxJ"
)
NGROK_DOMAIN = os.environ.get(
    "NGROK_DOMAIN",
    "platter-unworried-securely.ngrok-free.dev"
)

def run_api():
    print(f"[Cloud Runner] Starting Uvicorn on 127.0.0.1:{PORT}...")
    uvicorn.run("main:app", host="127.0.0.1", port=PORT, log_level="info")

def main():
    print("=" * 65)
    print("🚀 Initializing 24/7 Cloud ML API & ngrok Tunnel")
    print("=" * 65)

    # 1. Start FastAPI in daemon background thread
    server_thread = threading.Thread(target=run_api, daemon=True)
    server_thread.start()
    time.sleep(2)

    # 2. Configure ngrok authtoken
    try:
        ngrok.set_auth_token(NGROK_AUTHTOKEN)
        print("✅ ngrok authtoken configured.")
    except Exception as e:
        print(f"ℹ️ ngrok config note: {e}")

    # 3. Kill existing local tunnels to avoid conflict
    try:
        ngrok.kill()
    except Exception:
        pass

    # 4. Open tunnel on reserved static domain
    print(f"[Cloud Runner] Connecting ngrok tunnel to domain: {NGROK_DOMAIN}...")
    try:
        tunnel = ngrok.connect(PORT, domain=NGROK_DOMAIN)
        public_url = tunnel.public_url
    except Exception as err:
        print(f"⚠️ Domain bind error: {err}")
        print("Falling back to standard ngrok tunnel...")
        tunnel = ngrok.connect(PORT)
        public_url = tunnel.public_url

    print("=" * 65)
    print("🎉 SERVER IS LIVE!")
    print(f"👉 Public Swagger Docs:  {public_url}/docs")
    print(f"👉 Public Health Check:  {public_url}/health")
    print(f"👉 Public ML Predict:    {public_url}/predict")
    print("=" * 65)

    # 5. Keep alive
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping server...")
        ngrok.kill()
        sys.exit(0)

if __name__ == "__main__":
    main()
