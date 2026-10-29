# -*- coding: utf-8 -*-
"""
Module phân tích file Excel mẫu và ghi dữ liệu hóa đơn vào đúng sheet, đúng cột
mà vẫn bảo toàn cấu trúc, công thức, dòng tiêu đề phụ (dòng 6) và định dạng của file mẫu.
Đặc biệt hỗ trợ:
- Mẫu 'ImportEBill_Template_v3': Sheet1, tiêu đề ở dòng 5, dòng 6 chứa đánh số/tiêu đề phụ,
  dữ liệu bắt đầu từ dòng 7, 9 cột nghiệp vụ (A..I), trong đó Cột I tự động bằng Cột H.
- Bất kỳ mẫu bảng kê kế toán .xlsx tùy chỉnh nào của người dùng.
"""
import re
from copy import copy
from pathlib import Path
from typing import Dict, List, Any, Optional
from .models import ExtractedInvoice
from .invoice_extractor import fold_vn_ascii, normalize_vn_text
from .logger import logger

# Từ điển ánh xạ tự động từ tiêu đề cột (cả có dấu và gấp dấu ASCII) sang trường dữ liệu hóa đơn
COLUMN_SYNONYMS: Dict[str, List[str]] = {
    "stt": ["stt", "no", "no.", "số thứ tự", "so thu tu", "index"],
    "invoice_symbol": [
        "ký hiệu", "ky hieu", "mẫu số", "mau so", "ký hiệu hđ",
        "ky hieu hd", "ky hieu hoa don", "serial", "symbol", "series"
    ],
    "invoice_number": [
        "số hóa đơn", "so hoa don", "số hđ", "so hd",
        "invoice no", "invoice number", "bill no", "số", "so"
    ],
    "invoice_date": [
        "ngày hóa đơn", "ngay hoa don", "ngày lập", "ngay lap",
        "ngày tháng", "ngay thang", "ngày hđ", "ngay hd", "ngay", "date", "invoice date"
    ],
    "seller_name": [
        "tên người bán", "ten nguoi ban", "đơn vị bán", "don vi ban",
        "tên đơn vị bán", "ten don vi ban", "nhà cung cấp", "nha cung cap",
        "người bán", "nguoi ban", "seller", "seller name", "vendor", "supplier"
    ],
    "seller_tax_id": [
        "mã số thuế người bán", "ma so thue nguoi ban", "mst người bán", "mst nguoi ban",
        "mst bán", "mst ban", "mst ncc", "mã số thuế", "ma so thue", "mst",
        "tax code", "seller tax id", "vendor tax id"
    ],
    "seller_address": ["địa chỉ người bán", "dia chi nguoi ban", "địa chỉ", "dia chi", "address"],
    "buyer_name": [
        "tên người mua", "ten nguoi mua", "đơn vị mua", "don vi mua",
        "tên đơn vị mua", "ten don vi mua", "khách hàng", "khach hang",
        "người mua", "nguoi mua", "buyer", "buyer name", "customer"
    ],
    "buyer_tax_id": [
        "mst người mua", "mst nguoi mua", "mã số thuế người mua",
        "ma so thue nguoi mua", "mst mua", "buyer tax id", "customer tax id"
    ],
    "items_summary": [
        "nội dung", "noi dung", "mặt hàng", "mat hang", "tên hàng hóa",
        "ten hang hoa", "diễn giải", "dien giai", "hàng hóa dịch vụ",
        "hang hoa dich vu", "description", "item"
    ],
    "subtotal_amount": [
        "tiền trước thuế", "tien truoc thue", "doanh số mua chưa có thuế",
        "doanh so mua chua co thue", "giá trị chưa thuế", "gia tri chua thue",
        "thành tiền chưa thuế", "thanh tien chua thue", "tiền hàng", "tien hang",
        "cộng tiền hàng", "cong tien hang", "subtotal", "amount before tax", "net amount"
    ],
    "vat_rate": ["thuế suất", "thue suat", "% thuế", "% thue", "vat rate", "tax rate"],
    "vat_amount": [
        "tiền thuế", "tien thue", "thuế gtgt", "thue gtgt",
        "tiền thuế gtgt", "tien thue gtgt", "thuế vat", "thue vat",
        "vat amount", "tax amount", "vat"
    ],
    "discount_amount": ["chiết khấu", "chiet khau", "giảm trừ", "giam tru", "discount"],
    "total_amount": [
        "tổng tiền", "tong tien", "tổng thanh toán", "tong thanh toan",
        "tổng tiền thanh toán", "tong tien thanh toan", "tổng cộng", "tong cong",
        "thành tiền", "thanh tien", "giá trị thanh toán", "gia tri thanh toan",
        "total amount", "total payment", "grand total", "total"
    ],
    "equal_col_h": [
        "bằng cột h", "bang cot h", "cột i = cột h", "cot i = cot h",
        "giá trị quy đổi", "gia tri quy doi", "tiền quy đổi", "tien quy doi"
    ],
    "currency": ["loại tiền", "loai tien", "tiền tệ", "tien te", "đvt tiền", "currency"],
    "notes": ["ghi chú", "ghi chu", "note", "notes", "nhận xét"],
    "source_filename": ["tên file", "ten file", "file nguồn", "file nguon", "tệp đính kèm", "source file"],
    "verification_status": ["trạng thái", "trang thai", "xác minh", "xac minh", "status"],
}


