#!/usr/bin/env bash
# Script khởi động máy chủ dự phòng trên MacBook Pro 2017 (Intel CPU - macOS)
set -e

cd "$(dirname "$0")/.."

if [ ! -d ".venv" ]; then
  echo "[1/3] Đang tạo môi trường ảo Python 3.10 (.venv)..."
  python3 -m venv .venv
  source .venv/bin/activate
  pip install --upgrade pip setuptools wheel
  pip install -r backend/requirements.txt
else
  source .venv/bin/activate
fi

if [ -f "backend/.env" ]; then
  export $(grep -v '^#' backend/.env | xargs)
fi

echo "Đang khởi động máy chủ dự phòng FastAPI + PaddleOCR trên MacBook Pro Intel (http://127.0.0.1:8000)..."
python3 -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1
