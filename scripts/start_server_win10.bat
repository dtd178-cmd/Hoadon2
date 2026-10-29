@echo off
chcp 65001 >nul
title VNInvoice OCR Server - Running on Port 8000 (Windows 10)

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
echo May chu dang chay tai: http://127.0.0.1:8000
echo Endpoint kiem tra:     http://127.0.0.1:8000/api/health
echo Nhan Ctrl+C hoac chay scripts\stop_server_win10.bat de dung may chu.
echo ============================================================================
echo.

python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1
pause
