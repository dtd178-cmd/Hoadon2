"""
Module kiểm tra dữ liệu hóa đơn và phát hiện trùng lặp (Validation & Duplicate Detection).
Thực hiện:
- Kiểm tra định dạng Mã số thuế (10 chữ số hoặc 13 chữ số có dấu gạch ngang).
- Kiểm tra tính hợp lệ của ngày lập hóa đơn.
- Kiểm tra phương trình kế toán: Tiền hàng trước thuế - Chiết khấu + Tiền thuế ≈ Tổng thanh toán (cho phép sai số làm tròn).
- Phát hiện trùng lặp 3 mức:
  1. Trùng file vật lý (cùng mã băm SHA-256).
  2. Trùng hóa đơn chắc chắn (cùng MST người bán + Ký hiệu + Số hóa đơn).
  3. Nghi ngờ trùng (cùng Số hóa đơn và cùng Tổng tiền hoặc cùng Ngày lập nhưng thiếu MST/Ký hiệu).
- Tuyệt đối không tự động xóa hóa đơn; giữ nguyên và gắn cảnh báo cụ thể.
"""
import re
from datetime import datetime
from typing import List
from .models import ExtractedInvoice, ValidationIssue

VALID_MST_PATTERN = re.compile(r"^\d{10}(-\d{3})?$")