def match_header_to_field(header_text: str) -> Optional[str]:
    if not header_text:
        return None
    norm = " ".join(normalize_vn_text(header_text).lower().split())
    folded = fold_vn_ascii(header_text)

    # 1. Ưu tiên khớp chính xác hoàn toàn (cả có dấu và gấp dấu)
    for field_key, synonyms in COLUMN_SYNONYMS.items():
        for syn in synonyms:
            syn_folded = fold_vn_ascii(syn)
            if norm == syn or folded == syn_folded:
                return field_key

    # 2. Kiểm tra chứa cụm từ (ưu tiên cụm từ dài hơn để tránh nhầm 'mst người mua' với 'mst')
    best_field: Optional[str] = None
    best_len = 0
    for field_key, synonyms in COLUMN_SYNONYMS.items():
        for syn in synonyms:
            syn_folded = fold_vn_ascii(syn)
            if (syn in norm or (syn_folded and syn_folded in folded)) and len(syn_folded) > best_len:
                # Tránh khớp từ đơn 'so' vào 'doanh so' hoặc 'mau so'
                if syn_folded == "so" and any(x in folded for x in ("doanh so", "mau so", "ma so")):
                    continue
                best_field = field_key
                best_len = len(syn_folded)
    return best_field


def _is_subheader_or_numbering_row(ws, candidate_row: int, detected_columns: List[Dict[str, Any]]) -> bool:
    """
    Kiểm tra xem dòng ngay dưới dòng tiêu đề chính (ví dụ dòng 6 dưới dòng 5)
    có phải là dòng đánh số thứ tự cột (1), (2), (3)... hoặc dòng tiêu đề phụ / mã cột hay không.
    Nếu đúng, dữ liệu hóa đơn sẽ bắt đầu từ dòng candidate_row + 1 (ví dụ dòng 7).
    """
    if candidate_row > (ws.max_row or 1):
        return False

    # Kiểm tra xem có ô gộp dọc từ dòng header (candidate_row - 1) xuống candidate_row không
    header_row = candidate_row - 1
    for merged_range in ws.merged_cells.ranges:
        if merged_range.min_row == header_row and merged_range.max_row == candidate_row:
            return True

    non_empty_vals: List[str] = []
    numbering_hits = 0
    sub_label_hits = 0

    for col_info in detected_columns:
        c_idx = col_info["col_index"]
        raw_val = ws.cell(row=candidate_row, column=c_idx).value
        if raw_val is None:
            continue
        text = str(raw_val).strip()
        if not text or text.startswith("="):
            continue
        non_empty_vals.append(text)

        # Dạng đánh số cột: (1), (2), [1], 1, 2, 3, A, B, C, Cột 1...
        if re.match(r"^[\(\[]?\d{1,2}[\)\]]?$", text) or re.match(r"^(?:cột|cot|col)\s*\d+$", text, re.I):
            numbering_hits += 1
        # Dạng tiêu đề phụ hoặc ghi chú bắt buộc: '(Bắt buộc)', 'Required', 'dd/mm/yyyy', mã trường...
        elif (
            match_header_to_field(text) is not None
            or any(
                kw in fold_vn_ascii(text)
                for kw in ("bat buoc", "optional", "required", "dd/mm", "yyyy", "ghi chu", "don vi")
            )
            or re.match(r"^[a-z_]{3,25}$", text)
        ):
            sub_label_hits += 1

    if numbering_hits >= 2:
        return True
    if (numbering_hits + sub_label_hits) >= 2 and len(non_empty_vals) >= 2:
        return True
    return False


