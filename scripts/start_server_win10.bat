@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
title VNInvoice OCR Server - Running on Port 8000 (Windows 10 Local & LAN)

echo ============================================================================
echo   KHOI DONG MAY CHU VNINVOICE OCR (FASTAPI + PADDLEOCR)
echo ============================================================================

cd /d "%~dp0.."

if not exist ".venv\Scripts\activate.bat" (
    echo [LOI] Chua tim thay moi truong ao .venv.
    echo Vui long chay scripts\setup_win10.bat truoc!
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat

if exist "backend\.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("backend\.env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
    )
)

echo.
echo May chu dang chay tai: http://127.0.0.1:8000 (truy cap cuc bo)
echo Lenh nghe mang LAN   : 0.0.0.0:8000 (cac may tinh trong cung mang LAN)
echo Endpoint kiem tra    : http://127.0.0.1:8000/api/health
echo Nhan Ctrl+C hoac chay scripts\stop_server_win10.bat de dung may chu.
echo ============================================================================
echo.

.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --workers 1
pause
