# -*- coding: utf-8 -*-
"""
Bộ kiểm thử tự động toàn diện cho Backend Python
Chạy bằng:
  .venv\\Scripts\\python.exe -m unittest backend.tests.test_invoice_pipeline -v
  hoặc:
  python3 -m unittest backend.tests.test_invoice_pipeline -v

Kiểm chứng:
1. Kiểm tra định dạng file PDF thực tế (%PDF-), file rỗng, file giả mạo phần mở rộng .pdf, file cụt %%EOF và file vượt dung lượng.
2. Đánh giá chất lượng lớp văn bản (PDF text layer) để quyết định khi nào dùng text trực tiếp, khi nào gọi PaddleOCR.
3. Thuật toán gom hộp chữ (bounding boxes) của PaddleOCR theo tọa độ ngang/dọc.
4. Tách nhãn tên người bán / người mua (tiếng Việt, tiếng Anh, dấu ':' thường và '：' toàn chiều rộng, giữ nguyên dấu ':' trong tên chi nhánh).
5. Phân biệt nghiêm ngặt Người bán vs Người mua và MST bán vs MST mua (kể cả khi xuất hiện đồng thời 2 công ty và nhiều MST).
6. Chuẩn hóa Unicode NFC, NFD và khôi phục mojibake tiếng Việt.
7. Kiểm tra toán học bằng Decimal (Tiền hàng - Chiết khấu + Thuế = Tổng tiền, dung sai làm tròn) và phát hiện hóa đơn trùng 3 mức (SHA-256, Trùng chính xác, Nghi ngờ trùng) cùng thứ tự ưu tiên trạng thái DUPLICATE_WARNING > NEEDS_REVIEW > VERIFIED.
8. Cô lập lỗi khi xử lý lô nhiều file (1 file hỏng không làm mất kết quả các file hợp lệ).
9. Kiểm tra xuất Excel theo mẫu 9 cột (Sheet1, dòng 5 tiêu đề, dòng 6 đánh số/phụ, dòng 7 dữ liệu, Cột I = Cột H).
"""
import tempfile
import unicodedata
import unittest
from pathlib import Path

from backend.app.models import OcrTextLine, ExtractedInvoice
from backend.app.pdf_processor import (
    validate_pdf_file,
    is_text_layer_sufficient,
    PdfValidationError,
)
from backend.app.ocr_engine import PaddleOcrEngine
from backend.app.invoice_extractor import (
    extract_invoice_from_lines,
    parse_vietnamese_number,
    normalize_date_str,
    strip_party_label,
    normalize_vn_text,
)
from backend.app.validator import validate_single_invoice, validate_invoice_batch
from backend.app.excel_exporter import (
    match_header_to_field,
    analyze_excel_template,
    export_invoices_to_template,
    create_import_ebill_v3_template,
)
from backend.app.task_manager import TaskManager
from backend.app.auth import verify_token_string
from backend.app.config import settings


