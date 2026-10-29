"""
Module ghi log an toàn — Tự động che giấu Mã số thuế (MST) và nội dung nhạy cảm
trên hóa đơn theo mặc định để đảm bảo an toàn dữ liệu tài chính doanh nghiệp.
"""
import logging
import re
from .config import settings

MST_PATTERN = re.compile(r"\b(\d{2})\d{6}(\d{2})(-\d{3})?\b")


class SensitiveDataRedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not settings.redact_sensitive_logs:
            return True
        msg = record.getMessage()
        # Che giấu MST trong log: ví dụ 0101234567 -> 01******67
        redacted = MST_PATTERN.sub(r"\1******\2\3", msg)
        record.msg = redacted
        record.args = ()
        return True


def get_safe_logger(name: str = "vn_invoice_ocr") -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        handler = logging.StreamHandler()
        formatter = logging.Formatter(
            "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        handler.setFormatter(formatter)
        handler.addFilter(SensitiveDataRedactingFilter())
        logger.addHandler(handler)
    return logger


logger = get_safe_logger()
