# -*- coding: utf-8 -*-
"""
Module kiểm tra dữ liệu hóa đơn và phát hiện trùng lặp (Validation & Duplicate Detection).
Thực hiện:
- Sử dụng Decimal cho toàn bộ phép tính tiền tệ nhằm loại bỏ sai số dấu chấm động nhị phân.
- Kiểm tra định dạng Mã số thuế (10 chữ số hoặc 13 chữ số có dấu gạch ngang).
- Kiểm tra tính hợp lệ của ngày lập hóa đơn.
- Kiểm tra phương trình kế toán: Tiền hàng trước thuế - Chiết khấu + Tiền thuế ≈ Tổng thanh toán
  (hỗ trợ dung sai làm tròn cấu hình được, hóa đơn không chịu thuế KCT/0% và chiết khấu đã trừ sẵn).
- Phát hiện trùng lặp 3 mức:
  1. Trùng file vật lý (cùng mã băm SHA-256) -> DUPLICATE_FILE_HASH (ERROR).
  2. Trùng hóa đơn chắc chắn (cùng MST người bán + Số hóa đơn + Ký hiệu tương thích) -> DUPLICATE_INVOICE_EXACT (ERROR).
  3. Nghi ngờ trùng (cùng Số hóa đơn + cùng Tổng tiền/Ngày lập khi thiếu MST hoặc khác Ký hiệu;
     hoặc cùng MST bán + Ngày lập + Tổng tiền khi thiếu Số hóa đơn) -> DUPLICATE_INVOICE_SUSPECTED (WARNING).
- Thứ tự ưu tiên trạng thái (Status Hierarchy):
  * ERROR            : Lỗi tệp không đọc được hoặc hỏng hoàn toàn.
  * DUPLICATE_WARNING: Phát hiện trùng hoặc nghi ngờ trùng (ưu tiên hiển thị cao hơn NEEDS_REVIEW để
                       không bao giờ bị ghi đè mất cảnh báo trùng, đồng thời vẫn giữ đủ lỗi toán học trong validation_issues).
  * NEEDS_REVIEW     : Có lỗi/cảnh báo trường dữ liệu hoặc sai lệch số học cần kế toán kiểm tra.
  * VERIFIED         : Đầy đủ trường bắt buộc, khớp số học và không bị trùng.
"""
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import List, Optional
from .models import ExtractedInvoice, ValidationIssue

VALID_MST_PATTERN = re.compile(r"^\d{10}(-\d{3})?$")

STATUS_PRIORITY = {
    "VERIFIED": 1,
    "NEEDS_REVIEW": 2,
    "DUPLICATE_WARNING": 3,
    "ERROR": 4,
}


def _to_dec(val: Optional[float]) -> Optional[Decimal]:
    if val is None:
        return None
    try:
        return Decimal(str(val))
    except (InvalidOperation, ValueError):
        return None


def _normalize_invoice_number(raw_num: str) -> str:
    cleaned = re.sub(r"\s+", "", (raw_num or "").strip())
    if not cleaned:
        return ""
    stripped = cleaned.lstrip("0")
    return stripped if stripped else "0"


def _normalize_mst(raw_mst: str) -> str:
    return re.sub(r"\s+", "", (raw_mst or "").strip())


def _normalize_symbol(raw_sym: str) -> str:
    return re.sub(r"\s+", "", (raw_sym or "").strip().upper())


