"""Cloud 24/7 Runner for Retail Stockout Risk API.
Starts FastAPI server on 0.0.0.0:$PORT and tunnels through ngrok using your permanent static domain:
https://platter-unworried-securely.ngrok-free.dev
Includes automatic keep-alive self-pinging every 8 minutes.
"""

import os
import sys
import time
import threading
import urllib.request
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
    print(f"[Cloud Runner] Starting Uvicorn on 0.0.0.0:{PORT}...")
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, log_level="info")

def start_self_pinger(public_url):
    """Background daemon thread to ping health check every 8 minutes to prevent idle sleep."""
    def ping_loop():
        time.sleep(30)  # Wait for initial boot
        while True:
            try:
                targets = [f"{public_url.rstrip('/')}/health"]
                render_url = os.environ.get("RENDER_EXTERNAL_URL")
                if render_url:
                    targets.append(f"{render_url.rstrip('/')}/health")

                for url in targets:
                    req = urllib.request.Request(
                        url,
                        headers={
                            "User-Agent": "Render-KeepAlive/1.0",
                            "ngrok-skip-browser-warning": "69420",
                            "Accept": "application/json",
                        }
                    )
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        print(f"⏰ [Keep-Alive] Pinged {url} -> HTTP {resp.status}")
            except Exception as e:
                print(f"⚠️ [Keep-Alive] Ping note: {e}")

            time.sleep(480)  # Ping every 8 minutes (Render sleeps at 15m)

    thread = threading.Thread(target=ping_loop, daemon=True)
    thread.start()
    print("⏰ [Keep-Alive] Internal 8-minute self-pinger initialized.")

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

    # 5. Start internal self-pinger
    start_self_pinger(public_url)

    # 6. Keep main process alive
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping server...")
        ngrok.kill()
        sys.exit(0)

if __name__ == "__main__":
    main()
