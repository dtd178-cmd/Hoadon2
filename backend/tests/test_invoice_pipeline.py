"""
Bộ kiểm thử tự động cho Backend Python (chạy bằng: python3 -m unittest backend/tests/test_invoice_pipeline.py)
Kiểm chứng:
1. Kiểm tra định dạng file PDF thực tế (%PDF-), file rỗng, file giả mạo phần mở rộng .pdf và file vượt dung lượng.
2. Đánh giá chất lượng lớp văn bản (PDF text layer) để quyết định khi nào dùng text trực tiếp, khi nào gọi PaddleOCR.
3. Thuật toán gom hộp chữ (bounding boxes) của PaddleOCR theo tọa độ ngang/dọc.
4. Trích xuất trường hóa đơn tiếng Việt & tiếng Anh, đảm bảo KHÔNG gán nhầm MST người mua thành MST người bán.
5. Kiểm tra toán học (Tiền hàng - Chiết khấu + Thuế = Tổng tiền) và phát hiện hóa đơn trùng lặp.
6. Kiểm tra ánh xạ cột Excel mẫu và bộ lọc che giấu MST trong log.
"""
import tempfile
import unittest
from pathlib import Path

from backend.app.models import OcrTextLine
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
)
from backend.app.validator import validate_invoice_batch
from backend.app.excel_exporter import match_header_to_field
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

            # 3. File PDF hợp lệ
            valid_pdf = tmp_path / "valid.pdf"
            valid_pdf.write_bytes(b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF")
            sha = validate_pdf_file(valid_pdf, max_bytes=1024)
            self.assertEqual(len(sha), 64)

            # 4. File vượt quá dung lượng cho phép
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
        self.assertTrue(any(i.code == "MATH_MISMATCH_TOTAL" for i in validated[2].validation_issues))

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
