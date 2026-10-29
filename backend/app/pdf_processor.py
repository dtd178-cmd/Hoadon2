# -*- coding: utf-8 -*-
"""
Module kiểm tra PDF, đọc lớp văn bản (text layer) và render trang PDF thành ảnh khi cần.
Tuân thủ nguyên tắc:
- Kiểm tra magic bytes (%PDF-) thực tế và cấu trúc kết thúc (%%EOF), không chỉ tin vào đuôi .pdf.
- Giới hạn dung lượng file và số trang tối đa để bảo vệ RAM/CPU trên máy chủ Windows 10.
- Ưu tiên đọc lớp văn bản PDF trước; chỉ gọi PaddleOCR trên những trang không có text hoặc text lỗi font.
- Xử lý từng trang (streaming) và giải phóng bộ nhớ pixmap ngay sau mỗi trang.
"""
import gc
import hashlib
from pathlib import Path
from typing import List, Tuple, Optional, Callable
from .models import OcrTextLine
from .config import settings
from .invoice_extractor import fold_vn_ascii, normalize_vn_text
from .logger import logger

PDF_MAGIC_HEADER = b"%PDF-"


class PdfValidationError(Exception):
    """Lỗi định dạng hoặc giới hạn dung lượng/số trang PDF."""
    pass


def validate_pdf_file(file_path: Path, max_bytes: Optional[int] = None) -> str:
    """
    Kiểm tra file tồn tại, không rỗng, không vượt quá giới hạn dung lượng,
    có header %PDF- hợp lệ và không bị cụt luồng dữ liệu (thiếu %%EOF). Trả về mã băm SHA-256.
    """
    limit = max_bytes if max_bytes is not None else settings.max_file_size_bytes
    if not file_path.exists() or not file_path.is_file():
        raise PdfValidationError("File không tồn tại trên máy chủ.")

    size = file_path.stat().st_size
    if size == 0:
        raise PdfValidationError("File PDF rỗng (0 byte).")
    if size > limit:
        raise PdfValidationError(
            f"Dung lượng file ({size / (1024 * 1024):.2f} MB) vượt quá giới hạn an toàn cho phép ({limit / (1024 * 1024):.0f} MB)."
        )

    sha256 = hashlib.sha256()
    tail_chunk = b""
    with open(file_path, "rb") as f:
        header = f.read(1024)
        if PDF_MAGIC_HEADER not in header[:32]:
            raise PdfValidationError(
                "File không đúng định dạng PDF thực tế (thiếu chữ ký %PDF- ở đầu file)."
            )
        sha256.update(header)
        tail_chunk = header
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            sha256.update(chunk)
            tail_chunk = (tail_chunk + chunk)[-2048:]

    if b"%%EOF" not in tail_chunk and b"endobj" not in tail_chunk:
        raise PdfValidationError(
            "File PDF bị hỏng cấu trúc hoặc tải lên chưa hoàn tất (thiếu dấu kết thúc %%EOF)."
        )

    return sha256.hexdigest()


def is_text_layer_sufficient(text: str) -> bool:
    """
    Đánh giá xem lớp văn bản của trang PDF có đủ chất lượng để trích xuất hóa đơn
    mà không cần chạy OCR hay không.
    """
    if not text:
        return False
    cleaned = normalize_vn_text(text)
    if len(cleaned) < 40:
        return False

    # Kiểm tra tỷ lệ ký tự đọc được (tránh trường hợp PDF lỗi bảng mã TCVN3/VNI hoặc CID hỏng)
    printable_count = sum(1 for ch in cleaned if ch.isalnum() or ch in " .,:/-()%+đĐ")
    if printable_count / max(len(cleaned), 1) < 0.65:
        return False

    folded = fold_vn_ascii(cleaned)
    invoice_keywords = [
        "hoa don", "invoice", "ma so thue", "tax code", "mst",
        "ky hieu", "serial", "so", "thanh toan", "cong tien",
        "thue suat", "gtgt", "vat", "don vi ban", "nguoi mua"
    ]
    matched = sum(1 for kw in invoice_keywords if kw in folded)
    return matched >= 2


def process_pdf_pages(
    file_path: Path,
    ocr_page_callback: Optional[Callable[[bytes, int], List[OcrTextLine]]] = None,
    dpi: int = 200,
    max_pages: Optional[int] = None,
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

    page_limit = max_pages if max_pages is not None else settings.max_pdf_pages
    all_lines: List[OcrTextLine] = []
    used_pdf_text = False
    used_ocr = False

    try:
        doc = fitz.open(str(file_path))
    except Exception as exc:
        raise PdfValidationError(f"File PDF bị hỏng cấu trúc hoặc không thể mở: {exc}") from exc

    with doc:
        if getattr(doc, "is_encrypted", False) and not doc.authenticate(""):
            raise PdfValidationError("File PDF bị khóa bằng mật khẩu bảo vệ, không thể đọc tự động.")

        page_count = len(doc)
        if page_count == 0:
            raise PdfValidationError("File PDF không chứa trang nào.")
        if page_count > page_limit:
            raise PdfValidationError(
                f"File PDF có {page_count} trang, vượt quá giới hạn an toàn ({page_limit} trang/hóa đơn)."
            )

        for page_idx in range(page_count):
            page_num = page_idx + 1
            page = doc.load_page(page_idx)
            raw_text = page.get_text("text") or ""

            if is_text_layer_sufficient(raw_text):
                used_pdf_text = True
                blocks = page.get_text("blocks") or []
                # Sắp xếp các block theo tọa độ từ trên xuống dưới (y0), từ trái sang phải (x0)
                valid_blocks = [
                    b for b in blocks if len(b) >= 5 and isinstance(b[4], str) and b[4].strip()
                ]
                valid_blocks.sort(key=lambda b: (round(float(b[1]) / 6.0), float(b[0])))

                for b in valid_blocks:
                    x0, y0, x1, y1 = float(b[0]), float(b[1]), float(b[2]), float(b[3])
                    bbox = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
                    for line in b[4].splitlines():
                        clean_line = normalize_vn_text(line)
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
                if ocr_page_callback is None:
                    raise RuntimeError(
                        f"Trang {page_num} là PDF scan cần chạy PaddleOCR nhưng chưa cấu hình ocr_page_callback."
                    )
                used_ocr = True
                rect = page.rect
                max_dim = max(rect.width, rect.height, 1.0)
                # Tự động điều chỉnh DPI nếu khổ trang PDF quá lớn để tránh tràn bộ nhớ RAM
                effective_dpi = dpi
                if (max_dim * (dpi / 72.0)) > 2600:
                    effective_dpi = max(120, int((2600.0 / max_dim) * 72.0))

                zoom = effective_dpi / 72.0
                mat = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                img_bytes = pix.tobytes("png")
                del pix
                gc.collect()
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
