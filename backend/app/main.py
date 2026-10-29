"""
Điểm vào chính của máy chủ FastAPI (chạy trên Windows 10 ở nhà hoặc MacBook Pro 2017 dự phòng).
Cung cấp các endpoint:
- GET  /api/health                 : Kiểm tra trạng thái máy chủ, phiên bản Python và PaddleOCR
- POST /api/tasks/upload           : Tải lên hàng loạt PDF (20-100 file) và khởi chạy trích xuất
- GET  /api/tasks/{task_id}        : Lấy tiến độ từng file và bảng kết quả hóa đơn
- POST /api/tasks/{task_id}/cancel : Hủy tác vụ đang chạy
- POST /api/invoices/validate      : Kiểm tra lại dữ liệu sau khi người dùng chỉnh sửa trên giao diện
- POST /api/excel/analyze-template : Phân tích cấu trúc file Excel mẫu (.xlsx)
- POST /api/excel/export           : Xuất dữ liệu hóa đơn vào file Excel mẫu và tải về
- POST /api/system/cleanup         : Xóa toàn bộ file tạm ngay lập tức
"""
import shutil
import uuid
from pathlib import Path
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, UploadFile, File, Header, HTTPException, BackgroundTasks, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .auth import verify_token_string
from .ocr_engine import ocr_engine
from .task_manager import task_manager
from .models import ExtractedInvoice
from .validator import validate_invoice_batch
from .excel_exporter import (
    analyze_excel_template,
    export_invoices_to_template,
    create_sample_accounting_template,
)

