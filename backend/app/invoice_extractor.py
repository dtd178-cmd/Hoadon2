"""
Bộ trích xuất trường dữ liệu hóa đơn tiếng Việt & tiếng Anh (có thể kiểm thử độc lập).
Đặc điểm thiết kế:
- Không phụ thuộc cứng vào một mẫu hóa đơn duy nhất.
- Phân tách rõ vùng Người bán (Seller Zone) và vùng Người mua (Buyer Zone) dựa trên nhãn ngữ cảnh
  và thứ tự xuất hiện không gian trên hóa đơn, tuyệt đối không gán nhầm MST người mua thành MST người bán.
- Nếu không tìm thấy trường dữ liệu, giữ nguyên giá trị trống/None và đưa vào danh sách uncertain_fields
  để người dùng kiểm tra (không tự bịa giá trị).
"""
import re
from typing import List, Optional, Tuple
from .models import OcrTextLine, ExtractedInvoice

# Biểu thức chính quy cho Mã số thuế Việt Nam (10 chữ số hoặc 10-3 chữ số, có thể có khoảng trắng/gạch ngang do OCR)
MST_REGEX = re.compile(r"(?<!\d)(\d{10}(?:\s*-\s*\d{3})?)(?!\d)")

# Nhãn phân vùng Người bán vs Người mua
SELLER_MARKERS = [
    "đơn vị bán hàng", "don vi ban hang", "tên người bán", "ten nguoi ban",
    "người bán", "nguoi ban", "bên bán", "seller", "vendor", "supplier",
    "công ty xuất hóa đơn", "merchandiser"
]
BUYER_MARKERS = [
    "họ tên người mua", "ho ten nguoi mua", "đơn vị mua hàng", "don vi mua hang",
    "tên đơn vị mua", "ten don vi mua", "người mua", "nguoi mua", "bên mua",
    "khách hàng", "khach hang", "buyer", "customer", "bill to", "sold to"
]
TABLE_START_MARKERS = [
    "stt", "tên hàng hóa", "ten hang hoa", "dịch vụ", "đơn vị tính", "số lượng",
    "đơn giá", "thành tiền", "description", "quantity", "unit price"
]


def parse_vietnamese_number(raw: str) -> Optional[float]:
    """
    Chuyển chuỗi số tiền tiếng Việt hoặc quốc tế sang float.
    Ví dụ:
      '12.500.000' -> 12500000.0
      '12,500,000' -> 12500000.0
      '1.250.000,50' -> 1250000.5
      '1,250,000.50' -> 1250000.5
    """
    if not raw:
        return None
    cleaned = re.sub(r"[^\d.,-]", "", raw.strip())
    if not cleaned or cleaned in ("-", ".", ","):
        return None

    # Trường hợp có cả dấu chấm và dấu phẩy
    if "." in cleaned and "," in cleaned:
        last_dot = cleaned.rfind(".")
        last_comma = cleaned.rfind(",")
        if last_comma > last_dot:
            # Dạng 1.250.000,50 (Việt Nam)
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            # Dạng 1,250,000.50 (Anh/Mỹ)
            cleaned = cleaned.replace(",", "")
    elif "." in cleaned:
        parts = cleaned.split(".")
        if len(parts) > 2 or (len(parts) == 2 and len(parts[1]) == 3):
            cleaned = "".join(parts)
    elif "," in cleaned:
        parts = cleaned.split(",")
        if len(parts) > 2 or (len(parts) == 2 and len(parts[1]) == 3):
            cleaned = "".join(parts)
        else:
            cleaned = cleaned.replace(",", ".")

    try:
        return float(cleaned)
    except ValueError:
        return None


