# PowerShell Helper to start ngrok tunnel for FastAPI (Port 8000)
Write-Host "Starting ngrok tunnel forwarding to http://localhost:8000 ..." -ForegroundColor Green
Write-Host "NOTE: If this is your first time using ngrok, add your authtoken first:" -ForegroundColor Yellow
Write-Host ".\ngrok.exe config add-authtoken YOUR_AUTH_TOKEN" -ForegroundColor Yellow
Write-Host ""
.\ngrok.exe http 8000
