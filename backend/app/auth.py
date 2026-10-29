"""
Module xác thực API — Ngăn chặn truy cập trái phép khi kết nối qua mạng nội bộ
hoặc Cloudflare Tunnel.
"""
import hmac
from typing import Optional
from .config import settings
from .logger import logger


def verify_token_string(provided_token: Optional[str]) -> bool:
    """So sánh thời gian hằng (constant-time) để chống tấn công timing."""
    if not provided_token:
        return False
    clean_token = provided_token.strip()
    if clean_token.lower().startswith("bearer "):
        clean_token = clean_token[7:].strip()
    expected = settings.api_token.strip()
    if not expected:
        return False
    return hmac.compare_digest(clean_token.encode("utf-8"), expected.encode("utf-8"))