def validate_single_invoice(inv: ExtractedInvoice, rounding_tolerance: float = 5.0) -> ExtractedInvoice:
    issues: List[ValidationIssue] = []

    # 1. Kiểm tra Người bán & MST người bán
    if not inv.seller_name.strip():
        issues.append(
            ValidationIssue(
                code="MISSING_SELLER_NAME",
                severity="WARNING",
                field="seller_name",
                message="Chưa nhận diện được Tên người bán. Cần kiểm tra đối chiếu với file PDF gốc.",
            )
        )

    if not inv.seller_tax_id.strip():
        issues.append(
            ValidationIssue(
                code="MISSING_SELLER_MST",
                severity="ERROR",
                field="seller_tax_id",
                message="Thiếu Mã số thuế người bán.",
            )
        )
    elif not VALID_MST_PATTERN.match(inv.seller_tax_id.strip()):
        issues.append(
            ValidationIssue(
                code="INVALID_SELLER_MST_FORMAT",
                severity="ERROR",
                field="seller_tax_id",
                message=f"MST người bán '{inv.seller_tax_id}' không đúng định dạng chuẩn (10 số hoặc 10-3 số).",
            )
        )

    # 2. Kiểm tra MST người mua nếu có
    if inv.buyer_tax_id.strip() and not VALID_MST_PATTERN.match(inv.buyer_tax_id.strip()):
        issues.append(
            ValidationIssue(
                code="INVALID_BUYER_MST_FORMAT",
                severity="WARNING",
                field="buyer_tax_id",
                message=f"MST người mua '{inv.buyer_tax_id}' không đúng định dạng chuẩn.",
            )
        )

    # Kiểm tra trùng MST người bán và người mua (dấu hiệu nhận diện nhầm)
    if (
        inv.seller_tax_id.strip()
        and inv.buyer_tax_id.strip()
        and inv.seller_tax_id.strip() == inv.buyer_tax_id.strip()
    ):
        issues.append(
            ValidationIssue(
                code="SAME_SELLER_BUYER_MST",
                severity="ERROR",
                field="buyer_tax_id",
                message="MST người bán và MST người mua trùng nhau. Vui lòng kiểm tra có bị gán nhầm không.",
            )
        )

    # 3. Kiểm tra Số hóa đơn & Ngày hóa đơn
    if not inv.invoice_number.strip():
        issues.append(
            ValidationIssue(
                code="MISSING_INVOICE_NUMBER",
                severity="ERROR",
                field="invoice_number",
                message="Thiếu Số hóa đơn.",
            )
        )

    if not inv.invoice_date.strip():
        issues.append(
            ValidationIssue(
                code="MISSING_INVOICE_DATE",
                severity="WARNING",
                field="invoice_date",
                message="Thiếu Ngày lập hóa đơn.",
            )
        )
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

    # 4. Kiểm tra các trường tiền tệ và quan hệ toán học
    if inv.total_amount is None:
        issues.append(
            ValidationIssue(
                code="MISSING_TOTAL_AMOUNT",
                severity="ERROR",
                field="total_amount",
                message="Thiếu Tổng tiền thanh toán.",
            )
        )
    elif inv.subtotal_amount is not None and inv.vat_amount is not None:
        discount = inv.discount_amount or 0.0
        expected_total = inv.subtotal_amount - discount + inv.vat_amount
        diff = abs(expected_total - inv.total_amount)
        if diff > rounding_tolerance:
            issues.append(
                ValidationIssue(
                    code="MATH_MISMATCH_TOTAL",
                    severity="ERROR",
                    field="total_amount",
                    message=(
                        f"Sai lệch cộng tiền: Tiền trước thuế ({inv.subtotal_amount:,.0f}) "
                        f"- Chiết khấu ({discount:,.0f}) + Tiền thuế ({inv.vat_amount:,.0f}) "
                        f"= {expected_total:,.0f}, lệch {diff:,.0f} so với Tổng thanh toán ({inv.total_amount:,.0f})."
                    ),
                )
            )
            if "total_amount" not in inv.uncertain_fields:
                inv.uncertain_fields.append("total_amount")

        # Kiểm tra thuế suất nếu có
        if inv.vat_rate and inv.vat_rate.endswith("%") and inv.subtotal_amount > 0:
            try:
                rate_num = float(inv.vat_rate.replace("%", "").strip()) / 100.0
                expected_vat = (inv.subtotal_amount - discount) * rate_num
                vat_diff = abs(expected_vat - inv.vat_amount)
                if vat_diff > max(rounding_tolerance, inv.subtotal_amount * 0.002):
                    issues.append(
                        ValidationIssue(
                            code="VAT_RATE_MISMATCH",
                            severity="WARNING",
                            field="vat_amount",
                            message=(
                                f"Tiền thuế ({inv.vat_amount:,.0f}) lệch so với mức thuế suất {inv.vat_rate} "
                                f"(dự kiến ~{expected_vat:,.0f})."
                            ),
                        )
                    )
            except ValueError:
                pass

    # Cập nhật danh sách lỗi của hóa đơn (giữ lại lỗi trùng lặp sẽ được tính ở cấp độ Batch)
    inv.validation_issues = issues

    # Xác định trạng thái xác minh
    has_error = any(i.severity == "ERROR" for i in issues)
    has_warning = any(i.severity == "WARNING" for i in issues)
    if inv.verification_status == "VERIFIED" and not has_error:
        pass
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
    """
    for inv in invoices:
        validate_single_invoice(inv, rounding_tolerance=rounding_tolerance)

    n = len(invoices)
    for i in range(n):
        for j in range(i + 1, n):
            a = invoices[i]
            b = invoices[j]

            # 1. Trùng file vật lý (SHA-256 giống hệt nhau)
            if a.file_sha256 and a.file_sha256 == b.file_sha256:
                msg_a = f"Trùng nội dung file PDF (cùng mã băm SHA-256) với file '{b.source_filename}'."
                msg_b = f"Trùng nội dung file PDF (cùng mã băm SHA-256) với file '{a.source_filename}'."
                _append_duplicate_issue(a, "DUPLICATE_FILE_HASH", "ERROR", "source_filename", msg_a)
                _append_duplicate_issue(b, "DUPLICATE_FILE_HASH", "ERROR", "source_filename", msg_b)
                continue

            # 2. Trùng hóa đơn chắc chắn (cùng MST người bán + Số hóa đơn + Ký hiệu nếu có)
            num_a = a.invoice_number.strip().lstrip("0")
            num_b = b.invoice_number.strip().lstrip("0")
            if num_a and num_a == num_b:
                mst_a = a.seller_tax_id.strip()
                mst_b = b.seller_tax_id.strip()
                sym_a = a.invoice_symbol.strip().upper()
                sym_b = b.invoice_symbol.strip().upper()

                if mst_a and mst_a == mst_b and (not sym_a or not sym_b or sym_a == sym_b):
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
                elif a.total_amount is not None and a.total_amount == b.total_amount:
                    # 3. Có dấu hiệu trùng nhưng chưa đủ căn cứ
                    msg_a = (
                        f"Nghi ngờ trùng: Cùng Số hóa đơn ({a.invoice_number}) và cùng Tổng tiền "
                        f"({a.total_amount:,.0f}) với file '{b.source_filename}', cần đối chiếu MST/Ký hiệu."
                    )
                    msg_b = (
                        f"Nghi ngờ trùng: Cùng Số hóa đơn ({b.invoice_number}) và cùng Tổng tiền "
                        f"({b.total_amount:,.0f}) với file '{a.source_filename}', cần đối chiếu MST/Ký hiệu."
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
    inv.verification_status = "DUPLICATE_WARNING"
