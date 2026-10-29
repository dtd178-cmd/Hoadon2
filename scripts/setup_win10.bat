@echo off
chcp 65001 >nul
title VNInvoice OCR - Cai dat Moi truong Windows 10 (Python 3.10 + PaddleOCR CPU)

echo ============================================================================
echo   CAI DAT MAY CHU DOC HOA DON PDF BANG PADDLEOCR TREN WINDOWS 10 (64-BIT)
echo ============================================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [LOI] Khong tim thay Python trong PATH!
    echo Vui long cai dat Python 3.10.11 (64-bit) tu https://www.python.org/downloads/release/python-31011/
    echo va tich chon "Add Python 3.10 to PATH" khi cai dat.
    pause
    exit /b 1
)

python --version
echo.

if not exist ".venv" (
    echo [1/4] Dang tao moi truong ao Python (.venv)...
    python -m venv .venv
) else (
    echo [1/4] Moi truong ao .venv da ton tai.
)

call .venv\Scripts\activate.bat

echo [2/4] Dang nang cap pip, setuptools, wheel...
python -m pip install --upgrade pip setuptools wheel

echo [3/4] Dang cai dat cac thu vien tu backend\requirements.txt...
python -m pip install -r backend\requirements.txt

if not exist "backend\.env" (
    echo [4/4] Dang khoi tao file cau hinh backend\.env tu backend\.env.example...
    copy backend\.env.example backend\.env >nul
)

echo.
echo [KIEM TRA] Dang kiem tra thu vien PaddleOCR, PyMuPDF va openpyxl...
python -c "import fitz, openpyxl, fastapi, paddle, paddleocr; print('OK: Tat ca thu vien da san sang! Paddle version:', paddle.__version__)"

echo.
echo ============================================================================
echo   HOAN TAT CAI DAT! Hay chay scripts\start_server_win10.bat de khoi dong.
echo ============================================================================
pause
