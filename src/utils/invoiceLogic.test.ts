import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVietnameseNumber,
  normalizeDateStr,
  extractInvoiceFromLines,
  validateInvoiceBatch,
  matchHeaderToField,
  buildSyntheticPdfBuffer,
} from './invoiceLogic';
import { OcrTextLine } from '../types/invoice';

test('parseVietnameseNumber parses Vietnamese and international currency formats accurately', () => {
  assert.equal(parseVietnameseNumber('25.000.000'), 25000000);
  assert.equal(parseVietnameseNumber('12,500,000'), 12500000);
  assert.equal(parseVietnameseNumber('1.250.000,50'), 1250000.5);
  assert.equal(parseVietnameseNumber('800.000 VND'), 800000);
  assert.equal(parseVietnameseNumber(''), null);
});

test('normalizeDateStr normalizes Vietnamese and slash date formats to YYYY-MM-DD', () => {
  assert.equal(normalizeDateStr('Ngày 05 tháng 11 năm 2026'), '2026-11-05');
  assert.equal(normalizeDateStr('Ngày lập: 18/03/2026'), '2026-03-18');
  assert.equal(normalizeDateStr('Date: 2026-07-22'), '2026-07-22');
});

test('extractInvoiceFromLines strictly separates Seller MST and Buyer MST', () => {
  const sampleLines: OcrTextLine[] = [
    { text: 'HÓA ĐƠN GIÁ TRỊ GIA TĂNG', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: 'Ngày 20 tháng 10 năm 2026', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: 'Ký hiệu: 1C26TAA   Số: 00089123', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: 'Đơn vị bán hàng: CÔNG TY CỔ PHẦN GIẢI PHÁP SỐ ĐÔNG ĐÔ', confidence: 0.98, page: 1, source: 'PDF_TEXT' },
    { text: 'Mã số thuế: 0102345678', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: 'Địa chỉ: Tầng 8, Tòa nhà Dịch Vọng, Cầu Giấy, Hà Nội', confidence: 0.97, page: 1, source: 'PDF_TEXT' },
    { text: 'Họ tên người mua hàng: Trần Thị Thu Hà', confidence: 0.98, page: 1, source: 'PDF_TEXT' },
    { text: 'Tên đơn vị mua: CÔNG TY TNHH SẢN XUẤT MINH KHÔI', confidence: 0.98, page: 1, source: 'PDF_TEXT' },
    { text: 'Mã số thuế: 0312345679-001', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: 'STT   Tên hàng hóa, dịch vụ   ĐVT   Số lượng   Đơn giá   Thành tiền', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: '1   Phần mềm quản trị doanh nghiệp   Gói   1   50.000.000   50.000.000', confidence: 0.98, page: 1, source: 'PDF_TEXT' },
    { text: 'Cộng tiền hàng: 50.000.000', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: 'Thuế suất GTGT: 8%   Tiền thuế GTGT: 4.000.000', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
    { text: 'Tổng cộng tiền thanh toán: 54.000.000', confidence: 0.99, page: 1, source: 'PDF_TEXT' },
  ];

  const extracted = extractInvoiceFromLines(
    sampleLines,
    'inv_1',
    'hoa_don_dong_do.pdf',
    42000,
    'sha_dong_do',
    1,
    'PDF_TEXT'
  );

  assert.equal(extracted.seller_name, 'CÔNG TY CỔ PHẦN GIẢI PHÁP SỐ ĐÔNG ĐÔ');
  assert.equal(extracted.seller_tax_id, '0102345678');
  assert.equal(extracted.buyer_name, 'CÔNG TY TNHH SẢN XUẤT MINH KHÔI');
  assert.equal(extracted.buyer_tax_id, '0312345679-001');
  assert.equal(extracted.invoice_symbol, '1C26TAA');
  assert.equal(extracted.invoice_number, '00089123');
  assert.equal(extracted.invoice_date, '2026-10-20');
  assert.equal(extracted.subtotal_amount, 50000000);
  assert.equal(extracted.vat_rate, '8%');
  assert.equal(extracted.vat_amount, 4000000);
  assert.equal(extracted.total_amount, 54000000);
});

test('validateInvoiceBatch flags exact duplicates and math discrepancies without deleting records', () => {
  const baseLines: OcrTextLine[] = [
    { text: 'Đơn vị bán hàng: CÔNG TY TNHH HẢI ĐĂNG', confidence: 0.99, page: 1, source: 'PADDLE_OCR' },
    { text: 'Mã số thuế: 0105556667', confidence: 0.99, page: 1, source: 'PADDLE_OCR' },
    { text: 'Ký hiệu: 1C26TBB   Số: 00004567', confidence: 0.99, page: 1, source: 'PADDLE_OCR' },
    { text: 'Ngày 12 tháng 10 năm 2026', confidence: 0.99, page: 1, source: 'PADDLE_OCR' },
    { text: 'Cộng tiền hàng: 15.000.000', confidence: 0.99, page: 1, source: 'PADDLE_OCR' },
    { text: 'Thuế suất GTGT: 10%   Tiền thuế GTGT: 1.500.000', confidence: 0.99, page: 1, source: 'PADDLE_OCR' },
    { text: 'Tổng cộng tiền thanh toán: 16.500.000', confidence: 0.99, page: 1, source: 'PADDLE_OCR' },
  ];

  const inv1 = extractInvoiceFromLines(baseLines, 'id_1', 'hd_goc.pdf', 12000, 'sha_a', 1, 'PADDLE_OCR');
  const inv2 = extractInvoiceFromLines(baseLines, 'id_2', 'hd_trung_so.pdf', 12500, 'sha_b', 1, 'PADDLE_OCR');

  const mathErrorLines = [...baseLines];
  mathErrorLines[6] = { text: 'Tổng cộng tiền thanh toán: 18.000.000', confidence: 0.91, page: 1, source: 'PADDLE_OCR' };
  const inv3 = extractInvoiceFromLines(mathErrorLines, 'id_3', 'hd_lech_tien.pdf', 13000, 'sha_c', 1, 'PADDLE_OCR');
  inv3.invoice_number = '00009999';

  const result = validateInvoiceBatch([inv1, inv2, inv3]);
  assert.equal(result.length, 3);
  assert.equal(result[0].verification_status, 'DUPLICATE_WARNING');
  assert.equal(result[1].verification_status, 'DUPLICATE_WARNING');
  assert.equal(result[2].verification_status, 'NEEDS_REVIEW');
  assert.equal(result[2].validation_issues.some((i) => i.code === 'MATH_MISMATCH_TOTAL'), true);
});

test('matchHeaderToField maps Vietnamese accounting template headers and buildSyntheticPdfBuffer creates valid %PDF-', () => {
  assert.equal(matchHeaderToField('Mã số thuế người bán'), 'seller_tax_id');
  assert.equal(matchHeaderToField('MST người mua'), 'buyer_tax_id');
  assert.equal(matchHeaderToField('Doanh số mua chưa có thuế'), 'subtotal_amount');
  assert.equal(matchHeaderToField('Tổng tiền thanh toán'), 'total_amount');

  const pdfBytes = buildSyntheticPdfBuffer(['HOA DON GIA TRI GIA TANG']);
  const headerStr = new TextDecoder().decode(pdfBytes.slice(0, 8));
  assert.equal(headerStr.startsWith('%PDF-1.4'), true);
});
