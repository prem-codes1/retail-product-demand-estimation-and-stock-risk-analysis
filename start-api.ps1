# PowerShell Helper to start FastAPI on Port 8000
Write-Host "Starting FastAPI server on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
& 'C:\Users\Prem\AppData\Local\Python\pythoncore-3.14-64\python.exe' -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
