"""
Module quản lý tác vụ xử lý hàng loạt (20-100 file PDF), hỗ trợ theo dõi tiến độ
theo từng hóa đơn, hủy tác vụ giữa chừng và tự động xóa file tạm sau khi xử lý.
"""
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional
from .config import settings
from .logger import logger
from .models import ExtractedInvoice
from .pdf_processor import validate_pdf_file, process_pdf_pages, PdfValidationError
from .ocr_engine import ocr_engine
from .invoice_extractor import extract_invoice_from_lines
from .validator import validate_invoice_batch


@dataclass
class FileJobStatus:
    file_id: str
    filename: str
    size_bytes: int
    status: str = "QUEUED"  # "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
    progress_pct: int = 0
    error_message: str = ""
    extraction_method: str = ""
    page_count: int = 0


@dataclass
class BatchTask:
    task_id: str
    created_at: float
    status: str = "QUEUED"  # "QUEUED" | "PROCESSING" | "COMPLETED" | "CANCELLED" | "FAILED"
    total_files: int = 0
    completed_files: int = 0
    failed_files: int = 0
    cancel_requested: bool = False
    files: List[FileJobStatus] = field(default_factory=list)
    invoices: List[ExtractedInvoice] = field(default_factory=list)
    workspace_dir: Optional[Path] = None

    @property
    def overall_progress_pct(self) -> int:
        if self.total_files == 0:
            return 0
        done = self.completed_files + self.failed_files
        return min(100, int((done / self.total_files) * 100))

    def to_dict(self) -> dict:
        data = asdict(self)
        data["overall_progress_pct"] = self.overall_progress_pct
        data.pop("workspace_dir", None)
        return data


class TaskManager:
    def __init__(self):
        self._tasks: Dict[str, BatchTask] = {}
        self._lock = threading.Lock()

    def create_task(self, saved_files: List[tuple], workspace_dir: Path) -> BatchTask:
        task_id = f"batch_{uuid.uuid4().hex[:10]}"
        file_statuses = [
            FileJobStatus(
                file_id=f"file_{idx + 1}",
                filename=orig_name,
                size_bytes=file_path.stat().st_size if file_path.exists() else 0,
            )
            for idx, (orig_name, file_path) in enumerate(saved_files)
        ]
        task = BatchTask(
            task_id=task_id,
            created_at=time.time(),
            total_files=len(saved_files),
            files=file_statuses,
            workspace_dir=workspace_dir,
        )
        with self._lock:
            self._tasks[task_id] = task
        return task

    def get_task(self, task_id: str) -> Optional[BatchTask]:
        with self._lock:
            return self._tasks.get(task_id)

    def cancel_task(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.cancel_requested = True
            for f in task.files:
                if f.status == "QUEUED":
                    f.status = "CANCELLED"
            if task.status in ("QUEUED", "PROCESSING"):
                task.status = "CANCELLED"
            return True

    def run_batch_processing(self, task_id: str, saved_files: List[tuple]) -> None:
        task = self.get_task(task_id)
        if not task:
            return

        task.status = "PROCESSING"
        extracted_list: List[ExtractedInvoice] = []

        try:
            for idx, (orig_name, file_path) in enumerate(saved_files):
                f_status = task.files[idx]
                if task.cancel_requested:
                    f_status.status = "CANCELLED"
                    continue

                f_status.status = "PROCESSING"
                f_status.progress_pct = 15

                try:
                    file_sha256 = validate_pdf_file(file_path)
                    f_status.progress_pct = 35

                    lines, page_count, method = process_pdf_pages(
                        file_path=file_path,
                        ocr_page_callback=ocr_engine.recognize_image_bytes,
                        dpi=settings.pdf_render_dpi,
                    )
                    f_status.page_count = page_count
                    f_status.extraction_method = method
                    f_status.progress_pct = 75

                    inv = extract_invoice_from_lines(
                        lines=lines,
                        invoice_id=f"inv_{task_id}_{idx + 1}",
                        source_filename=orig_name,
                        file_size_bytes=f_status.size_bytes,
                        file_sha256=file_sha256,
                        page_count=page_count,
                        extraction_method=method,
                    )
                    extracted_list.append(inv)
                    f_status.status = "COMPLETED"
                    f_status.progress_pct = 100
                    task.completed_files += 1
                except PdfValidationError as val_err:
                    f_status.status = "FAILED"
                    f_status.error_message = str(val_err)
                    task.failed_files += 1
                except Exception as exc:
                    f_status.status = "FAILED"
                    f_status.error_message = f"Lỗi xử lý PDF/OCR: {exc}"
                    task.failed_files += 1
                finally:
                    # Xóa ngay file PDF tạm sau khi xử lý xong từng file nếu bật chế độ tự dọn dẹp
                    if settings.auto_cleanup_temp and file_path.exists():
                        try:
                            file_path.unlink()
                        except OSError:
                            pass

            # Kiểm tra dữ liệu và phát hiện hóa đơn trùng trên toàn bộ lô
            task.invoices = validate_invoice_batch(extracted_list)
            if not task.cancel_requested:
                task.status = "COMPLETED"
        finally:
            if settings.auto_cleanup_temp and task.workspace_dir and task.workspace_dir.exists():
                shutil.rmtree(task.workspace_dir, ignore_errors=True)

    def cleanup_all_temp_files(self) -> int:
        """Xóa toàn bộ file tạm trong thư mục làm việc của máy chủ."""
        removed_count = 0
        if settings.temp_dir.exists():
            for child in settings.temp_dir.iterdir():
                try:
                    if child.is_dir():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
                    removed_count += 1
                except OSError:
                    pass
        logger.info("Đã dọn dẹp %d mục trong thư mục tạm.", removed_count)
        return removed_count


task_manager = TaskManager()
