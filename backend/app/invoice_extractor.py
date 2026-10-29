# -*- coding: utf-8 -*-
"""
Bộ trích xuất trường dữ liệu hóa đơn tiếng Việt & tiếng Anh (có thể kiểm thử độc lập).
Đặc điểm thiết kế:
- Chuẩn hóa Unicode NFC và tích hợp bộ đối sánh gấp dấu tiếng Việt sang ASCII (fold_vn_ascii),
  đảm bảo nhận diện chính xác bất kể văn bản đầu vào ở dạng NFC, NFD hay mất dấu OCR.
- Tách nhãn người bán / người mua triệt để (hỗ trợ dấu hai chấm thường ':', dấu hai chấm
  toàn chiều rộng '：', dấu gạch ngang, nhãn song ngữ trong ngoặc như '(Seller)', '(Buyer)')
  mà không làm mất dấu hai chấm hợp lệ nằm bên trong tên công ty.
- Phân tách rõ vùng Người bán (Seller Zone) và vùng Người mua (Buyer Zone) dựa trên nhãn ngữ cảnh
  và thứ tự xuất hiện không gian trên hóa đơn, tuyệt đối không gán nhầm MST hoặc tên người mua
  sang người bán.
- Nếu không tìm thấy trường dữ liệu, giữ nguyên giá trị trống/None và đưa vào danh sách
  uncertain_fields để người dùng kiểm tra (không tự bịa giá trị).
"""
import re
import unicodedata
from typing import List, Optional, Tuple
from .models import OcrTextLine, ExtractedInvoice

# Biểu thức chính quy cho Mã số thuế Việt Nam (10 chữ số hoặc 10-3 chữ số, có thể có khoảng trắng вокруг dấu gạch ngang)
MST_REGEX = re.compile(r"(?<!\d)(\d{10}(?:\s*-\s*\d{3})?)(?!\d)")

# Các từ khóa đã gấp dấu (ASCII-folded) để không bao giờ bị ảnh hưởng bởi lỗi bảng mã NFD/NFC hoặc CP1252
SELLER_FOLDED_MARKERS = [
    "don vi ban hang",
    "ten don vi ban hang",
    "ten don vi ban",
    "don vi ban",
    "ten nguoi ban",
    "nguoi ban hang",
    "nguoi ban",
    "ben ban",
    "cong ty ban hang",
    "don vi xuat hoa don",
    "cong ty xuat hoa don",
    "nha cung cap",
    "seller",
    "vendor",
    "supplier",
    "merchandiser",
    "issued by",
]

BUYER_FOLDED_MARKERS = [
    "ho ten nguoi mua hang",
    "ho va ten nguoi mua hang",
    "ho ten nguoi mua",
    "nguoi mua hang",
    "don vi mua hang",
    "ten don vi mua hang",
    "ten don vi mua",
    "don vi mua",
    "ten nguoi mua",
    "nguoi mua",
    "ben mua",
    "khach hang",
    "ten khach hang",
    "buyer",
    "customer",
    "bill to",
    "sold to",
    "purchaser",
]

TABLE_START_FOLDED_MARKERS = [
    "stt",
    "ten hang hoa",
    "dich vu",
    "don vi tinh",
    "so luong",
    "don gia",
    "thanh tien",
    "description",
    "quantity",
    "unit price",
]

# Biểu thức nhận diện tiền tố nhãn Người bán ở đầu dòng (bao gồm cả chữ có dấu, không dấu và tiếng Anh)
SELLER_LABEL_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"tên\s+đơn\s+vị\s+bán(?:\s+hàng)?|ten\s+don\s+vi\s+ban(?:\s+hang)?|"
    r"đơn\s+vị\s+bán(?:\s+hàng)?|don\s+vi\s+ban(?:\s+hang)?|"
    r"tên\s+người\s+bán(?:\s+hàng)?|ten\s+nguoi\s+ban(?:\s+hang)?|"
    r"người\s+bán(?:\s+hàng)?|nguoi\s+ban(?:\s+hang)?|"
    r"bên\s+bán|ben\s+ban|bên\s+a|ben\s+a|"
    r"công\s+ty\s+bán(?:\s+hàng)?|cong\s+ty\s+ban(?:\s+hang)?|"
    r"đơn\s+vị\s+xuất\s+hóa\s+đơn|don\s+vi\s+xuat\s+hoa\s+don|"
    r"công\s+ty\s+xuất\s+hóa\s+đơn|cong\s+ty\s+xuat\s+hoa\s+don|"
    r"nhà\s+cung\s+cấp|nha\s+cung\s+cap|"
    r"seller(?:'s)?\s*name|seller|vendor|supplier|merchandiser|issued\s+by"
    r")"
    r"(?:\s*\([^)]*\))*"
    r"(?:\s*/\s*(?:seller(?:'s)?\s*name|seller|vendor|supplier))?"
    r"\s*[:：\-\–\—]+\s*",
    re.IGNORECASE,
)

