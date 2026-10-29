@echo off
chcp 65001 >nul
title VNInvoice OCR Server - Stop Server (Windows 10)

echo ============================================================================
echo   DUNG MAY CHU VNINVOICE OCR TREN CONG 8000 VA DON FILE TAM
echo ============================================================================

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000" ^| findstr "LISTENING"') do (
    echo Dang dung tien trinh PID: %%a ...
    taskkill /F /PID %%a
)

cd /d "%~dp0.."
if exist "temp_workspace" (
    echo Dang xoa thu muc file tam temp_workspace...
    rmdir /s /q "temp_workspace"
    mkdir "temp_workspace"
)

echo.
echo Da dung may chu va xoa sach cac file PDF tam!
pause
