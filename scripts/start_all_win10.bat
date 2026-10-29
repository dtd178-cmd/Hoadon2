@echo off
chcp 65001 >nul
title VNInvoice OCR - Khoi dong ca Backend (FastAPI 8000) va Frontend (3000)

echo ============================================================================
echo   KHOI DONG TOAN BO HE THONG VNINVOICE OCR TREN WINDOWS 10
echo   - Backend Python FastAPI + PaddleOCR: http://127.0.0.1:8000
echo   - Frontend React + Express Gateway  : http://localhost:3000
echo ============================================================================

cd /d "%~dp0.."

if not exist ".venv\Scripts\activate.bat" (
    echo [LOI] Chua cai dat moi truong Python (.venv).
    echo Vui long chay scripts\setup_win10.bat truoc!
    pause
    exit /b 1
)

echo [1/2] Dang mo cua so chay Backend FastAPI + PaddleOCR (cong 8000)...
start "VNInvoice Backend (FastAPI + PaddleOCR)" cmd /k "scripts\start_server_win10.bat"

timeout /t 3 /nobreak >nul

echo [2/2] Dang khoi dong Giao dien Web Frontend (cong 3000)...
echo Sau khi khoi dong xong, hay mo trinh duyet tai: http://localhost:3000
npm run dev
pause
