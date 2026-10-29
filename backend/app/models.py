"""
Định nghĩa cấu trúc dữ liệu cho quá trình trích xuất hóa đơn, kiểm tra dữ liệu và xuất Excel.
Sử dụng dataclasses chuẩn tương thích cả với Pydantic / FastAPI và unittest độc lập.
"""
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Dict, Any


@dataclass
class OcrTextLine:
    text: str
    confidence: float
    page: int
    bbox: Optional[List[List[float]]] = None  # [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
    source: str = "PADDLE_OCR"  # "PDF_TEXT" | "PADDLE_OCR"


@dataclass
class ValidationIssue:
    code: str
    severity: str  # "ERROR" | "WARNING" | "INFO"
    field: str
    message: str


@dataclass
class ExtractedInvoice:
    id: str
    source_filename: str
    file_size_bytes: int
    file_sha256: str
    page_count: int = 1
    extraction_method: str = "PDF_TEXT"  # "PDF_TEXT" | "PADDLE_OCR" | "HYBRID" | "USER_EDITED"

    # Trường dữ liệu người bán
    seller_name: str = ""
    seller_tax_id: str = ""
    seller_address: str = ""

    # Trường dữ liệu định danh hóa đơn
    invoice_symbol: str = ""  # Ký hiệu hóa đơn (VD: 1C26TAA)
    invoice_number: str = ""  # Số hóa đơn (VD: 00012458)
    invoice_date: str = ""    # Ngày lập (YYYY-MM-DD hoặc DD/MM/YYYY chuẩn hóa)

    # Trường dữ liệu người mua
    buyer_name: str = ""
    buyer_tax_id: str = ""

    # Trường dữ liệu tài chính
    subtotal_amount: Optional[float] = None
    vat_rate: str = ""
    vat_amount: Optional[float] = None
    discount_amount: Optional[float] = None
    total_amount: Optional[float] = None
    currency: str = "VND"

    # Nội dung hàng hóa & ghi chú
    items_summary: str = ""
    notes: str = ""

    # Truy nguyên & Trạng thái xác minh
    verification_status: str = "NEEDS_REVIEW"  # "VERIFIED" | "NEEDS_REVIEW" | "DUPLICATE_WARNING" | "ERROR"
    uncertain_fields: List[str] = field(default_factory=list)
    field_sources: Dict[str, str] = field(default_factory=dict)
    field_confidences: Dict[str, float] = field(default_factory=dict)
    field_pages: Dict[str, int] = field(default_factory=dict)
    validation_issues: List[ValidationIssue] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