# Biểu thức nhận diện tiền tố nhãn Đơn vị mua hàng (Company/Unit Buyer) ở đầu dòng
BUYER_UNIT_LABEL_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"tên\s+đơn\s+vị(?:\s+mua(?:\s+hàng)?)?|ten\s+don\s+vi(?:\s+mua(?:\s+hang)?)?|"
    r"đơn\s+vị\s+mua(?:\s+hàng)?|don\s+vi\s+mua(?:\s+hang)?|"
    r"tên\s+người\s+mua|ten\s+nguoi\s+mua|"
    r"tên\s+khách\s+hàng|ten\s+khach\s+hang|khách\s+hàng|khach\s+hang|"
    r"bên\s+mua|ben\s+mua|bên\s+b|ben\s+b|"
    r"buyer(?:'s)?\s*name|buyer|customer(?:'s)?\s*name|customer|company\s*name|bill\s+to|sold\s+to|purchaser"
    r")"
    r"(?:\s*\([^)]*\))*"
    r"(?:\s*/\s*(?:buyer|customer|company\s*name))?"
    r"\s*[:：\-\–\—]+\s*",
    re.IGNORECASE,
)

# Biểu thức nhận diện tiền tố nhãn Họ tên người mua hàng (Cá nhân) ở đầu dòng
BUYER_PERSON_LABEL_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"họ\s+và\s+tên\s+người\s+mua(?:\s+hàng)?|ho\s+va\s+ten\s+nguoi\s+mua(?:\s+hang)?|"
    r"họ\s+tên\s+người\s+mua(?:\s+hàng)?|ho\s+ten\s+nguoi\s+mua(?:\s+hang)?|"
    r"người\s+mua\s+hàng|nguoi\s+mua\s+hang|"
    r"người\s+mua|nguoi\s+mua"
    r")"
    r"(?:\s*\([^)]*\))*"
    r"\s*[:：\-\–\—]+\s*",
    re.IGNORECASE,
)


def normalize_vn_text(text: str) -> str:
    """
    Chuẩn hóa chuỗi tiếng Việt về dạng NFC chuẩn và tự động khôi phục nếu chuỗi bị lỗi
    mã hóa UTF-8 đọc nhầm theo Latin-1/CP1252 (mojibake).
    """
    if not text:
        return ""
    # Khôi phục nếu có dấu hiệu mojibake phổ biến (ví dụ: 'Đơn vị' -> 'Ä\x90Æ¡n vá»‹' hoặc 'ngÆ°á»i')
    if any(marker in text for marker in ("Ã", "Æ°", "á»", "Ä‘", "Ä\x90")):
        for enc in ("latin1", "cp1252"):
            try:
                repaired = text.encode(enc).decode("utf-8")
                text = repaired
                break
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
    norm = unicodedata.normalize("NFC", text)
    # Chuẩn hóa khoảng trắng liên tiếp nhưng giữ nguyên cấu trúc cách cột 3 dấu cách cho bảng
    return norm.strip()


def fold_vn_ascii(text: str) -> str:
    """
    Chuyển chuỗi tiếng Việt có dấu thành chuỗi ASCII không dấu chữ thường để đối sánh từ khóa
    bền vững (ví dụ: 'Đơn vị bán hàng (Seller):' -> 'don vi ban hang (seller):').
    """
    if not text:
        return ""
    norm = normalize_vn_text(text)
    replaced = norm.replace("đ", "d").replace("Đ", "D")
    decomposed = unicodedata.normalize("NFD", replaced)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", stripped).lower().strip()