def analyze_excel_template(template_path: Path) -> Dict[str, Any]:
    """
    Đọc và phân tích cấu trúc file Excel mẫu (.xlsx) do người dùng cung cấp:
    - Danh sách các sheet.
    - Hàng tiêu đề (header_row) và hàng tiêu đề phụ/đánh số (sub_header_row nếu có, ví dụ dòng 6).
    - Hàng bắt đầu ghi dữ liệu (start_data_row, ví dụ dòng 7 trên ImportEBill_Template_v3).
    - Danh sách các cột, vị trí cột, ánh xạ trường hóa đơn gợi ý.
    - Phát hiện quy tắc Cột I = Cột H và các cột có sẵn công thức.
    """
    try:
        import openpyxl
    except ImportError as exc:
        raise RuntimeError(
            "Chưa cài đặt thư viện openpyxl. Hãy chạy: pip install openpyxl==3.1.5"
        ) from exc

    if not template_path.exists():
        raise FileNotFoundError("Không tìm thấy file Excel mẫu.")

    wb = openpyxl.load_workbook(filename=str(template_path), data_only=False)
    sheets_info = []

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        best_header_row = 1
        best_match_count = -1
        detected_columns: List[Dict[str, Any]] = []

        max_scan_row = min(ws.max_row or 1, 20)
        max_scan_col = min(ws.max_column or 1, 40)

        for r in range(1, max_scan_row + 1):
            row_cols = []
            distinct_fields = set()
            distinct_texts = set()
            for c in range(1, max_scan_col + 1):
                val = ws.cell(row=r, column=c).value
                text = str(val).strip() if val is not None else ""
                if text and not text.startswith("="):
                    distinct_texts.add(text)
                    mapped = match_header_to_field(text)
                    if mapped:
                        distinct_fields.add(mapped)
                    row_cols.append(
                        {
                            "col_index": c,
                            "col_letter": openpyxl.utils.get_column_letter(c),
                            "header_text": text,
                            "mapped_field": mapped,
                        }
                    )
            if len(distinct_fields) > best_match_count and len(distinct_texts) >= 2:
                best_match_count = len(distinct_fields)
                best_header_row = r
                detected_columns = row_cols

        # Kiểm tra xem dòng best_header_row + 1 (ví dụ dòng 6 khi header ở dòng 5) có phải dòng tiêu đề phụ / đánh số không
        candidate_sub_row = best_header_row + 1
        has_sub_header_row = _is_subheader_or_numbering_row(ws, candidate_sub_row, detected_columns)
        start_data_row = best_header_row + 2 if has_sub_header_row else best_header_row + 1

        # Nếu có dòng tiêu đề phụ (dòng 6), bổ sung ánh xạ cho các cột ở dòng 5 chưa rõ nghĩa
        if has_sub_header_row:
            for col_info in detected_columns:
                c_idx = col_info["col_index"]
                sub_val = ws.cell(row=candidate_sub_row, column=c_idx).value
                sub_text = str(sub_val).strip() if sub_val is not None else ""
                col_info["sub_header_text"] = sub_text
                if not col_info["mapped_field"] and sub_text:
                    sub_mapped = match_header_to_field(sub_text)
                    if sub_mapped:
                        col_info["mapped_field"] = sub_mapped

        # Quy tắc nghiệp vụ mẫu 9 cột (Sheet1, dòng tiêu đề 5, 9 cột A..I): Cột I tự động bằng Cột H
        col_indices = [col["col_index"] for col in detected_columns]
        is_nine_col_ebill_layout = (
            len(detected_columns) == 9
            and 8 in col_indices
            and 9 in col_indices
            and (best_header_row == 5 or "importebill" in template_path.name.lower())
        )

        formula_columns = []
        for col_info in detected_columns:
            c_idx = col_info["col_index"]
            sample_val = ws.cell(row=start_data_row, column=c_idx).value
            if isinstance(sample_val, str) and sample_val.startswith("="):
                col_info["has_formula"] = True
                col_info["formula_template"] = sample_val
                formula_columns.append(col_info["col_letter"])
            else:
                col_info["has_formula"] = False
                col_info["formula_template"] = None

            # Nếu là cột I (cột 9) trong mẫu 9 cột hoặc cột I có tiêu đề yêu cầu bằng cột H
            if c_idx == 9 and (
                is_nine_col_ebill_layout or col_info.get("mapped_field") == "equal_col_h"
            ):
                col_info["mapped_field"] = "equal_col_h"

        sheets_info.append(
            {
                "sheet_name": sheet_name,
                "header_row": best_header_row,
                "sub_header_row": candidate_sub_row if has_sub_header_row else None,
                "start_data_row": start_data_row,
                "max_row": ws.max_row,
                "max_column": ws.max_column,
                "columns": detected_columns,
                "formula_columns": formula_columns,
                "col_i_equals_col_h": any(
                    c["col_index"] == 9 and c.get("mapped_field") == "equal_col_h"
                    for c in detected_columns
                ),
            }
        )

    wb.close()
    return {
        "template_filename": template_path.name,
        "sheet_names": [s["sheet_name"] for s in sheets_info],
        "active_sheet": sheets_info[0]["sheet_name"] if sheets_info else "",
        "sheets": sheets_info,
    }


