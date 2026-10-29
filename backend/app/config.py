"""
Cấu hình trung tâm cho máy chủ FastAPI + PaddleOCR.
"""
import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ServerConfig:
    host: str = field(default_factory=lambda: os.getenv("APP_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.getenv("APP_PORT", "8000")))
    api_token: str = field(
        default_factory=lambda: os.getenv("APP_API_TOKEN", "vn-invoice-local-dev-token")
    )
    max_file_size_mb: int = field(
        default_factory=lambda: int(os.getenv("MAX_FILE_SIZE_MB", "30"))
    )
    max_pdf_pages: int = field(
        default_factory=lambda: int(os.getenv("MAX_PDF_PAGES", "50"))
    )
    max_files_per_batch: int = field(
        default_factory=lambda: int(os.getenv("MAX_FILES_PER_BATCH", "100"))
    )
    max_concurrent_workers: int = field(
        default_factory=lambda: int(os.getenv("MAX_CONCURRENT_WORKERS", "2"))
    )
    ocr_timeout_seconds: int = field(
        default_factory=lambda: int(os.getenv("OCR_TIMEOUT_SECONDS", "120"))
    )
    ocr_lang: str = field(default_factory=lambda: os.getenv("PADDLE_OCR_LANG", "vi"))
    use_gpu: bool = field(
        default_factory=lambda: os.getenv("PADDLE_USE_GPU", "false").lower() == "true"
    )
    use_angle_cls: bool = field(
        default_factory=lambda: os.getenv("PADDLE_USE_ANGLE_CLS", "true").lower() == "true"
    )
    pdf_render_dpi: int = field(
        default_factory=lambda: int(os.getenv("PDF_RENDER_DPI", "200"))
    )
    auto_cleanup_temp: bool = field(
        default_factory=lambda: os.getenv("AUTO_CLEANUP_TEMP_FILES", "true").lower() == "true"
    )
    redact_sensitive_logs: bool = field(
        default_factory=lambda: os.getenv("LOG_REDACT_SENSITIVE", "true").lower() == "true"
    )
    temp_dir: Path = field(
        default_factory=lambda: Path(os.getenv("TEMP_WORK_DIR", "./temp_workspace")).resolve()
    )

    @property
    def max_file_size_bytes(self) -> int:
        return self.max_file_size_mb * 1024 * 1024


settings = ServerConfig()
settings.temp_dir.mkdir(parents=True, exist_ok=True)