def validate_single_invoice(inv: ExtractedInvoice, rounding_tolerance: float = 5.0) -> ExtractedInvoice:
    # Giữ lại các lỗi trùng lặp cấp lô (nếu có từ trước) để không làm mất khi kiểm tra đơn lẻ
    existing_dup_issues = [
        iss for iss in inv.validation_issues if iss.code.startswith("DUPLICATE_")
    ]
    issues: List[ValidationIssue] = []

    # 1. Kiểm tra Người bán & MST người bán
    if not (inv.seller_name or "").strip():
        issues.append(
            ValidationIssue(
                code="MISSING_SELLER_NAME",
                severity="WARNING",
                field="seller_name",
                message="Chưa nhận diện được Tên người bán. Cần kiểm tra đối chiếu với file PDF gốc.",
            )
        )
        if "seller_name" not in inv.uncertain_fields:
            inv.uncertain_fields.append("seller_name")

    seller_mst = _normalize_mst(inv.seller_tax_id)
    if not seller_mst:
        issues.append(
            ValidationIssue(
                code="MISSING_SELLER_MST",
                severity="ERROR",
                field="seller_tax_id",
                message="Thiếu Mã số thuế người bán.",
            )
        )
        if "seller_tax_id" not in inv.uncertain_fields:
            inv.uncertain_fields.append("seller_tax_id")
    elif not VALID_MST_PATTERN.match(seller_mst):
        issues.append(
            ValidationIssue(
                code="INVALID_SELLER_MST_FORMAT",
                severity="ERROR",
                field="seller_tax_id",
                message=f"MST người bán '{inv.seller_tax_id}' không đúng định dạng chuẩn (10 số hoặc 10-3 số).",
            )
        )

    # 2. Kiểm tra MST người mua nếu có
    buyer_mst = _normalize_mst(inv.buyer_tax_id)
    if buyer_mst and not VALID_MST_PATTERN.match(buyer_mst):
        issues.append(
            ValidationIssue(
                code="INVALID_BUYER_MST_FORMAT",
                severity="WARNING",
                field="buyer_tax_id",
                message=f"MST người mua '{inv.buyer_tax_id}' không đúng định dạng chuẩn.",
            )
        )

    # Kiểm tra trùng MST người bán và người mua (dấu hiệu nhận diện nhầm)
    if seller_mst and buyer_mst and seller_mst == buyer_mst:
        issues.append(
            ValidationIssue(
                code="SAME_SELLER_BUYER_MST",
                severity="ERROR",
                field="buyer_tax_id",
                message="MST người bán và MST người mua trùng nhau. Vui lòng kiểm tra có bị gán nhầm không.",
            )
        )

    # 3. Kiểm tra Số hóa đơn & Ngày hóa đơn
    if not (inv.invoice_number or "").strip():
        issues.append(
            ValidationIssue(
                code="MISSING_INVOICE_NUMBER",
                severity="ERROR",
                field="invoice_number",
                message="Thiếu Số hóa đơn.",
            )
        )
        if "invoice_number" not in inv.uncertain_fields:
            inv.uncertain_fields.append("invoice_number")

    if not (inv.invoice_date or "").strip():
        issues.append(
            ValidationIssue(
                code="MISSING_INVOICE_DATE",
                severity="WARNING",
                field="invoice_date",
                message="Thiếu Ngày lập hóa đơn.",
            )
        )
        if "invoice_date" not in inv.uncertain_fields:
            inv.uncertain_fields.append("invoice_date")
    else:
        try:
            datetime.strptime(inv.invoice_date.strip(), "%Y-%m-%d")
        except ValueError:
            issues.append(
                ValidationIssue(
                    code="INVALID_INVOICE_DATE",
                    severity="ERROR",
                    field="invoice_date",
                    message=f"Ngày hóa đơn '{inv.invoice_date}' không hợp lệ (cần dạng YYYY-MM-DD).",
                )
            )

    # 4. Kiểm tra các trường tiền tệ và quan hệ toán học bằng Decimal
    tol_dec = _to_dec(rounding_tolerance) or Decimal("5.0")
    sub_dec = _to_dec(inv.subtotal_amount)
    vat_dec = _to_dec(inv.vat_amount)
    disc_dec = _to_dec(inv.discount_amount) or Decimal("0")
    tot_dec = _to_dec(inv.total_amount)

    if tot_dec is None:
        issues.append(
            ValidationIssue(
                code="MISSING_TOTAL_AMOUNT",
                severity="ERROR",
                field="total_amount",
                message="Thiếu Tổng tiền thanh toán.",
            )
        )
        if "total_amount" not in inv.uncertain_fields:
            inv.uncertain_fields.append("total_amount")
    elif tot_dec < Decimal("0"):
        issues.append(
            ValidationIssue(
                code="NEGATIVE_TOTAL_AMOUNT",
                severity="WARNING",
                field="total_amount",
                message=f"Tổng tiền thanh toán âm ({float(tot_dec):,.0f}). Cần kiểm tra xem đây có phải hóa đơn điều chỉnh giảm không.",
            )
        )
    elif sub_dec is not None and vat_dec is not None:
        expected_with_disc = sub_dec - disc_dec + vat_dec
        expected_no_disc = sub_dec + vat_dec
        diff_with_disc = abs(expected_with_disc - tot_dec)
        diff_no_disc = abs(expected_no_disc - tot_dec)

        # Chấp nhận nếu khớp công thức có trừ chiết khấu hoặc chiết khấu đã được trừ sẵn trong tiền hàng
        best_diff = min(diff_with_disc, diff_no_disc)
        if best_diff > tol_dec:
            issues.append(
                ValidationIssue(
                    code="MATH_MISMATCH_TOTAL",
                    severity="ERROR",
                    field="total_amount",
                    message=(
                        f"Sai lệch cộng tiền: Tiền trước thuế ({float(sub_dec):,.0f}) "
                        f"- Chiết khấu ({float(disc_dec):,.0f}) + Tiền thuế ({float(vat_dec):,.0f}) "
                        f"= {float(expected_with_disc):,.0f}, lệch {float(diff_with_disc):,.0f} "
                        f"so với Tổng thanh toán ({float(tot_dec):,.0f})."
                    ),
                )
            )
            if "total_amount" not in inv.uncertain_fields:
                inv.uncertain_fields.append("total_amount")

        # Kiểm tra thuế suất nếu có (ví dụ: 5%, 8%, 10%)
        vat_rate_clean = (inv.vat_rate or "").strip().upper()
        if vat_rate_clean.endswith("%") and sub_dec > Decimal("0"):
            try:
                rate_num = Decimal(vat_rate_clean.replace("%", "").strip()) / Decimal("100")
                expected_vat_1 = (sub_dec - disc_dec) * rate_num
                expected_vat_2 = sub_dec * rate_num
                vat_diff = min(abs(expected_vat_1 - vat_dec), abs(expected_vat_2 - vat_dec))
                allowed_vat_tol = max(tol_dec, sub_dec * Decimal("0.002"))
                if vat_diff > allowed_vat_tol:
                    issues.append(
                        ValidationIssue(
                            code="VAT_RATE_MISMATCH",
                            severity="WARNING",
                            field="vat_amount",
                            message=(
                                f"Tiền thuế ({float(vat_dec):,.0f}) lệch so với mức thuế suất {inv.vat_rate} "
                                f"(dự kiến ~{float(expected_vat_1):,.0f}). Có thể hóa đơn có nhiều mức thuế suất."
                            ),
                        )
                    )
            except (InvalidOperation, ValueError):
                pass
    elif sub_dec is not None and vat_dec is None:
        # Trường hợp hóa đơn KCT / 0% hoặc thiếu dòng tiền thuế
        diff_sub_tot = abs((sub_dec - disc_dec) - tot_dec)
        if diff_sub_tot > tol_dec:
            issues.append(
                ValidationIssue(
                    code="MISSING_VAT_OR_MATH_MISMATCH",
                    severity="WARNING",
                    field="vat_amount",
                    message=(
                        f"Chưa có Tiền thuế GTGT và Tiền hàng ({float(sub_dec):,.0f}) "
                        f"khác Tổng thanh toán ({float(tot_dec):,.0f})."
                    ),
                )
            )

    inv.validation_issues = issues + existing_dup_issues

    # Xác định trạng thái xác minh theo đúng thứ tự ưu tiên:
    # DUPLICATE_WARNING > NEEDS_REVIEW > VERIFIED (trừ khi đã là ERROR)
    if existing_dup_issues:
        inv.verification_status = "DUPLICATE_WARNING"
        return inv

    has_error = any(i.severity == "ERROR" for i in issues)
    has_warning = any(i.severity == "WARNING" for i in issues)

    if inv.verification_status == "VERIFIED" and not has_error and not has_warning:
        inv.verification_status = "VERIFIED"
    elif has_error or has_warning or len(inv.uncertain_fields) > 0:
        inv.verification_status = "NEEDS_REVIEW"
    else:
        inv.verification_status = "VERIFIED"

    return inv