app = FastAPI(
    title="VNInvoice OCR Backend (PaddleOCR)",
    description="Máy chủ đọc hóa đơn điện tử PDF & PDF Scan bằng PaddleOCR và xuất Excel theo mẫu",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_auth(
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> None:
    token = x_api_token or authorization
    if not verify_token_string(token):
        raise HTTPException(
            status_code=401,
            detail="Không có quyền truy cập. Vui lòng kiểm tra Khóa xác thực (API Token) trong cấu hình kết nối máy chủ.",
        )


@app.get("/api/health")
def health_check():
    ocr_status = ocr_engine.check_status()
    return {
        "status": "ok",
        "engine": "FastAPI + PaddleOCR (Self-Hosted)",
        "max_file_size_mb": settings.max_file_size_mb,
        "max_files_per_batch": settings.max_files_per_batch,
        "auto_cleanup_temp": settings.auto_cleanup_temp,
        "paddle_ocr": ocr_status,
    }


@app.post("/api/tasks/upload")
async def upload_and_process_pdfs(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)

    if not files:
        raise HTTPException(status_code=400, detail="Chưa chọn file PDF nào để tải lên.")
    if len(files) > settings.max_files_per_batch:
        raise HTTPException(
            status_code=400,
            detail=f"Số lượng file ({len(files)}) vượt quá giới hạn tối đa {settings.max_files_per_batch} file/lần.",
        )

    batch_dir = settings.temp_dir / f"upload_{uuid.uuid4().hex[:10]}"
    batch_dir.mkdir(parents=True, exist_ok=True)
    saved_files = []

    for idx, upload in enumerate(files):
        safe_name = Path(upload.filename or f"invoice_{idx + 1}.pdf").name
        dest_path = batch_dir / f"{idx + 1:03d}_{safe_name}"
        with open(dest_path, "wb") as out_f:
            shutil.copyfileobj(upload.file, out_f)
        saved_files.append((safe_name, dest_path))

    task = task_manager.create_task(saved_files, batch_dir)
    background_tasks.add_task(task_manager.run_batch_processing, task.task_id, saved_files)
    return task.to_dict()


@app.get("/api/tasks/{task_id}")
def get_task_status(
    task_id: str,
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Không tìm thấy tác vụ xử lý.")
    return task.to_dict()


@app.post("/api/tasks/{task_id}/cancel")
def cancel_running_task(
    task_id: str,
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)
    ok = task_manager.cancel_task(task_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Không tìm thấy tác vụ cần hủy.")
    return {"cancelled": True, "task_id": task_id}


@app.post("/api/invoices/validate")
def revalidate_invoices(
    payload: Dict[str, Any] = Body(...),
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)
    raw_list = payload.get("invoices", [])
    invoices: List[ExtractedInvoice] = []
    for item in raw_list:
        inv = ExtractedInvoice(
            id=str(item.get("id", "")),
            source_filename=str(item.get("source_filename", "")),
            file_size_bytes=int(item.get("file_size_bytes", 0)),
            file_sha256=str(item.get("file_sha256", "")),
            page_count=int(item.get("page_count", 1)),
            extraction_method=str(item.get("extraction_method", "USER_EDITED")),
            seller_name=str(item.get("seller_name", "")),
            seller_tax_id=str(item.get("seller_tax_id", "")),
            seller_address=str(item.get("seller_address", "")),
            invoice_symbol=str(item.get("invoice_symbol", "")),
            invoice_number=str(item.get("invoice_number", "")),
            invoice_date=str(item.get("invoice_date", "")),
            buyer_name=str(item.get("buyer_name", "")),
            buyer_tax_id=str(item.get("buyer_tax_id", "")),
            subtotal_amount=float(item["subtotal_amount"]) if item.get("subtotal_amount") is not None else None,
            vat_rate=str(item.get("vat_rate", "")),
            vat_amount=float(item["vat_amount"]) if item.get("vat_amount") is not None else None,
            discount_amount=float(item["discount_amount"]) if item.get("discount_amount") is not None else None,
            total_amount=float(item["total_amount"]) if item.get("total_amount") is not None else None,
            currency=str(item.get("currency", "VND")),
            items_summary=str(item.get("items_summary", "")),
            notes=str(item.get("notes", "")),
            verification_status=str(item.get("verification_status", "NEEDS_REVIEW")),
            uncertain_fields=list(item.get("uncertain_fields", [])),
            field_sources=dict(item.get("field_sources", {})),
            field_confidences=dict(item.get("field_confidences", {})),
            field_pages=dict(item.get("field_pages", {})),
        )
        invoices.append(inv)

    validated = validate_invoice_batch(invoices)
    return {"invoices": [i.to_dict() for i in validated]}


@app.post("/api/excel/analyze-template")
async def upload_and_analyze_template(
    file: UploadFile = File(...),
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)
    filename = file.filename or "template.xlsx"
    if not filename.lower().endswith(".xlsx"):
        raise HTTPException(
            status_code=400,
            detail="Chỉ hỗ trợ file Excel định dạng .xlsx (OpenXML).",
        )
    tpl_id = f"tpl_{uuid.uuid4().hex[:10]}.xlsx"
    tpl_path = settings.temp_dir / tpl_id
    with open(tpl_path, "wb") as out_f:
        shutil.copyfileobj(file.file, out_f)

    try:
        analysis = analyze_excel_template(tpl_path)
        analysis["template_id"] = tpl_id
        return analysis
    except Exception as exc:
        if tpl_path.exists():
            tpl_path.unlink()
        raise HTTPException(status_code=400, detail=f"Không thể phân tích file Excel mẫu: {exc}") from exc


@app.post("/api/excel/generate-sample-template")
def generate_sample_template_endpoint(
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)
    tpl_id = f"tpl_mau_ke_toan_{uuid.uuid4().hex[:8]}.xlsx"
    tpl_path = settings.temp_dir / tpl_id
    try:
        create_sample_accounting_template(tpl_path)
        analysis = analyze_excel_template(tpl_path)
        analysis["template_id"] = tpl_id
        analysis["template_filename"] = "Mau_Bang_Ke_Mua_Vao_Chuan.xlsx"
        return analysis
    except Exception as exc:
        if tpl_path.exists():
            tpl_path.unlink()
        raise HTTPException(status_code=500, detail=f"Không thể tạo file Excel mẫu: {exc}") from exc



@app.post("/api/excel/export")
def export_excel_endpoint(
    payload: Dict[str, Any] = Body(...),
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)
    template_id = payload.get("template_id")
    if not template_id:
        raise HTTPException(status_code=400, detail="Vui lòng tải lên file Excel mẫu trước khi xuất dữ liệu.")

    tpl_path = settings.temp_dir / Path(template_id).name
    if not tpl_path.exists():
        raise HTTPException(status_code=404, detail="File Excel mẫu không tồn tại hoặc đã bị dọn dẹp. Hãy tải lại mẫu.")

    raw_invoices = payload.get("invoices", [])
    if not raw_invoices:
        raise HTTPException(status_code=400, detail="Danh sách hóa đơn trống, không thể xuất Excel.")

    invoices: List[ExtractedInvoice] = []
    for item in raw_invoices:
        inv = ExtractedInvoice(
            id=str(item.get("id", "")),
            source_filename=str(item.get("source_filename", "")),
            file_size_bytes=int(item.get("file_size_bytes", 0)),
            file_sha256=str(item.get("file_sha256", "")),
            page_count=int(item.get("page_count", 1)),
            extraction_method=str(item.get("extraction_method", "PDF_TEXT")),
            seller_name=str(item.get("seller_name", "")),
            seller_tax_id=str(item.get("seller_tax_id", "")),
            seller_address=str(item.get("seller_address", "")),
            invoice_symbol=str(item.get("invoice_symbol", "")),
            invoice_number=str(item.get("invoice_number", "")),
            invoice_date=str(item.get("invoice_date", "")),
            buyer_name=str(item.get("buyer_name", "")),
            buyer_tax_id=str(item.get("buyer_tax_id", "")),
            subtotal_amount=float(item["subtotal_amount"]) if item.get("subtotal_amount") is not None else None,
            vat_rate=str(item.get("vat_rate", "")),
            vat_amount=float(item["vat_amount"]) if item.get("vat_amount") is not None else None,
            discount_amount=float(item["discount_amount"]) if item.get("discount_amount") is not None else None,
            total_amount=float(item["total_amount"]) if item.get("total_amount") is not None else None,
            currency=str(item.get("currency", "VND")),
            items_summary=str(item.get("items_summary", "")),
            notes=str(item.get("notes", "")),
            verification_status=str(item.get("verification_status", "VERIFIED")),
        )
        invoices.append(inv)

    out_path = settings.temp_dir / f"Bang_Ke_Hoa_Don_{uuid.uuid4().hex[:8]}.xlsx"
    export_invoices_to_template(
        template_path=tpl_path,
        output_path=out_path,
        invoices=invoices,
        target_sheet=payload.get("target_sheet"),
        include_audit_sheet=bool(payload.get("include_audit_sheet", True)),
    )
    return FileResponse(
        path=str(out_path),
        filename="Bang_Ke_Hoa_Don_Xuat_Mau.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.post("/api/system/cleanup")
def cleanup_temp_files_endpoint(
    x_api_token: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    require_auth(x_api_token, authorization)
    count = task_manager.cleanup_all_temp_files()
    return {"cleaned_items": count, "status": "ok"}