def _copy_cell_style(src_cell, dst_cell) -> None:
    if src_cell.has_style:
        dst_cell.font = copy(src_cell.font)
        dst_cell.fill = copy(src_cell.fill)
        dst_cell.border = copy(src_cell.border)
        dst_cell.alignment = copy(src_cell.alignment)
        dst_cell.number_format = src_cell.number_format


def export_invoices_to_template(
    template_path: Path,
    output_path: Path,
    invoices: List[ExtractedInvoice],
    target_sheet: Optional[str] = None,
    custom_column_mapping: Optional[Dict[int, str]] = None,
    include_audit_sheet: bool = True,
    enforce_col_i_equals_h: Optional[bool] = None,
) -> Path:
    """
    Ghi danh sách hóa đơn vào đúng sheet và đúng cột của file Excel mẫu.
    - Giữ nguyên cấu trúc các sheet, dòng tiêu đề (ví dụ dòng 5), dòng phụ (ví dụ dòng 6),
      định dạng ô (font, viền, number_format).
    - Không ghi đè file mẫu gốc (luôn lưu sang output_path riêng biệt).
    - Tự động đảm bảo Cột I = Cột H đối với mẫu 9 cột (ImportEBill_Template_v3) hoặc khi cột I
      được ánh xạ là 'equal_col_h'.
    """
    if not invoices:
        raise ValueError("Không có dữ liệu hóa đơn hợp lệ để xuất Excel.")
    if not template_path.exists():
        raise FileNotFoundError("Người dùng chưa cung cấp file Excel mẫu.")
    if template_path.resolve() == output_path.resolve():
        raise ValueError("Không được phép ghi đè trực tiếp lên file Excel mẫu gốc.")

    import openpyxl

    analysis = analyze_excel_template(template_path)
    wb = openpyxl.load_workbook(filename=str(template_path))

    sheet_meta = None
    if target_sheet and target_sheet in wb.sheetnames:
        sheet_meta = next((s for s in analysis["sheets"] if s["sheet_name"] == target_sheet), None)
    if sheet_meta is None:
        sheet_meta = analysis["sheets"][0]

    ws = wb[sheet_meta["sheet_name"]]
    start_row = sheet_meta["start_data_row"]

    # Xây dựng bảng ánh xạ cột -> trường dữ liệu
    col_map: Dict[int, str] = {}
    for col in sheet_meta["columns"]:
        c_idx = int(col["col_index"])
        if custom_column_mapping and c_idx in custom_column_mapping and custom_column_mapping[c_idx]:
            col_map[c_idx] = custom_column_mapping[c_idx]
        elif col.get("mapped_field"):
            col_map[c_idx] = col["mapped_field"]

    should_col_i_equal_h = (
        enforce_col_i_equals_h
        if enforce_col_i_equals_h is not None
        else (
            bool(sheet_meta.get("col_i_equals_col_h"))
            or col_map.get(9) == "equal_col_h"
            or (len(sheet_meta["columns"]) == 9 and sheet_meta["header_row"] == 5)
        )
    )
    if should_col_i_equal_h:
        col_map[9] = "equal_col_h"

    style_reference_row = start_row
    for idx, inv in enumerate(invoices):
        current_row = start_row + idx
        # Ghi các cột thông thường trước (A..H...)
        for col in sheet_meta["columns"]:
            c_idx = int(col["col_index"])
            ref_cell = ws.cell(row=style_reference_row, column=c_idx)
            target_cell = ws.cell(row=current_row, column=c_idx)

            if current_row != style_reference_row:
                _copy_cell_style(ref_cell, target_cell)

            # Nếu cột có công thức ở dòng mẫu -> dịch chuyển công thức theo số dòng
            if col.get("has_formula") and col.get("formula_template"):
                formula_str = str(col["formula_template"])
                translated_formula = re.sub(
                    rf"([A-Z]+){style_reference_row}\b",
                    rf"\g<1>{current_row}",
                    formula_str,
                )
                target_cell.value = translated_formula
                continue

            field_name = col_map.get(c_idx)
            if not field_name or field_name == "equal_col_h":
                continue

            if field_name == "stt":
                target_cell.value = idx + 1
            else:
                val = getattr(inv, field_name, "")
                target_cell.value = val if val is not None else ""

        # Thực thi quy tắc Cột I (col 9) = Cột H (col 8) nếu được kích hoạt và cột I không có công thức cố định khác
        if should_col_i_equal_h:
            cell_h = ws.cell(row=current_row, column=8)
            cell_i = ws.cell(row=current_row, column=9)
            ref_cell_i = ws.cell(row=style_reference_row, column=9)
            if current_row != style_reference_row:
                _copy_cell_style(ref_cell_i, cell_i)
            if not (isinstance(cell_i.value, str) and cell_i.value.startswith("=")):
                cell_i.value = cell_h.value
                if cell_h.number_format and (not cell_i.number_format or cell_i.number_format == "General"):
                    cell_i.number_format = cell_h.number_format

    # Tùy chọn tạo thêm sheet Báo cáo kiểm tra & truy nguyên (không ảnh hưởng tới Sheet1)
    if include_audit_sheet:
        audit_name = "Bao_Cao_Kiem_Tra"
        if audit_name in wb.sheetnames:
            del wb[audit_name]
        audit_ws = wb.create_sheet(title=audit_name)
        audit_headers = [
            "STT",
            "Tên file PDF",
            "Số hóa đơn",
            "Ký hiệu",
            "MST Người bán",
            "Phương thức đọc",
            "Trạng thái xác minh",
            "Trường cần lưu ý",
            "Chi tiết cảnh báo / Kiểm tra",
        ]
        audit_ws.append(audit_headers)
        for idx, inv in enumerate(invoices):
            issues_str = "; ".join(f"[{i.severity}] {i.message}" for i in inv.validation_issues)
            uncertain_str = ", ".join(inv.uncertain_fields)
            audit_ws.append(
                [
                    idx + 1,
                    inv.source_filename,
                    inv.invoice_number,
                    inv.invoice_symbol,
                    inv.seller_tax_id,
                    inv.extraction_method,
                    inv.verification_status,
                    uncertain_str or "Không",
                    issues_str or "Đạt kiểm tra",
                ]
            )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(output_path))
    wb.close()
    logger.info("Đã xuất thành công %d hóa đơn ra file Excel: %s", len(invoices), output_path.name)
    return output_path