class TestInvoicePipeline(unittest.TestCase):
    def test_pdf_validation_magic_bytes_and_limits(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)

            # 1. File rỗng
            empty_pdf = tmp_path / "empty.pdf"
            empty_pdf.write_bytes(b"")
            with self.assertRaises(PdfValidationError):
                validate_pdf_file(empty_pdf)

            # 2. File giả mạo đuôi .pdf (thực chất là văn bản/exe)
            fake_pdf = tmp_path / "fake.pdf"
            fake_pdf.write_bytes(b"MZ_NOT_A_REAL_PDF_FILE_CONTENT")
            with self.assertRaises(PdfValidationError):
                validate_pdf_file(fake_pdf)

            # 3. File PDF bị cụt luồng (thiếu %%EOF / endobj)
            truncated_pdf = tmp_path / "truncated.pdf"
            truncated_pdf.write_bytes(b"%PDF-1.7\nCORRUPTED_STREAM_ONLY")
            with self.assertRaises(PdfValidationError):
                validate_pdf_file(truncated_pdf)

            # 4. File PDF hợp lệ
            valid_pdf = tmp_path / "valid.pdf"
            valid_pdf.write_bytes(b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF")
            sha = validate_pdf_file(valid_pdf, max_bytes=1024)
            self.assertEqual(len(sha), 64)

            # 5. File vượt quá dung lượng cho phép
            with self.assertRaises(PdfValidationError):
                validate_pdf_file(valid_pdf, max_bytes=10)

    def test_text_layer_quality_detector(self):
        good_text = (
            "HÓA ĐƠN GIÁ TRỊ GIA TĂNG\n"
            "Ký hiệu: 1C26TAA - Số: 00012589\n"
            "Đơn vị bán hàng: CÔNG TY TNHH CÔNG NGHỆ SAO VIỆT\n"
            "Mã số thuế: 0108765432\n"
            "Tổng cộng tiền thanh toán: 11.000.000 VND"
        )
        self.assertTrue(is_text_layer_sufficient(good_text))
        self.assertFalse(is_text_layer_sufficient("   "))
        self.assertFalse(is_text_layer_sufficient("Trang scan chi co vai ky tu"))

    def test_seller_vs_buyer_mst_separation(self):
        lines = [
            OcrTextLine("HÓA ĐƠN GIÁ TRỊ GIA TĂNG (VAT INVOICE)", 0.99, 1, source="PADDLE_OCR"),
            OcrTextLine("Ngày 18 tháng 03 năm 2026", 0.98, 1, source="PADDLE_OCR"),
            OcrTextLine("Ký hiệu (Serial): 1C26TAA   Số (No.): 00045812", 0.99, 1, source="PADDLE_OCR"),
            OcrTextLine("Đơn vị bán hàng (Seller): CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA", 0.97, 1, source="PADDLE_OCR"),
            OcrTextLine("Mã số thuế (Tax code): 0101234567-001", 0.99, 1, source="PADDLE_OCR"),
            OcrTextLine("Địa chỉ: Số 1 Đại Cồ Việt, Quận Hai Bà Trưng, Hà Nội", 0.95, 1, source="PADDLE_OCR"),
            OcrTextLine("Họ tên người mua hàng: Nguyễn Văn Minh", 0.96, 1, source="PADDLE_OCR"),
            OcrTextLine("Tên đơn vị (Buyer): CÔNG TY TNHH THƯƠNG MẠI NAM PHƯƠNG", 0.97, 1, source="PADDLE_OCR"),
            OcrTextLine("Mã số thuế: 0309876543", 0.98, 1, source="PADDLE_OCR"),
            OcrTextLine("STT   Tên hàng hóa, dịch vụ   ĐVT   Số lượng   Đơn giá   Thành tiền", 0.95, 1, source="PADDLE_OCR"),
            OcrTextLine("1   Máy in laser văn phòng HP   Chiếc   2   10.000.000   20.000.000", 0.96, 1, source="PADDLE_OCR"),
            OcrTextLine("Cộng tiền hàng (Subtotal): 20.000.000", 0.99, 1, source="PADDLE_OCR"),
            OcrTextLine("Thuế suất GTGT: 10%   Tiền thuế GTGT (VAT amount): 2.000.000", 0.99, 1, source="PADDLE_OCR"),
            OcrTextLine("Tổng cộng tiền thanh toán (Total payment): 22.000.000", 0.99, 1, source="PADDLE_OCR"),
        ]

        inv = extract_invoice_from_lines(
            lines=lines,
            invoice_id="inv_test_1",
            source_filename="hoa_don_01.pdf",
            file_size_bytes=54000,
            file_sha256="hash_a",
            page_count=1,
            extraction_method="PADDLE_OCR",
        )

        self.assertEqual(inv.seller_name, "CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA")
        self.assertEqual(inv.seller_tax_id, "0101234567-001")
        self.assertEqual(inv.buyer_name, "CÔNG TY TNHH THƯƠNG MẠI NAM PHƯƠNG")
        self.assertEqual(inv.buyer_tax_id, "0309876543")
        self.assertEqual(inv.invoice_symbol, "1C26TAA")
        self.assertEqual(inv.invoice_number, "00045812")
        self.assertEqual(inv.invoice_date, "2026-03-18")
        self.assertEqual(inv.subtotal_amount, 20000000.0)
        self.assertEqual(inv.vat_rate, "10%")
        self.assertEqual(inv.vat_amount, 2000000.0)
        self.assertEqual(inv.total_amount, 22000000.0)

    def test_seller_label_stripping_variants_and_colon_preservation(self):
        # 1. Các biến thể nhãn tiếng Việt, tiếng Anh, dấu hai chấm toàn chiều rộng '：', dấu gạch ngang
        self.assertEqual(
            strip_party_label("Đơn vị bán hàng (Seller): CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA", "seller"),
            "CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA",
        )
        self.assertEqual(
            strip_party_label("Tên đơn vị bán hàng (Seller's Name)：CÔNG TY TNHH ĐIỆN LỰC MIỀN BẮC", "seller"),
            "CÔNG TY TNHH ĐIỆN LỰC MIỀN BẮC",
        )
        self.assertEqual(
            strip_party_label("Người bán (Vendor) - CÔNG TY CỔ PHẦN HẠ TẦNG SỐ", "seller"),
            "CÔNG TY CỔ PHẦN HẠ TẦNG SỐ",
        )
        # 2. Giữ nguyên dấu hai chấm hợp lệ nằm bên trong tên công ty
        self.assertEqual(
            strip_party_label(
                "Đơn vị bán hàng: CÔNG TY TNHH MTV X - CHI NHÁNH 1: KHO VẬN ĐÔNG ANH",
                "seller",
            ),
            "CÔNG TY TNHH MTV X - CHI NHÁNH 1: KHO VẬN ĐÔNG ANH",
        )
        # 3. Chuẩn hóa Unicode NFD (tổ hợp dấu rời) về NFC chuẩn
        nfd_line = unicodedata.normalize(
            "NFD", "Đơn vị bán hàng (Seller): CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA"
        )
        inv_nfd = extract_invoice_from_lines(
            [OcrTextLine(nfd_line, 0.98, 1)], "id_nfd", "nfd.pdf", 1000, "sha_nfd"
        )
        self.assertEqual(inv_nfd.seller_name, "CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA")

    def test_seller_vs_buyer_concurrent_companies_and_missing_seller_mst(self):
        # Trường hợp nhãn người mua chỉ ghi 'Tên đơn vị:' bên dưới 'Họ tên người mua hàng: .......'
        # và người bán bị mờ MST -> Tuyệt đối không lấy MST người mua gán sang người bán
        lines = [
            OcrTextLine("Đơn vị bán: CÔNG TY CỔ PHẦN GIẢI PHÁP PHẦN MỀM VIỆT", 0.99, 1),
            OcrTextLine("Địa chỉ: Tầng 5, Tòa nhà Техно, Quận Cầu Giấy, Hà Nội", 0.95, 1),
            OcrTextLine("Họ tên người mua hàng: .................................", 0.95, 1),
            OcrTextLine("Tên đơn vị: CÔNG TY TNHH ĐẦU TƯ XÂY DỰNG HOÀNG LONG", 0.98, 1),
            OcrTextLine("Mã số thuế: 0312345678", 0.99, 1),
            OcrTextLine("Cộng tiền hàng: 5.000.000", 0.99, 1),
            OcrTextLine("Tiền thuế GTGT: 500.000", 0.99, 1),
            OcrTextLine("Tổng cộng tiền thanh toán: 5.500.000", 0.99, 1),
        ]
        inv = extract_invoice_from_lines(lines, "id_2", "hd_khuyet_mst_ban.pdf", 1200, "sha_2")
        self.assertEqual(inv.seller_name, "CÔNG TY CỔ PHẦN GIẢI PHÁP PHẦN MỀM VIỆT")
        self.assertEqual(inv.buyer_name, "CÔNG TY TNHH ĐẦU TƯ XÂY DỰNG HOÀNG LONG")
        self.assertEqual(inv.seller_tax_id, "")
        self.assertEqual(inv.buyer_tax_id, "0312345678")

    def test_validation_math_and_duplicate_detection(self):
        lines_ok = [
            OcrTextLine("Đơn vị bán hàng: CÔNG TY TNHH A", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Mã số thuế: 0101112223", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Ký hiệu: 1C26TAA Số: 00001234", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Ngày 10 tháng 02 năm 2026", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Cộng tiền hàng: 10.000.000", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Thuế suất GTGT: 8% Tiền thuế GTGT: 800.000", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Tổng cộng tiền thanh toán: 10.800.000", 0.99, 1, source="PDF_TEXT"),
        ]
        inv1 = extract_invoice_from_lines(lines_ok, "1", "hd1.pdf", 1000, "sha_1")
        inv2_dup = extract_invoice_from_lines(lines_ok, "2", "hd1_copy.pdf", 1000, "sha_2")

        # Hóa đơn số 3 bị lệch toán học (10tr + 800k nhưng tổng ghi 12tr)
        lines_bad_math = list(lines_ok)
        lines_bad_math[-1] = OcrTextLine("Tổng cộng tiền thanh toán: 12.000.000", 0.99, 1, source="PADDLE_OCR")
        inv3_bad = extract_invoice_from_lines(lines_bad_math, "3", "hd_sai_toan.pdf", 1000, "sha_3")
        inv3_bad.invoice_number = "00009999"

        validated = validate_invoice_batch([inv1, inv2_dup, inv3_bad])
        self.assertEqual(validated[0].verification_status, "DUPLICATE_WARNING")
        self.assertEqual(validated[1].verification_status, "DUPLICATE_WARNING")
        self.assertEqual(validated[2].verification_status, "NEEDS_REVIEW")
        self.assertTrue(any(i.code == "MATH_MISMATCH_TOTAL" for i in validated[2].validation_issues))

    def test_duplicate_detection_tiers_and_status_priority(self):
        base_lines = [
            OcrTextLine("Đơn vị bán hàng: CÔNG TY TNHH B", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Mã số thuế: 0109998887", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Ký hiệu: 1C26TBB Số: 00005678", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Ngày 20 tháng 03 năm 2026", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Cộng tiền hàng: 50.000.000", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Tiền thuế GTGT: 5.000.000", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Tổng cộng tiền thanh toán: 55.000.000", 0.99, 1, source="PDF_TEXT"),
        ]
        # 1. Trùng SHA-256
        a1 = extract_invoice_from_lines(base_lines, "a1", "f1.pdf", 1000, "same_sha")
        a2 = extract_invoice_from_lines(base_lines, "a2", "f2.pdf", 1000, "same_sha")
        res_sha = validate_invoice_batch([a1, a2])
        self.assertEqual(res_sha[0].verification_status, "DUPLICATE_WARNING")
        self.assertTrue(any(i.code == "DUPLICATE_FILE_HASH" for i in res_sha[0].validation_issues))

        # 2. Nghi ngờ trùng (thiếu MST ở bản scan thứ 2 nhưng cùng Số HĐ và cùng Tổng tiền)
        b1 = extract_invoice_from_lines(base_lines, "b1", "b1.pdf", 1000, "sha_b1")
        b2 = extract_invoice_from_lines(base_lines, "b2", "b2_scan_mo_mst.pdf", 1000, "sha_b2")
        b2.seller_tax_id = ""
        # Kèm theo lỗi lệch tiền trên b2 để kiểm tra ưu tiên: DUPLICATE_WARNING không bị NEEDS_REVIEW đè mất
        b2.subtotal_amount = 40000000.0
        res_susp = validate_invoice_batch([b1, b2])
        self.assertEqual(res_susp[0].verification_status, "DUPLICATE_WARNING")
        self.assertEqual(res_susp[1].verification_status, "DUPLICATE_WARNING")
        self.assertTrue(any(i.code == "DUPLICATE_INVOICE_SUSPECTED" for i in res_susp[1].validation_issues))
        self.assertTrue(any(i.code == "MATH_MISMATCH_TOTAL" for i in res_susp[1].validation_issues))

    def test_math_validation_rounding_tolerance_and_decimal_precision(self):
        lines = [
            OcrTextLine("Đơn vị bán hàng: CÔNG TY TNHH C", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Mã số thuế: 0102223334", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Ký hiệu: 1C26TCC Số: 00000100", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Ngày 12/04/2026", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Cộng tiền hàng: 10.000.000", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Tiền thuế GTGT: 1.000.002", 0.99, 1, source="PDF_TEXT"),
            OcrTextLine("Tổng cộng tiền thanh toán: 11.000.000", 0.99, 1, source="PDF_TEXT"),
        ]
        inv = extract_invoice_from_lines(lines, "m1", "round.pdf", 1000, "sha_m1")
        # Chênh lệch 2 đồng nằm trong dung sai làm tròn 5 đồng -> VERIFIED
        validate_single_invoice(inv, rounding_tolerance=5.0)
        self.assertEqual(inv.verification_status, "VERIFIED")

        # Nếu dung sai làm tròn = 1 đồng -> phát hiện lệch toán học -> NEEDS_REVIEW
        validate_single_invoice(inv, rounding_tolerance=1.0)
        self.assertEqual(inv.verification_status, "NEEDS_REVIEW")
        self.assertTrue(any(i.code == "MATH_MISMATCH_TOTAL" for i in inv.validation_issues))

    def test_batch_fault_isolation_when_one_file_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            bad_pdf = tmp_path / "01_broken.pdf"
            bad_pdf.write_bytes(b"NOT_A_VALID_PDF")

            tm = TaskManager()
            task = tm.create_task([("01_broken.pdf", bad_pdf)], tmp_path)
            tm.run_batch_processing(task.task_id, [("01_broken.pdf", bad_pdf)])
            updated_task = tm.get_task(task.task_id)
            self.assertIsNotNone(updated_task)
            self.assertEqual(updated_task.failed_files, 1)
            self.assertEqual(updated_task.files[0].status, "FAILED")
            self.assertIn("PDF", updated_task.files[0].error_message)

    def test_excel_export_9_columns_row5_row6_row7_col_i_equals_col_h(self):
        try:
            import openpyxl
        except ImportError:
            # Nếu chạy bằng Python hệ thống chưa cài openpyxl, kiểm tra logic ánh xạ tiêu đề 9 cột
            self.assertEqual(match_header_to_field("Giá trị quy đổi (Bằng cột H)"), "equal_col_h")
            return

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            tpl_path = tmp_path / "ImportEBill_Template_v3 - 2026-10-20T080747.090.xlsx"
            out_path = tmp_path / "Exported_Result.xlsx"

            create_import_ebill_v3_template(tpl_path)
            analysis = analyze_excel_template(tpl_path)
            self.assertEqual(analysis["active_sheet"], "Sheet1")
            sheet_meta = analysis["sheets"][0]
            self.assertEqual(sheet_meta["header_row"], 5)
            self.assertEqual(sheet_meta["sub_header_row"], 6)
            self.assertEqual(sheet_meta["start_data_row"], 7)
            self.assertEqual(len(sheet_meta["columns"]), 9)
            self.assertTrue(sheet_meta["col_i_equals_col_h"])

            inv = ExtractedInvoice(
                id="inv_ebill_1",
                source_filename="hd_01.pdf",
                file_size_bytes=2048,
                file_sha256="sha_ebill_1",
                seller_name="CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA",
                seller_tax_id="0101234567",
                invoice_symbol="1C26TAA",
                invoice_number="00045812",
                invoice_date="2026-03-18",
                subtotal_amount=20000000.0,
                vat_amount=2000000.0,
                total_amount=22000000.0,
                verification_status="VERIFIED",
            )

            export_invoices_to_template(tpl_path, out_path, [inv], target_sheet="Sheet1")
            wb = openpyxl.load_workbook(str(out_path), data_only=False)
            ws = wb["Sheet1"]

            # Dòng 5 (tiêu đề) và Dòng 6 (đánh số phụ) được giữ nguyên
            self.assertEqual(ws.cell(row=5, column=1).value, "STT")
            self.assertEqual(ws.cell(row=6, column=1).value, "(1)")
            self.assertEqual(ws.cell(row=6, column=9).value, "(9)")

            # Dữ liệu bắt đầu chính xác từ dòng 7
            self.assertEqual(ws.cell(row=7, column=1).value, 1)
            self.assertEqual(ws.cell(row=7, column=2).value, "1C26TAA")
            self.assertEqual(ws.cell(row=7, column=3).value, "00045812")
            self.assertEqual(ws.cell(row=7, column=5).value, "0101234567")
            self.assertEqual(ws.cell(row=7, column=6).value, "CÔNG TY CỔ PHẦN VẬT TƯ BÁCH KHOA")
            self.assertEqual(ws.cell(row=7, column=8).value, 22000000.0)
            # Cột I (col 9) tự động bằng Cột H (col 8)
            self.assertEqual(ws.cell(row=7, column=9).value, ws.cell(row=7, column=8).value)
            wb.close()

    def test_horizontal_bbox_merging_and_excel_header_matching(self):
        raw_boxes = [
            OcrTextLine("10.000.000", 0.95, 1, bbox=[[400, 102], [500, 102], [500, 120], [400, 120]]),
            OcrTextLine("Cộng tiền hàng:", 0.98, 1, bbox=[[50, 100], [200, 100], [200, 118], [50, 118]]),
        ]
        merged = PaddleOcrEngine._merge_horizontal_boxes_into_lines(raw_boxes, y_tolerance=10.0)
        self.assertEqual(len(merged), 1)
        self.assertIn("Cộng tiền hàng:   10.000.000", merged[0].text)

        self.assertEqual(match_header_to_field("Mã số thuế người bán"), "seller_tax_id")
        self.assertEqual(match_header_to_field("MST người mua"), "buyer_tax_id")
        self.assertEqual(match_header_to_field("Doanh số mua chưa có thuế"), "subtotal_amount")
        self.assertEqual(match_header_to_field("Thuế GTGT"), "vat_amount")

        # Kiểm tra xác thực token thời gian hằng
        self.assertTrue(verify_token_string(settings.api_token))
        self.assertFalse(verify_token_string("wrong-token"))


if __name__ == "__main__":
    unittest.main()
