@echo off
:: NMS-Tool Windows Startup Script
:: Usage:
::   start.bat         — start NMS-Tool
::   start.bat install — first-time setup

setlocal enabledelayedexpansion
cd /d "%~dp0.."
set ROOT=%cd%

set MODE=%1
if "%MODE%"=="" set MODE=run

:: Colors via ANSI (Windows 10+)
echo.

if "%MODE%"=="install" (
    echo [NMS] Creating Python virtual environment...
    python -m venv venv
    if errorlevel 1 ( echo [ERROR] Python not found. Install Python 3.10+ from python.org & pause & exit /b 1 )

    echo [NMS] Installing Python dependencies...
    venv\Scripts\pip install -r requirements.txt -q
    if errorlevel 1 ( echo [ERROR] pip install failed & pause & exit /b 1 )

    echo [NMS] Installing Node.js frontend...
    cd frontend && npm install && cd ..
    if errorlevel 1 ( echo [ERROR] npm install failed. Install Node.js from nodejs.org & pause & exit /b 1 )

    if not exist .env copy .env.example .env

    mkdir data\mibs 2>nul

    echo.
    echo [NMS] Setup complete!
    echo [NMS] Run start.bat to launch NMS-Tool
    pause
    exit /b 0
)

:: Check venv
if not exist "venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found.
    echo Run: scripts\start.bat install
    pause
    exit /b 1
)

if not exist ".env" copy ".env.example" ".env"
mkdir data\mibs 2>nul

:: Build frontend if needed
if not exist "frontend\dist\index.html" (
    echo [NMS] Building frontend...
    cd frontend && npm run build && cd ..
)

echo [NMS] Starting NMS-Tool...
start "NMS-Tool Backend" /min venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8765

:: Wait for backend
echo [NMS] Waiting for backend...
set /a tries=0
:WAIT_LOOP
set /a tries+=1
if !tries! gtr 30 (
    echo [ERROR] Backend failed to start. Check data\nms.log
    pause
    exit /b 1
)
curl -s http://127.0.0.1:8765/api/v1/ping >nul 2>&1
if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto WAIT_LOOP
)

echo.
echo ==========================================
echo   NMS-Tool is running!
echo   Open: http://localhost:8765
echo   Login: admin / admin
echo ==========================================
echo.

start http://localhost:8765
echo Press any key to stop NMS-Tool...
pause >nul

taskkill /f /fi "windowtitle eq NMS-Tool Backend*" >nul 2>&1
echo NMS-Tool stopped.