def create_import_ebill_v3_template(dest_path: Path) -> Path:
    """
    Tạo workbook chuẩn theo đúng đặc tả cấu trúc ImportEBill_Template_v3:
    - Sheet: 'Sheet1'
    - Dòng 5: Tiêu đề bảng (9 cột nghiệp vụ A..I)
    - Dòng 6: Dòng đánh số thứ tự cột (1)..(9) / tiêu đề phụ
    - Dòng 7: Bắt đầu dữ liệu hóa đơn
    - Cột I (cột 9): Tự động bằng Cột H (cột 8)
    """
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment
    except ImportError as exc:
        raise RuntimeError(
            "Chưa cài đặt thư viện openpyxl. Hãy chạy: pip install openpyxl==3.1.5"
        ) from exc

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sheet1"

    ws.merge_cells("A1:I1")
    ws["A1"] = "BẢNG KÊ NHẬP HÓA ĐƠN ĐIỆN TỬ (IMPORTEBILL TEMPLATE V3 - 9 CỘT)"
    ws["A1"].font = Font(bold=True, size=12)

    ws.merge_cells("A2:I2")
    ws["A2"] = "Cấu trúc chuẩn: Sheet1 | Dòng 5: Tiêu đề | Dòng 6: Đánh số cột | Dòng 7: Bắt đầu dữ liệu | Cột I = Cột H"

    headers_row_5 = [
        "STT",
        "Ký hiệu hóa đơn",
        "Số hóa đơn",
        "Ngày hóa đơn",
        "Mã số thuế người bán",
        "Tên người bán",
        "Tiền trước thuế",
        "Tổng tiền thanh toán",
        "Giá trị quy đổi (Bằng cột H)",
    ]
    sub_headers_row_6 = [f"({i})" for i in range(1, 10)]

    header_fill = PatternFill(start_color="1E293B", end_color="1E293B", fill_type="solid")
    header_font = Font(bold=True, size=10, color="FFFFFF")
    sub_fill = PatternFill(start_color="E2E8F0", end_color="E2E8F0", fill_type="solid")
    sub_font = Font(italic=True, size=9, color="334155")
    center_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for col_idx, text in enumerate(headers_row_5, start=1):
        c5 = ws.cell(row=5, column=col_idx, value=text)
        c5.fill = header_fill
        c5.font = header_font
        c5.alignment = center_align

        c6 = ws.cell(row=6, column=col_idx, value=sub_headers_row_6[col_idx - 1])
        c6.fill = sub_fill
        c6.font = sub_font
        c6.alignment = center_align

    # Định dạng số cho dòng dữ liệu đầu tiên (dòng 7)
    ws.cell(row=7, column=7).number_format = "#,##0"
    ws.cell(row=7, column=8).number_format = "#,##0"
    ws.cell(row=7, column=9).number_format = "#,##0"

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(dest_path))
    wb.close()
    return dest_path


def create_sample_accounting_template(dest_path: Path) -> Path:
    """
    Mặc định tạo mẫu chuẩn 9 cột (Sheet1, dòng 5 tiêu đề, dòng 6 đánh số, dòng 7 dữ liệu, Cột I = Cột H)
    tương thích với cấu trúc ImportEBill_Template_v3.
    """
    return create_import_ebill_v3_template(dest_path)