def _is_placeholder_value(val: str) -> bool:
    """Kiểm tra xem giá trị sau nhãn có phải chỉ là dấu chấm '......', gạch ngang '---' hay rỗng không."""
    if not val:
        return True
    cleaned = re.sub(r"[\s._\-–—:：,;]+", "", val)
    return len(cleaned) < 2


def strip_party_label(raw_line: str, role: str = "seller") -> str:
    """
    Loại bỏ phần nhãn Người bán / Người mua ở đầu dòng mà vẫn bảo toàn dấu hai chấm
    hoặc ký tự đặc biệt hợp lệ nằm bên trong tên công ty.
    """
    text = normalize_vn_text(raw_line)
    if not text:
        return ""

    # 1. Thử khớp bằng biểu thức tiền tố chính xác
    if role == "seller":
        cleaned = SELLER_LABEL_PREFIX_RE.sub("", text, count=1)
    elif role == "buyer_unit":
        cleaned = BUYER_UNIT_LABEL_PREFIX_RE.sub("", text, count=1)
    elif role == "buyer_person":
        cleaned = BUYER_PERSON_LABEL_PREFIX_RE.sub("", text, count=1)
    else:
        cleaned = SELLER_LABEL_PREFIX_RE.sub("", text, count=1)

    # 2. Nếu biểu thức chính xác chưa tách được (ví dụ nhãn biến thể hoặc lỗi dấu OCR),
    # kiểm tra phần trước dấu ':' hoặc '：' đầu tiên bằng chuỗi đã gấp dấu ASCII
    if cleaned == text:
        colon_match = re.match(r"^([^:：]{2,48}?)\s*[:：]\s*(.+)$", text)
        if colon_match:
            prefix_folded = fold_vn_ascii(colon_match.group(1))
            remainder = colon_match.group(2).strip()
            if role == "seller" and any(m in prefix_folded for m in SELLER_FOLDED_MARKERS):
                cleaned = remainder
            elif role in ("buyer_unit", "buyer_person", "buyer") and (
                any(m in prefix_folded for m in BUYER_FOLDED_MARKERS)
                or "ten don vi" in prefix_folded
                or "company name" in prefix_folded
            ):
                cleaned = remainder

    # 3. Nếu trên cùng một dòng có chứa cả Mã số thuế ở phía sau (do gom hộp ngang), cắt phần MST ra
    cleaned = re.split(
        r"\s{2,}(?:mã\s+số\s+thuế|ma\s+so\s+thue|mst|tax\s+code|tax\s+id)\b",
        cleaned,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]

    # Chuẩn hóa khoảng trắng thừa bên trong tên công ty
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # Loại bỏ dấu hai chấm hoặc gạch ngang còn sót ở ngay đầu chuỗi (nếu có)
    cleaned = re.sub(r"^[:：\-\–\—]+\s*", "", cleaned).strip()

    if _is_placeholder_value(cleaned):
        return ""
    return cleaned


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
    cleaned = re.sub(r"[^\d.,-]", "", str(raw).strip())
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
    if not text:
        return None
    folded = fold_vn_ascii(text)
    m_vn = re.search(
        r"ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})",
        folded,
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
    buyer_unit_candidate: Optional[Tuple[str, OcrTextLine]] = None
    buyer_person_candidate: Optional[Tuple[str, OcrTextLine]] = None
    item_descriptions: List[str] = []

    for idx, line_obj in enumerate(lines):
        raw = normalize_vn_text(line_obj.text)
        if not raw:
            continue
        lower = raw.lower()
        folded = fold_vn_ascii(raw)

        # 1. Cập nhật vùng ngữ cảnh (Seller vs Buyer vs Table)
        has_buyer_marker = any(m in folded for m in BUYER_FOLDED_MARKERS)
        has_seller_marker = any(m in folded for m in SELLER_FOLDED_MARKERS)

        if has_buyer_marker and not has_seller_marker:
            current_zone = "BUYER"
        elif has_seller_marker and not has_buyer_marker:
            current_zone = "SELLER"
        elif current_zone in ("SELLER", "BUYER") and any(m in folded for m in TABLE_START_FOLDED_MARKERS):
            # Chỉ chuyển sang TABLE khi dòng có ít nhất 2 từ khóa tiêu đề bảng (ví dụ: STT + Tên hàng hóa)
            table_kw_hits = sum(1 for m in TABLE_START_FOLDED_MARKERS if m in folded)
            if table_kw_hits >= 2:
                current_zone = "TABLE"

        # 2. Ký hiệu hóa đơn (Serial / Symbol)
        if not inv.invoice_symbol:
            m_sym = re.search(
                r"(?:ky\s*hieu|serial(?:\s*no\.?)?|mau\s*so\s*[-/]\s*ky\s*hieu)\s*(?:\([^)]*\))?\s*[:：\-]?\s*([A-Z0-9/]{5,14})",
                folded,
                re.IGNORECASE,
            )
            if m_sym:
                set_field("invoice_symbol", m_sym.group(1).strip().upper(), line_obj)

        # 3. Số hóa đơn (Invoice Number)
        if not inv.invoice_number:
            # Nếu dòng có cả Ký hiệu và Số (VD: 'Ký hiệu: 1C26TAA Số: 00001234'), tìm 'Số' bất kể có từ khác
            excluded_number_line = any(
                excl in folded
                for excl in ["ma so thue", "tai khoan", "dien thoai", "so luong", "so thu tu"]
            ) and "so hoa don" not in folded and "invoice no" not in folded
            if not excluded_number_line:
                m_num = re.search(
                    r"(?:so\s*hoa\s*don|invoice\s*(?:no\.?|number)|(?:\bso\b|\bno\.?)\s*(?:\([^)]*\))?)\s*[:：\-]?\s*([0-9]{1,12})\b",
                    folded,
                    re.IGNORECASE,
                )
                if m_num:
                    set_field("invoice_number", m_num.group(1).strip(), line_obj)

        # 4. Ngày lập hóa đơn
        if not inv.invoice_date:
            if any(k in folded for k in ["ngay", "date", "thang", "nam"]):
                # Tránh nhầm ngày hợp đồng hoặc ngày giao hàng nếu đã ở vùng TABLE/FOOTER
                if current_zone in ("HEADER", "SELLER", "BUYER") or not inv.invoice_date:
                    norm_dt = normalize_date_str(raw)
                    if norm_dt:
                        set_field("invoice_date", norm_dt, line_obj)

        # 5. Tên người bán (Seller Name) — Tách nhãn triệt để
        if has_seller_marker and not has_buyer_marker and not inv.seller_name:
            # Tránh nhầm dòng chỉ có 'Mã số thuế người bán: 010...' hoặc 'Địa chỉ người bán: ...'
            is_tax_or_addr_only = any(
                folded.startswith(p)
                for p in ("ma so thue", "mst", "tax code", "dia chi", "address", "so tai khoan", "dien thoai")
            )
            if not is_tax_or_addr_only:
                extracted_seller = strip_party_label(raw, role="seller")
                # Đảm bảo kết quả sau khi tách không phải chính là nguyên dòng chứa nhãn chưa tách
                if extracted_seller and extracted_seller != raw and len(extracted_seller) >= 3:
                    set_field("seller_name", extracted_seller, line_obj)
                elif idx + 1 < len(lines):
                    next_raw = normalize_vn_text(lines[idx + 1].text)
                    next_folded = fold_vn_ascii(next_raw)
                    if (
                        len(next_raw) > 4
                        and ":" not in next_raw
                        and "：" not in next_raw
                        and not any(bm in next_folded for bm in BUYER_FOLDED_MARKERS)
                        and not any(
                            next_folded.startswith(p)
                            for p in ("ma so thue", "mst", "dia chi", "so tai khoan")
                        )
                    ):
                        set_field("seller_name", next_raw, lines[idx + 1])

        # 6. Tên người mua (Buyer Name) — Phân biệt rõ Đơn vị mua (công ty) và Họ tên người mua (cá nhân)
        is_buyer_context_line = has_buyer_marker or (
            current_zone == "BUYER"
            and re.match(r"^\s*(?:tên\s+đơn\s+vị|ten\s+don\s+vi|đơn\s+vị|don\s+vi|company\s*name)\b", folded)
        )
        if is_buyer_context_line and not has_seller_marker:
            is_buyer_tax_or_addr_only = any(
                folded.startswith(p)
                for p in ("ma so thue", "mst", "tax code", "dia chi", "address", "so tai khoan", "hinh thuc thanh toan")
            )
            if not is_buyer_tax_or_addr_only:
                is_person_label = any(
                    p in folded
                    for p in ("ho ten nguoi mua", "ho va ten nguoi mua", "nguoi mua hang")
                ) and "don vi" not in folded
                if is_person_label:
                    val_person = strip_party_label(raw, role="buyer_person")
                    if val_person and val_person != raw and not buyer_person_candidate:
                        buyer_person_candidate = (val_person, line_obj)
                else:
                    val_unit = strip_party_label(raw, role="buyer_unit")
                    if val_unit and val_unit != raw and not buyer_unit_candidate:
                        buyer_unit_candidate = (val_unit, line_obj)
                    elif not val_unit and idx + 1 < len(lines):
                        # Trường hợp nhãn 'Tên đơn vị mua:' đứng riêng 1 dòng và tên công ty ở dòng kế tiếp
                        if re.search(r"[:：]\s*$", raw):
                            next_raw = normalize_vn_text(lines[idx + 1].text)
                            next_folded = fold_vn_ascii(next_raw)
                            if (
                                len(next_raw) > 4
                                and ":" not in next_raw
                                and "：" not in next_raw
                                and not any(
                                    next_folded.startswith(p)
                                    for p in ("ma so thue", "mst", "dia chi", "so tai khoan", "stt")
                                )
                            ):
                                buyer_unit_candidate = (next_raw, lines[idx + 1])

        # 7. Suy luận tên Công ty ở phần đầu hóa đơn (HEADER/SELLER) trước khi gặp vùng BUYER
        if not inv.seller_name and current_zone in ("HEADER", "SELLER") and not has_buyer_marker:
            if re.search(
                r"\b(cong\s+ty|doanh\s+nghiep|tap\s+doan|chi\s+nhanh|hop\s+tac\s+xa|ho\s+kinh\s+doanh)\b",
                folded,
            ):
                if "nguoi mua" not in folded and "don vi mua" not in folded and "khach hang" not in folded:
                    cleaned_company = strip_party_label(raw, role="seller")
                    if len(cleaned_company) >= 5:
                        set_field("seller_name", cleaned_company, line_obj)
                        current_zone = "SELLER"

        # 8. Mã số thuế (MST) — Phân biệt rõ MST người bán và MST người mua
        if any(k in folded for k in ["ma so thue", "mst", "tax code", "tax id"]):
            mst_matches = list(MST_REGEX.finditer(raw))
            for mst_match in mst_matches:
                mst_val = re.sub(r"\s+", "", mst_match.group(1))
                # Ngữ cảnh ngay trước vị trí MST trên dòng
                prefix_before_mst = fold_vn_ascii(raw[: mst_match.start()])

                is_explicit_buyer_mst = any(
                    b in prefix_before_mst or b in folded
                    for b in ["nguoi mua", "don vi mua", "ben mua", "buyer", "customer", "khach hang"]
                ) and not any(
                    s in prefix_before_mst
                    for s in ["nguoi ban", "don vi ban", "ben ban", "seller", "vendor"]
                )
                is_explicit_seller_mst = any(
                    s in prefix_before_mst or s in folded
                    for s in ["nguoi ban", "don vi ban", "ben ban", "seller", "vendor", "supplier", "nha cung cap"]
                ) and not is_explicit_buyer_mst

                if is_explicit_buyer_mst:
                    if not inv.buyer_tax_id:
                        set_field("buyer_tax_id", mst_val, line_obj)
                elif is_explicit_seller_mst:
                    if not inv.seller_tax_id:
                        set_field("seller_tax_id", mst_val, line_obj)
                else:
                    # Dựa vào vùng ngữ cảnh (current_zone) — Tuyệt đối không gán MST vùng BUYER cho người bán
                    if current_zone == "BUYER":
                        if not inv.buyer_tax_id:
                            set_field("buyer_tax_id", mst_val, line_obj)
                    elif current_zone in ("HEADER", "SELLER"):
                        if not inv.seller_tax_id:
                            set_field("seller_tax_id", mst_val, line_obj)
                        elif not inv.buyer_tax_id and mst_val != inv.seller_tax_id:
                            set_field("buyer_tax_id", mst_val, line_obj)

        # 9. Địa chỉ người bán
        if not inv.seller_address and current_zone in ("HEADER", "SELLER"):
            m_addr = re.search(
                r"^(?:địa\s*chỉ|dia\s*chi|address)\s*(?:\([^)]*\))?\s*[:：\-]\s*(.+)",
                raw,
                re.IGNORECASE,
            )
            if m_addr and not _is_placeholder_value(m_addr.group(1)):
                addr_clean = m_addr.group(1).strip()
                if len(addr_clean) >= 5:
                    set_field("seller_address", addr_clean, line_obj)

        # 10. Thuế suất, Tiền hàng trước thuế, Tiền thuế, Chiết khấu, Tổng tiền thanh toán
        if not inv.vat_rate and any(k in folded for k in ["thue suat", "vat rate", "thue gtgt"]):
            m_rate = re.search(r"(\d{1,2}\s*%|kct|khong\s+chiu\s+thue|kkknt)", folded)
            if m_rate:
                rate_raw = m_rate.group(1).replace(" ", "").upper()
                if "KHONG" in rate_raw:
                    rate_raw = "KCT"
                set_field("vat_rate", rate_raw, line_obj)

        # Tìm các con số tiền tệ trên dòng
        numbers_in_line = re.findall(
            r"(?<!\d)-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\b\d{4,12}\b",
            raw,
        )
        last_amount: Optional[float] = None
        if numbers_in_line:
            last_amount = parse_vietnamese_number(numbers_in_line[-1])

        if last_amount is not None:
            if any(
                k in folded
                for k in [
                    "cong tien hang",
                    "tien truoc thue",
                    "thanh tien chua co thue",
                    "doanh so mua chua co thue",
                    "total amount without vat",
                    "subtotal",
                ]
            ) and "tong cong tien thanh toan" not in folded:
                if inv.subtotal_amount is None:
                    set_field("subtotal_amount", last_amount, line_obj)
            elif (
                any(
                    k in folded
                    for k in [
                        "tien thue gtgt",
                        "cong tien thue",
                        "thue gia tri gia tang",
                        "vat amount",
                        "tax amount",
                    ]
                )
                and "tong cong" not in folded
            ):
                if inv.vat_amount is None:
                    set_field("vat_amount", last_amount, line_obj)
            elif any(k in folded for k in ["chiet khau", "giam tru", "discount"]):
                if inv.discount_amount is None:
                    set_field("discount_amount", abs(last_amount), line_obj)
            elif any(
                k in folded
                for k in [
                    "tong cong tien thanh toan",
                    "tong tien thanh toan",
                    "tong thanh toan",
                    "total payment",
                    "grand total",
                    "total amount",
                ]
            ) and "without vat" not in folded:
                set_field("total_amount", last_amount, line_obj)

        # 11. Loại tiền tệ
        if any(k in folded for k in ["don vi tien te", "loai tien", "currency", "ty gia"]):
            if "usd" in folded:
                set_field("currency", "USD", line_obj)
            elif "eur" in folded:
                set_field("currency", "EUR", line_obj)
            elif "vnd" in folded:
                set_field("currency", "VND", line_obj)

        # 12. Thu thập tóm tắt hàng hóa/dịch vụ trong vùng TABLE
        if current_zone == "TABLE":
            m_item = re.match(r"^\s*(\d{1,2})\s+([A-Za-zÀ-ỹ0-9][^:：]{4,90})", raw)
            if m_item and not any(
                stop in folded
                for stop in ["cong tien", "thue suat", "tong cong", "so tien viet bang chu"]
            ):
                desc = m_item.group(2).split("   ")[0].strip()
                if len(desc) >= 3 and desc not in item_descriptions:
                    item_descriptions.append(desc)

    # Ưu tiên Tên đơn vị mua (tổ chức/công ty) hơn Họ tên người mua hàng (cá nhân)
    if buyer_unit_candidate:
        set_field("buyer_name", buyer_unit_candidate[0], buyer_unit_candidate[1])
    elif buyer_person_candidate:
        set_field("buyer_name", buyer_person_candidate[0], buyer_person_candidate[1])

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
