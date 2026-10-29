import { buildSyntheticPdfBuffer } from './invoiceLogic';

/**
 * Tạo bộ 5 file PDF mẫu (chuẩn nhị phân %PDF-1.4, không chứa dữ liệu nhạy cảm)
 * bao phủ đầy đủ các kịch bản kiểm thử ở Giai đoạn 4:
 * 1. Hóa đơn điện tử có lớp văn bản (PDF_TEXT) - Đạt chuẩn toán học.
 * 2. Hóa đơn PDF Scan (PADDLE_OCR) - Phân biệt MST người bán và MST người mua.
 * 3. Hóa đơn PDF Scan nhiều mặt hàng có sai lệch cộng tiền (MATH_MISMATCH_TOTAL) cần kế toán sửa.
 * 4. Hóa đơn trùng Số hóa đơn + MST người bán (DUPLICATE_INVOICE_EXACT).
 * 5. File PDF bị lỗi cấu trúc (CORRUPTED) để kiểm chứng hệ thống báo lỗi rõ ràng mà không sập lô.
 */
export function createSampleTestPdfFiles(): File[] {
  // 1. Hóa đơn điện tử có lớp văn bản chuẩn
  const pdf1Bytes = buildSyntheticPdfBuffer(
    [
      'HOA DON GIA TRI GIA TANG (VAT INVOICE)',
      'Ky hieu (Serial): 1C26TAA   So (No.): 00089123',
      'Ngay 20 thang 10 nam 2026',
      'Don vi ban hang (Seller): CONG TY CO PHAN CONG NGHE SAO VIET',
      'Ma so thue (Tax code): 0102345678',
      'Dia chi: Tang 9 Toa nha Keangnam, Pham Hung, Nam Tu Liem, Ha Noi',
      'Ho ten nguoi mua hang: Le Hoang Nam',
      'Ten don vi mua (Buyer): CONG TY TNHH DICH VU THUONG MAI MINH TAM',
      'Ma so thue: 0314567890',
      'STT   Ten hang hoa, dich vu   DVT   So luong   Don gia   Thanh tien',
      '1   Dich vu ha tang may chu luu tru rieng   Goi   1   25.000.000   25.000.000',
      'Cong tien hang (Subtotal): 25.000.000',
      'Thue suat GTGT: 8%   Tien thue GTGT (VAT amount): 2.000.000',
      'Tong cong tien thanh toan (Total payment): 27.000.000',
      'Don vi tien te: VND',
    ],
    'TEXT_LAYER'
  );

  // 2. Hóa đơn PDF Scan (qua pipeline PaddleOCR)
  const pdf2Bytes = buildSyntheticPdfBuffer(
    [
      'HOA DON GIA TRI GIA TANG',
      'Ky hieu: 1C26TBB   So: 00045812',
      'Ngay 18 thang 10 nam 2026',
      'Don vi ban hang: CONG TY CO PHAN VAT TU THIET BI BACH KHOA',
      'Ma so thue: 0101234567-001',
      'Dia chi: So 1 Dai Co Viet, Hai Ba Trung, Ha Noi',
      'Ten don vi mua: CONG TY TNHH DICH VU THUONG MAI MINH TAM',
      'Ma so thue: 0314567890',
      'STT   Ten hang hoa, dich vu   DVT   So luong   Don gia   Thanh tien',
      '1   May scan tai lieu hai mat tốc độ cao   Chiec   2   10.000.000   20.000.000',
      'Cong tien hang: 20.000.000',
      'Thue suat GTGT: 10%   Tien thue GTGT: 2.000.000',
      'Tong cong tien thanh toan: 22.000.000',
      'Don vi tien te: VND',
    ],
    'SCANNED_IMAGE'
  );

  // 3. Hóa đơn Scan mờ nhẹ có sai lệch cộng tiền (15.000.000 + 1.500.000 nhưng OCR đọc Tổng là 17.500.000)
  const pdf3Bytes = buildSyntheticPdfBuffer(
    [
      'HOA DON GIA TRI GIA TANG',
      'Ky hieu: 1C26TCC   So: 00091044',
      'Ngay 22 thang 10 nam 2026',
      'Don vi ban hang: CONG TY TNHH VAN TAI VA LOGISTICS HAI AU',
      'Ma so thue: 0201987654',
      'Dia chi: Khu Cong Nghiep Dinh Vu, Hai An, Hai Phong',
      'Ten don vi mua: CONG TY TNHH DICH VU THUONG MAI MINH TAM',
      'Ma so thue: 0314567890',
      'STT   Ten hang hoa, dich vu   DVT   So luong   Don gia   Thanh tien',
      '1   Cuoc van chuyen hang hoa noi dia   Chuyen   3   5.000.000   15.000.000',
      'Cong tien hang: 15.000.000',
      'Thue suat GTGT: 10%   Tien thue GTGT: 1.500.000',
      '[scan_blur] Tong cong tien thanh toan: 17.500.000',
      'Don vi tien te: VND',
    ],
    'SCANNED_IMAGE'
  );

  // 4. Hóa đơn trùng lặp Số hóa đơn 00045812 và MST người bán 0101234567-001 (khác tên file)
  const pdf4Bytes = buildSyntheticPdfBuffer(
    [
      'HOA DON GIA TRI GIA TANG (BAN SAO)',
      'Ky hieu: 1C26TBB   So: 00045812',
      'Ngay 18 thang 10 nam 2026',
      'Don vi ban hang: CONG TY CO PHAN VAT TU THIET BI BACH KHOA',
      'Ma so thue: 0101234567-001',
      'Ten don vi mua: CONG TY TNHH DICH VU THUONG MAI MINH TAM',
      'Ma so thue: 0314567890',
      'Cong tien hang: 20.000.000',
      'Thue suat GTGT: 10%   Tien thue GTGT: 2.000.000',
      'Tong cong tien thanh toan: 22.000.000',
    ],
    'TEXT_LAYER'
  );

  // 5. File PDF bị lỗi cấu trúc (thiếu %%EOF)
  const corruptedBytes = new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj\nCORRUPTED_PDF_MARKER_BROKEN_STREAM'
  );

  return [
    new File([pdf1Bytes], '01_HD_DienTu_SaoViet_00089123.pdf', { type: 'application/pdf' }),
    new File([pdf2Bytes], '02_HD_Scan_VatTuBachKhoa_00045812.pdf', { type: 'application/pdf' }),
    new File([pdf3Bytes], '03_HD_Scan_SaiLechCongTien_00091044.pdf', { type: 'application/pdf' }),
    new File([pdf4Bytes], '04_HD_BanSaoTrungLap_00045812.pdf', { type: 'application/pdf' }),
    new File([corruptedBytes], '05_File_PDF_Bi_Hong_Cau_Truc.pdf', { type: 'application/pdf' }),
  ];
}