def normalize_date_str(text: str) -> Optional[str]:
    """
    Trích xuất và chuẩn hóa ngày lập hóa đơn về dạng YYYY-MM-DD.
    Hỗ trợ:
      - 'Ngày 15 tháng 03 năm 2026'
      - 'Ngày: 05/11/2025' hoặc 'Date: 2026-03-15'
    """
    lower = text.lower()
    m_vn = re.search(
        r"(?:ngày|ngay)\s*(\d{1,2})\s*(?:tháng|thang)\s*(\d{1,2})\s*(?:năm|nam)\s*(\d{4})",
        lower,
    )
    if m_vn:
        day, month, year = int(m_vn.group(1)), int(m_vn.group(2)), int(m_vn.group(3))
        if 1 <= month <= 12 and 1 <= day <= 31 and 1990 <= year <= 2100:
            return f"{year:04d}-{month:02d}-{day:02d}"

    m_slash = re.search(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b", text)
    if m_slash:
        day, month, year = int(m_slash.group(1)), int(m_slash.group(2)), int(m_slash.group(3))
        if 1 <= month <= 12 and 1 <= day <= 31 and 1990 <= year <= 2100:
            return f"{year:04d}-{month:02d}-{day:02d}"

    m_iso = re.search(r"\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b", text)
    if m_iso:
        year, month, day = int(m_iso.group(1)), int(m_iso.group(2)), int(m_iso.group(3))
        if 1 <= month <= 12 and 1 <= day <= 31 and 1990 <= year <= 2100:
            return f"{year:04d}-{month:02d}-{day:02d}"

    return None


def extract_invoice_from_lines(
    lines: List[OcrTextLine],
    invoice_id: str,
    source_filename: str,
    file_size_bytes: int,
    file_sha256: str,
    page_count: int = 1,
    extraction_method: str = "PDF_TEXT",
) -> ExtractedInvoice:
    inv = ExtractedInvoice(
        id=invoice_id,
        source_filename=source_filename,
        file_size_bytes=file_size_bytes,
        file_sha256=file_sha256,
        page_count=page_count,
        extraction_method=extraction_method,
    )

    def set_field(field_name: str, value, line: OcrTextLine):
        setattr(inv, field_name, value)
        inv.field_sources[field_name] = line.source
        inv.field_confidences[field_name] = line.confidence
        inv.field_pages[field_name] = line.page

    # Vùng ngữ cảnh hiện tại khi duyệt từ trên xuống dưới: "HEADER" -> "SELLER" -> "BUYER" -> "TABLE"
    current_zone = "HEADER"
    item_descriptions: List[str] = []

    for idx, line_obj in enumerate(lines):
        raw = line_obj.text.strip()
        if not raw:
            continue
        lower = raw.lower()

        # 1. Cập nhật vùng ngữ cảnh (Seller vs Buyer vs Table)
        if any(marker in lower for marker in BUYER_MARKERS):
            current_zone = "BUYER"
        elif any(marker in lower for marker in SELLER_MARKERS):
            current_zone = "SELLER"
        elif current_zone in ("SELLER", "BUYER") and any(m in lower for m in TABLE_START_MARKERS):
            current_zone = "TABLE"

        # 2. Ký hiệu hóa đơn (Serial / Symbol)
        if not inv.invoice_symbol:
            m_sym = re.search(
                r"(?:ký hiệu|ky hieu|serial(?:\s*no)?)\s*(?:\([^)]*\))?\s*[:\-]?\s*([A-Z0-9/]{5,12})",
                raw,
                re.IGNORECASE,
            )
            if m_sym:
                set_field("invoice_symbol", m_sym.group(1).strip().upper(), line_obj)

        # 3. Số hóa đơn (Invoice Number)
        if not inv.invoice_number:
            # Tránh nhầm với "Mã số thuế" hoặc "Số tài khoản" hoặc "Số điện thoại"
            if not any(excl in lower for excl in ["mã số thuế", "ma so thue", "tài khoản", "tai khoan", "điện thoại", "dien thoai", "số lượng", "so luong"]):
                m_num = re.search(
                    r"(?:(?:số|so)\s*\(?(?:no\.?|invoice\s*no\.?)?\)?|số hóa đơn|so hoa don|invoice\s*(?:no|number))\s*[:\-]?\s*([0-9]{1,12})\b",
                    raw,
                    re.IGNORECASE,
                )
                if m_num:
                    set_field("invoice_number", m_num.group(1).strip(), line_obj)

        # 4. Ngày lập hóa đơn
        if not inv.invoice_date:
            if any(k in lower for k in ["ngày", "ngay", "date", "tháng", "thang", "năm", "nam"]):
                norm_dt = normalize_date_str(raw)
                if norm_dt:
                    set_field("invoice_date", norm_dt, line_obj)

        # 5. Tên người bán & Tên người mua
        if any(m in lower for m in SELLER_MARKERS) and not inv.seller_name:
            m_sel = re.search(
                r"(?:đơn vị bán hàng|don vi ban hang|tên người bán|ten nguoi ban|người bán|nguoi ban|bên bán|ben ban|seller|vendor)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)",
                raw,
                re.IGNORECASE,
            )
            if m_sel and len(m_sel.group(1).strip()) >= 3:
                set_field("seller_name", m_sel.group(1).strip(), line_obj)
            elif idx + 1 < len(lines):
                next_line = lines[idx + 1].text.strip()
                if len(next_line) > 4 and ":" not in next_line:
                    set_field("seller_name", next_line, lines[idx + 1])

        if any(m in lower for m in BUYER_MARKERS):
            # Phân biệt "Họ tên người mua hàng" và "Tên đơn vị (mua)"
            m_buy_person = re.search(
                r"(?:họ tên người mua(?:\s*hàng)?|ho ten nguoi mua(?:\s*hang)?|họ và tên người mua(?:\s*hàng)?)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)",
                raw,
                re.IGNORECASE,
            )
            m_buy_unit = re.search(
                r"(?:tên đơn vị(?:\s*mua(?:\s*hàng)?)?|ten don vi(?:\s*mua(?:\s*hang)?)?|đơn vị mua(?:\s*hàng)?|don vi mua(?:\s*hang)?|tên người mua|ten nguoi mua|khách hàng|khach hang|customer|buyer)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)",
                raw,
                re.IGNORECASE,
            )
            if m_buy_person and not inv.buyer_name and len(m_buy_person.group(1).strip()) >= 2:
                set_field("buyer_name", m_buy_person.group(1).strip(), line_obj)
            elif m_buy_unit and not m_buy_person and len(m_buy_unit.group(1).strip()) >= 2:
                set_field("buyer_name", m_buy_unit.group(1).strip(), line_obj)

        # 6. Nếu ở phần đầu hóa đơn (HEADER) có tên Công ty (CÔNG TY TNHH / CÔNG TY CỔ PHẦN) trước khi gặp vùng BUYER
        if not inv.seller_name and current_zone in ("HEADER", "SELLER"):
            if re.search(r"\b(công ty|cong ty|doanh nghiệp|doanh nghiep|tập đoàn|tap doan|chi nhánh|chi nhanh|hợp tác xã)\b", lower):
                if not any(b in lower for b in BUYER_MARKERS) and "người mua" not in lower and "nguoi mua" not in lower:
                    cleaned_company = re.sub(
                        r"^(?:đơn vị bán hàng|don vi ban hang|người bán|nguoi ban)\s*(?:\([^)]*\))?\s*[:\-]?\s*",
                        "",
                        raw,
                        flags=re.IGNORECASE,
                    ).strip()
                    if len(cleaned_company) >= 5:
                        set_field("seller_name", cleaned_company, line_obj)
                        current_zone = "SELLER"

        # 7. Mã số thuế (MST) — Phân biệt rõ MST người bán và MST người mua
        if any(k in lower for k in ["mã số thuế", "ma so thue", "mst", "tax code", "tax id"]):
            mst_match = MST_REGEX.search(raw)
            if mst_match:
                mst_val = re.sub(r"\s+", "", mst_match.group(1))
                # Kiểm tra nhãn trực tiếp trên dòng trước tiên
                if any(b in lower for b in ["mua", "buyer", "customer", "khách hàng"]):
                    if not inv.buyer_tax_id:
                        set_field("buyer_tax_id", mst_val, line_obj)
                elif any(s in lower for s in ["bán", "seller", "vendor", "supplier"]):
                    if not inv.seller_tax_id:
                        set_field("seller_tax_id", mst_val, line_obj)
                else:
                    # Dựa vào vùng ngữ cảnh (current_zone)
                    if current_zone == "BUYER":
                        if not inv.buyer_tax_id:
                            set_field("buyer_tax_id", mst_val, line_obj)
                    elif current_zone in ("HEADER", "SELLER"):
                        if not inv.seller_tax_id:
                            set_field("seller_tax_id", mst_val, line_obj)
                        elif not inv.buyer_tax_id and mst_val != inv.seller_tax_id:
                            set_field("buyer_tax_id", mst_val, line_obj)

        # 8. Địa chỉ người bán
        if not inv.seller_address and current_zone in ("HEADER", "SELLER"):
            m_addr = re.search(
                r"(?:địa chỉ|dia chi|address)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)",
                raw,
                re.IGNORECASE,
            )
            if m_addr and len(m_addr.group(1).strip()) >= 5:
                set_field("seller_address", m_addr.group(1).strip(), line_obj)

        # 9. Tiền hàng trước thuế, Thuế suất, Tiền thuế, Chiết khấu, Tổng tiền thanh toán
        # Thuế suất GTGT (ví dụ: 8%, 10%, 5%, 0%, KCT)
        if not inv.vat_rate and any(k in lower for k in ["thuế suất", "thue suat", "vat rate", "thuế gtgt"]):
            m_rate = re.search(r"(\d{1,2}\s*%|kct|không chịu thuế)", lower)
            if m_rate:
                set_field("vat_rate", m_rate.group(1).replace(" ", "").upper(), line_obj)

        # Tìm các con số ở cuối dòng cho các trường tiền tệ
        numbers_in_line = re.findall(r"(?<!\d)\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\b\d{4,12}\b", raw)
        last_amount: Optional[float] = None
        if numbers_in_line:
            last_amount = parse_vietnamese_number(numbers_in_line[-1])

        if last_amount is not None:
            if any(
                k in lower
                for k in [
                    "cộng tiền hàng", "cong tien hang", "tiền trước thuế",
                    "thành tiền chưa có thuế", "total amount without vat", "subtotal"
                ]
            ):
                if inv.subtotal_amount is None:
                    set_field("subtotal_amount", last_amount, line_obj)
            elif any(
                k in lower
                for k in [
                    "tiền thuế gtgt", "tien thue gtgt", "cộng tiền thuế",
                    "thuế giá trị gia tăng", "vat amount", "tax amount"
                ]
            ) and "tổng cộng" not in lower:
                if inv.vat_amount is None:
                    set_field("vat_amount", last_amount, line_obj)
            elif any(k in lower for k in ["chiết khấu", "chiet khau", "giảm trừ", "discount"]):
                if inv.discount_amount is None:
                    set_field("discount_amount", last_amount, line_obj)
            elif any(
                k in lower
                for k in [
                    "tổng cộng tiền thanh toán", "tong cong tien thanh toan",
                    "tổng tiền thanh toán", "tổng thanh toán", "total payment",
                    "grand total", "total amount"
                ]
            ):
                set_field("total_amount", last_amount, line_obj)

        # 10. Loại tiền tệ
        if any(k in lower for k in ["đơn vị tiền tệ", "loại tiền", "currency", "tỷ giá"]):
            if "usd" in lower:
                set_field("currency", "USD", line_obj)
            elif "eur" in lower:
                set_field("currency", "EUR", line_obj)
            elif "vnd" in lower or "vnđ" in lower:
                set_field("currency", "VND", line_obj)

        # 11. Thu thập tóm tắt hàng hóa/dịch vụ trong vùng TABLE
        if current_zone == "TABLE":
            # Dòng bắt đầu bằng số thứ tự (1, 2, 3...) nhưng không phải dòng công thức cột (1) (2) (3)
            m_item = re.match(r"^\s*(\d{1,2})\s+([A-Za-zÀ-ỹ0-9][^:]{4,90})", raw)
            if m_item and not any(
                stop in lower
                for stop in ["cộng tiền", "thuế suất", "tổng cộng", "số tiền viết bằng chữ"]
            ):
                desc = m_item.group(2).split("   ")[0].strip()
                if len(desc) >= 3 and desc not in item_descriptions:
                    item_descriptions.append(desc)

    if item_descriptions:
        inv.items_summary = "; ".join(item_descriptions[:5])
        inv.field_sources["items_summary"] = inv.extraction_method

    # Đánh dấu các trường bắt buộc nếu chưa tìm thấy hoặc có độ tin cậy OCR thấp (< 0.85)
    required_fields = [
        "seller_name",
        "seller_tax_id",
        "invoice_number",
        "invoice_date",
        "subtotal_amount",
        "vat_amount",
        "total_amount",
    ]
    for req in required_fields:
        val = getattr(inv, req)
        conf = inv.field_confidences.get(req, 0.0)
        if val is None or val == "" or (conf > 0 and conf < 0.85):
            if req not in inv.uncertain_fields:
                inv.uncertain_fields.append(req)

    return inv