def validate_invoice_batch(
    invoices: List[ExtractedInvoice],
    rounding_tolerance: float = 5.0,
) -> List[ExtractedInvoice]:
    """
    Kiểm tra từng hóa đơn và phát hiện trùng lặp trong toàn bộ lô (batch).
    Đảm bảo không bao giờ để NEEDS_REVIEW ghi đè lên DUPLICATE_WARNING,
    và không gán nhầm DUPLICATE_WARNING cho hóa đơn không trùng trong cùng lô.
    """
    tol_dec = _to_dec(rounding_tolerance) or Decimal("5.0")

    # Bước 1: Xóa các cảnh báo trùng cũ trước khi chạy kiểm tra đơn lẻ
    for inv in invoices:
        inv.validation_issues = [
            iss for iss in inv.validation_issues if not iss.code.startswith("DUPLICATE_")
        ]
        if inv.verification_status == "DUPLICATE_WARNING":
            inv.verification_status = "NEEDS_REVIEW"
        validate_single_invoice(inv, rounding_tolerance=rounding_tolerance)

    # Bước 2: Đối chiếu từng cặp hóa đơn trong lô để phát hiện trùng lặp
    n = len(invoices)
    for i in range(n):
        for j in range(i + 1, n):
            a = invoices[i]
            b = invoices[j]

            # 1. Trùng file vật lý (SHA-256 giống hệt nhau)
            if a.file_sha256 and b.file_sha256 and a.file_sha256 == b.file_sha256:
                msg_a = f"Trùng nội dung file PDF (cùng mã băm SHA-256) với file '{b.source_filename}'."
                msg_b = f"Trùng nội dung file PDF (cùng mã băm SHA-256) với file '{a.source_filename}'."
                _append_duplicate_issue(a, "DUPLICATE_FILE_HASH", "ERROR", "source_filename", msg_a)
                _append_duplicate_issue(b, "DUPLICATE_FILE_HASH", "ERROR", "source_filename", msg_b)
                continue

            num_a = _normalize_invoice_number(a.invoice_number)
            num_b = _normalize_invoice_number(b.invoice_number)
            mst_a = _normalize_mst(a.seller_tax_id)
            mst_b = _normalize_mst(b.seller_tax_id)
            sym_a = _normalize_symbol(a.invoice_symbol)
            sym_b = _normalize_symbol(b.invoice_symbol)
            tot_a = _to_dec(a.total_amount)
            tot_b = _to_dec(b.total_amount)
            same_total = (
                tot_a is not None
                and tot_b is not None
                and abs(tot_a - tot_b) <= tol_dec
            )
            same_date = bool(a.invoice_date.strip() and a.invoice_date.strip() == b.invoice_date.strip())

            # 2. Cùng Số hóa đơn (sau khi chuẩn hóa số 0 ở đầu)
            if num_a and num_a == num_b:
                if mst_a and mst_a == mst_b and (not sym_a or not sym_b or sym_a == sym_b):
                    # Trùng hóa đơn chắc chắn
                    msg_a = (
                        f"Trùng Số hóa đơn ({a.invoice_number}) và MST người bán ({mst_a}) "
                        f"với file '{b.source_filename}'."
                    )
                    msg_b = (
                        f"Trùng Số hóa đơn ({b.invoice_number}) và MST người bán ({mst_b}) "
                        f"với file '{a.source_filename}'."
                    )
                    _append_duplicate_issue(a, "DUPLICATE_INVOICE_EXACT", "ERROR", "invoice_number", msg_a)
                    _append_duplicate_issue(b, "DUPLICATE_INVOICE_EXACT", "ERROR", "invoice_number", msg_b)
                elif same_total or (same_date and (not mst_a or not mst_b or mst_a == mst_b)):
                    # Nghi ngờ trùng: cùng Số hóa đơn + cùng Tổng tiền (hoặc cùng Ngày lập khi thiếu MST/khác Ký hiệu)
                    total_str_a = f"{float(tot_a):,.0f}" if tot_a is not None else "N/A"
                    total_str_b = f"{float(tot_b):,.0f}" if tot_b is not None else "N/A"
                    msg_a = (
                        f"Nghi ngờ trùng: Cùng Số hóa đơn ({a.invoice_number}) và cùng Tổng tiền "
                        f"({total_str_a}) với file '{b.source_filename}', cần đối chiếu MST/Ký hiệu."
                    )
                    msg_b = (
                        f"Nghi ngờ trùng: Cùng Số hóa đơn ({b.invoice_number}) và cùng Tổng tiền "
                        f"({total_str_b}) với file '{a.source_filename}', cần đối chiếu MST/Ký hiệu."
                    )
                    _append_duplicate_issue(a, "DUPLICATE_INVOICE_SUSPECTED", "WARNING", "invoice_number", msg_a)
                    _append_duplicate_issue(b, "DUPLICATE_INVOICE_SUSPECTED", "WARNING", "invoice_number", msg_b)
            elif (not num_a or not num_b) and mst_a and mst_a == mst_b and same_date and same_total:
                # 3. Trường hợp một trong hai hóa đơn bị mờ/khuyết Số hóa đơn nhưng trùng cả MST bán + Ngày lập + Tổng tiền
                msg_a = (
                    f"Nghi ngờ trùng: Cùng MST người bán ({mst_a}), cùng Ngày ({a.invoice_date}) "
                    f"và cùng Tổng tiền ({float(tot_a):,.0f}) với file '{b.source_filename}'."
                )
                msg_b = (
                    f"Nghi ngờ trùng: Cùng MST người bán ({mst_b}), cùng Ngày ({b.invoice_date}) "
                    f"và cùng Tổng tiền ({float(tot_b):,.0f}) với file '{a.source_filename}'."
                )
                _append_duplicate_issue(a, "DUPLICATE_INVOICE_SUSPECTED", "WARNING", "invoice_number", msg_a)
                _append_duplicate_issue(b, "DUPLICATE_INVOICE_SUSPECTED", "WARNING", "invoice_number", msg_b)

    return invoices


def _append_duplicate_issue(
    inv: ExtractedInvoice,
    code: str,
    severity: str,
    field: str,
    message: str,
) -> None:
    if not any(iss.code == code and iss.message == message for iss in inv.validation_issues):
        inv.validation_issues.append(
            ValidationIssue(code=code, severity=severity, field=field, message=message)
        )
    if field not in inv.uncertain_fields:
        inv.uncertain_fields.append(field)
    inv.verification_status = "DUPLICATE_WARNING"
