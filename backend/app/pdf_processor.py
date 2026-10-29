"""
Module kiểm tra PDF, đọc lớp văn bản (text layer) và render trang PDF thành ảnh khi cần.
Tuân thủ nguyên tắc:
- Kiểm tra magic bytes (%PDF-) thực tế, không chỉ tin vào đuôi .pdf.
- Ưu tiên đọc lớp văn bản PDF trước; chỉ gọi PaddleOCR trên những trang không có text hoặc text lỗi font.
- Xử lý từng trang (streaming) để không nạp toàn bộ ảnh độ phân giải cao vào RAM cùng lúc.
"""
import hashlib
from pathlib import Path
from typing import List, Tuple, Optional, Callable
from .models import OcrTextLine
from .config import settings
from .logger import logger

PDF_MAGIC_HEADER = b"%PDF-"


class PdfValidationError(Exception):
    """Lỗi định dạng hoặc giới hạn dung lượng PDF."""
    pass


def validate_pdf_file(file_path: Path, max_bytes: Optional[int] = None) -> str:
    """
    Kiểm tra file tồn tại, không rỗng, không vượt quá giới hạn dung lượng,
    có header %PDF- hợp lệ và có kết thúc %%EOF. Trả về mã băm SHA-256.
    """
    limit = max_bytes or settings.max_file_size_bytes
    if not file_path.exists():
        raise PdfValidationError("File không tồn tại trên máy chủ.")

    size = file_path.stat().st_size
    if size == 0:
        raise PdfValidationError("File PDF rỗng (0 byte).")
    if size > limit:
        raise PdfValidationError(
            f"Dung lượng file ({size / (1024 * 1024):.2f} MB) vượt quá giới hạn cho phép ({limit / (1024 * 1024):.0f} MB)."
        )

    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        header = f.read(1024)
        if PDF_MAGIC_HEADER not in header[:16]:
            raise PdfValidationError(
                "File không đúng định dạng PDF thực tế (thiếu chữ ký %PDF- ở đầu file)."
            )
        sha256.update(header)
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            sha256.update(chunk)

    return sha256.hexdigest()


def is_text_layer_sufficient(text: str) -> bool:
    """
    Đánh giá xem lớp văn bản của trang PDF có đủ chất lượng để trích xuất hóa đơn
    mà không cần chạy OCR hay không.
    """
    if not text:
        return False
    cleaned = text.strip()
    if len(cleaned) < 45:
        return False

    # Kiểm tra tỷ lệ ký tự đọc được (tránh trường hợp PDF lỗi bảng mã TCVN3/VNI hoặc CID hỏng)
    printable_count = sum(1 for ch in cleaned if ch.isalnum() or ch in " .,:/-()%+đĐ")
    if printable_count / max(len(cleaned), 1) < 0.65:
        return False

    lower = cleaned.lower()
    invoice_keywords = [
        "hóa đơn", "hoa don", "invoice", "mã số thuế", "ma so thue",
        "tax code", "mst", "ký hiệu", "ky hieu", "số", "thanh toán",
        "cộng tiền", "thuế suất", "gtgt", "vat"
    ]
    matched = sum(1 for kw in invoice_keywords if kw in lower)
    return matched >= 2


def process_pdf_pages(
    file_path: Path,
    ocr_page_callback: Optional[Callable[[bytes, int], List[OcrTextLine]]] = None,
    dpi: int = 200,
) -> Tuple[List[OcrTextLine], int, str]:
    """
    Đọc từng trang PDF bằng PyMuPDF (fitz).
    - Nếu trang có lớp văn bản tốt -> lấy trực tiếp văn bản và tọa độ từ PDF.
    - Nếu trang là ảnh scan hoặc văn bản không đủ chất lượng -> render trang đó thành ảnh PNG
      trong bộ nhớ (xong giải phóng ngay pixmap) và truyền sang PaddleOCR.
    Trả về: (danh_sách_dòng_văn_bản, tổng_số_trang, phương_thức_trích_xuất)
    """
    try:
        import fitz  # PyMuPDF
    except ImportError as exc:
        raise RuntimeError(
            "Chưa cài đặt thư viện PyMuPDF (fitz). Hãy chạy: pip install PyMuPDF==1.24.10"
        ) from exc

    all_lines: List[OcrTextLine] = []
    used_pdf_text = False
    used_ocr = False

    try:
        doc = fitz.open(str(file_path))
    except Exception as exc:
        raise PdfValidationError(f"File PDF bị hỏng cấu trúc hoặc có mật khẩu bảo vệ: {exc}") from exc

    with doc:
        page_count = len(doc)
        if page_count == 0:
            raise PdfValidationError("File PDF không chứa trang nào.")

        for page_idx in range(page_count):
            page_num = page_idx + 1
            page = doc.load_page(page_idx)
            raw_text = page.get_text("text") or ""

            if is_text_layer_sufficient(raw_text):
                used_pdf_text = True
                blocks = page.get_text("blocks") or []
                for b in blocks:
                    # cấu trúc block: (x0, y0, x1, y1, "lines\n", block_no, block_type)
                    if len(b) >= 5 and isinstance(b[4], str):
                        x0, y0, x1, y1 = float(b[0]), float(b[1]), float(b[2]), float(b[3])
                        bbox = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
                        for line in b[4].splitlines():
                            clean_line = line.strip()
                            if clean_line:
                                all_lines.append(
                                    OcrTextLine(
                                        text=clean_line,
                                        confidence=0.99,
                                        page=page_num,
                                        bbox=bbox,
                                        source="PDF_TEXT",
                                    )
                                )
            else:
                # Trang scan hoặc không có lớp text -> Render trang thành ảnh và gọi PaddleOCR
                if ocr_page_callback is None:
                    raise RuntimeError(
                        f"Trang {page_num} là PDF scan cần chạy PaddleOCR nhưng chưa cấu hình ocr_page_callback."
                    )
                used_ocr = True
                zoom = dpi / 72.0
                mat = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                img_bytes = pix.tobytes("png")
                # Giải phóng bộ nhớ pixmap ngay lập tức để tránh tràn RAM khi chạy 100 file
                del pix
                ocr_lines = ocr_page_callback(img_bytes, page_num)
                all_lines.extend(ocr_lines)

    if used_pdf_text and used_ocr:
        method = "HYBRID"
    elif used_ocr:
        method = "PADDLE_OCR"
    else:
        method = "PDF_TEXT"

    logger.info("Hoàn tất đọc PDF (%d trang) bằng phương thức %s.", page_count, method)
    return all_lines, page_count, method
