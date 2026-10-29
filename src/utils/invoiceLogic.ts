import {
  ExtractedInvoice,
  ExtractionMethod,
  OcrTextLine,
  ValidationIssue,
} from '../types/invoice';

const SELLER_MARKERS = [
  'đơn vị bán hàng',
  'don vi ban hang',
  'tên người bán',
  'ten nguoi ban',
  'người bán',
  'nguoi ban',
  'bên bán',
  'seller',
  'vendor',
  'supplier',
];

const BUYER_MARKERS = [
  'họ tên người mua',
  'ho ten nguoi mua',
  'đơn vị mua hàng',
  'don vi mua hang',
  'tên đơn vị mua',
  'ten don vi mua',
  'người mua',
  'nguoi mua',
  'bên mua',
  'khách hàng',
  'khach hang',
  'buyer',
  'customer',
  'bill to',
];

const TABLE_START_MARKERS = [
  'stt',
  'tên hàng hóa',
  'ten hang hoa',
  'dịch vụ',
  'đơn vị tính',
  'số lượng',
  'đơn giá',
  'thành tiền',
  'description',
];

const VALID_MST_REGEX = /^\d{10}(-\d{3})?$/;
const MST_EXTRACT_REGEX = /(?<!\d)(\d{10}(?:\s*-\s*\d{3})?)(?!\d)/;

export function parseVietnameseNumber(raw: string): number | null {
  if (!raw) return null;
  let cleaned = raw.trim().replace(/[^\d.,-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === ',') {
    return null;
  }

  if (cleaned.includes('.') && cleaned.includes(',')) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      cleaned = parts.join('');
    }
  } else if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      cleaned = parts.join('');
    } else {
      cleaned = cleaned.replace(',', '.');
    }
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeDateStr(text: string): string | null {
  const lower = text.toLowerCase();
  const mVn = lower.match(
    /(?:ngày|ngay)\s*(\d{1,2})\s*(?:tháng|thang)\s*(\d{1,2})\s*(?:năm|nam)\s*(\d{4})/
  );
  if (mVn) {
    const d = Number(mVn[1]);
    const m = Number(mVn[2]);
    const y = Number(mVn[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const mSlash = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (mSlash) {
    const d = Number(mSlash[1]);
    const m = Number(mSlash[2]);
    const y = Number(mSlash[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const mIso = text.match(/\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/);
  if (mIso) {
    const y = Number(mIso[1]);
    const m = Number(mIso[2]);
    const d = Number(mIso[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  return null;
}

export function extractInvoiceFromLines(
  lines: OcrTextLine[],
  invoiceId: string,
  sourceFilename: string,
  fileSizeBytes: number,
  fileSha256: string,
  pageCount = 1,
  extractionMethod: ExtractionMethod = 'PDF_TEXT'
): ExtractedInvoice {
  const inv: ExtractedInvoice = {
    id: invoiceId,
    source_filename: sourceFilename,
    file_size_bytes: fileSizeBytes,
    file_sha256: fileSha256,
    page_count: pageCount,
    extraction_method: extractionMethod,
    seller_name: '',
    seller_tax_id: '',
    seller_address: '',
    invoice_symbol: '',
    invoice_number: '',
    invoice_date: '',
    buyer_name: '',
    buyer_tax_id: '',
    subtotal_amount: null,
    vat_rate: '',
    vat_amount: null,
    discount_amount: null,
    total_amount: null,
    currency: 'VND',
    items_summary: '',
    notes: '',
    verification_status: 'NEEDS_REVIEW',
    uncertain_fields: [],
    field_sources: {},
    field_confidences: {},
    field_pages: {},
    validation_issues: [],
  };

  const setField = <K extends keyof ExtractedInvoice>(
    field: K,
    value: ExtractedInvoice[K],
    line: OcrTextLine
  ) => {
    inv[field] = value;
    inv.field_sources[field as string] = line.source;
    inv.field_confidences[field as string] = line.confidence;
    inv.field_pages[field as string] = line.page;
  };

  let currentZone: 'HEADER' | 'SELLER' | 'BUYER' | 'TABLE' = 'HEADER';
  const itemDescriptions: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineObj = lines[idx];
    const raw = lineObj.text.trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();

    if (BUYER_MARKERS.some((m) => lower.includes(m))) {
      currentZone = 'BUYER';
    } else if (SELLER_MARKERS.some((m) => lower.includes(m))) {
      currentZone = 'SELLER';
    } else if (
      (currentZone === 'SELLER' || currentZone === 'BUYER') &&
      TABLE_START_MARKERS.some((m) => lower.includes(m))
    ) {
      currentZone = 'TABLE';
    }

    // Ký hiệu hóa đơn
    if (!inv.invoice_symbol) {
      const mSym = raw.match(
        /(?:ký hiệu|ky hieu|serial(?:\s*no)?)\s*(?:\([^)]*\))?\s*[:\-]?\s*([A-Z0-9/]{5,12})/i
      );
      if (mSym) {
        setField('invoice_symbol', mSym[1].trim().toUpperCase(), lineObj);
      }
    }

    // Số hóa đơn
    if (!inv.invoice_number) {
      const excluded = ['mã số thuế', 'ma so thue', 'tài khoản', 'tai khoan', 'điện thoại', 'dien thoai', 'số lượng', 'so luong'];
      if (!excluded.some((ex) => lower.includes(ex))) {
        const mNum = raw.match(
          /(?:(?:số|so)\s*\(?(?:no\.?|invoice\s*no\.?)?\)?|số hóa đơn|so hoa don|invoice\s*(?:no|number))\s*[:\-]?\s*([0-9]{1,12})\b/i
        );
        if (mNum) {
          setField('invoice_number', mNum[1].trim(), lineObj);
        }
      }
    }

    // Ngày lập hóa đơn
    if (!inv.invoice_date) {
      if (['ngày', 'ngay', 'date', 'tháng', 'thang', 'năm', 'nam'].some((k) => lower.includes(k))) {
        const normDt = normalizeDateStr(raw);
        if (normDt) {
          setField('invoice_date', normDt, lineObj);
        }
      }
    }

    // Tên người bán
    if (SELLER_MARKERS.some((m) => lower.includes(m)) && !inv.seller_name) {
      const mSel = raw.match(
        /(?:đơn vị bán hàng|don vi ban hang|tên người bán|ten nguoi ban|người bán|nguoi ban|bên bán|ben ban|seller|vendor)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)/i
      );
      if (mSel && mSel[1].trim().length >= 3) {
        setField('seller_name', mSel[1].trim(), lineObj);
      } else if (idx + 1 < lines.length) {
        const nextText = lines[idx + 1].text.trim();
        if (nextText.length > 4 && !nextText.includes(':')) {
          setField('seller_name', nextText, lines[idx + 1]);
        }
      }
    }

    // Tên người mua
    if (BUYER_MARKERS.some((m) => lower.includes(m))) {
      const mBuyPerson = raw.match(
        /(?:họ tên người mua(?:\s*hàng)?|ho ten nguoi mua(?:\s*hang)?|họ và tên người mua(?:\s*hàng)?)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)/i
      );
      const mBuyUnit = raw.match(
        /(?:tên đơn vị(?:\s*mua(?:\s*hàng)?)?|ten don vi(?:\s*mua(?:\s*hang)?)?|đơn vị mua(?:\s*hàng)?|don vi mua(?:\s*hang)?|tên người mua|ten nguoi mua|khách hàng|khach hang|customer|buyer)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)/i
      );
      if (mBuyPerson && !inv.buyer_name && mBuyPerson[1].trim().length >= 2) {
        setField('buyer_name', mBuyPerson[1].trim(), lineObj);
      } else if (mBuyUnit && !mBuyPerson && mBuyUnit[1].trim().length >= 2) {
        setField('buyer_name', mBuyUnit[1].trim(), lineObj);
      }
    }

    // Nhận diện tên Công ty ở phần đầu (HEADER/SELLER) trước khi vào vùng BUYER
    if (!inv.seller_name && (currentZone === 'HEADER' || currentZone === 'SELLER')) {
      if (/\b(công ty|cong ty|doanh nghiệp|doanh nghiep|tập đoàn|tap doan|chi nhánh|chi nhanh|hợp tác xã)\b/i.test(lower)) {
        if (!BUYER_MARKERS.some((b) => lower.includes(b)) && !lower.includes('người mua') && !lower.includes('nguoi mua')) {
          const cleanedCompany = raw
            .replace(/^(?:đơn vị bán hàng|don vi ban hang|người bán|nguoi ban)\s*(?:\([^)]*\))?\s*[:\-]?\s*/i, '')
            .trim();
          if (cleanedCompany.length >= 5) {
            setField('seller_name', cleanedCompany, lineObj);
            currentZone = 'SELLER';
          }
        }
      }
    }

    // Mã số thuế (MST) — Phân biệt rõ MST người bán và MST người mua
    if (['mã số thuế', 'ma so thue', 'mst', 'tax code', 'tax id'].some((k) => lower.includes(k))) {
      const mstMatch = raw.match(MST_EXTRACT_REGEX);
      if (mstMatch) {
        const mstVal = mstMatch[1].replace(/\s+/g, '');
        if (['mua', 'buyer', 'customer', 'khách hàng', 'khach hang'].some((b) => lower.includes(b))) {
          if (!inv.buyer_tax_id) {
            setField('buyer_tax_id', mstVal, lineObj);
          }
        } else if (['bán', 'ban', 'seller', 'vendor', 'supplier'].some((s) => lower.includes(s))) {
          if (!inv.seller_tax_id) {
            setField('seller_tax_id', mstVal, lineObj);
          }
        } else if (currentZone === 'BUYER') {
          if (!inv.buyer_tax_id) {
            setField('buyer_tax_id', mstVal, lineObj);
          }
        } else if (currentZone === 'HEADER' || currentZone === 'SELLER') {
          if (!inv.seller_tax_id) {
            setField('seller_tax_id', mstVal, lineObj);
          } else if (!inv.buyer_tax_id && mstVal !== inv.seller_tax_id) {
            setField('buyer_tax_id', mstVal, lineObj);
          }
        }
      }
    }

    // Địa chỉ người bán
    if (!inv.seller_address && (currentZone === 'HEADER' || currentZone === 'SELLER')) {
      const mAddr = raw.match(/(?:địa chỉ|dia chi|address)\s*(?:\([^)]*\))?\s*[:\-]\s*(.+)/i);
      if (mAddr && mAddr[1].trim().length >= 5) {
        setField('seller_address', mAddr[1].trim(), lineObj);
      }
    }

    // Thuế suất GTGT
    if (
      !inv.vat_rate &&
      ['thuế suất', 'thue suat', 'vat rate', 'thuế gtgt'].some((k) => lower.includes(k))
    ) {
      const mRate = lower.match(/(\d{1,2}\s*%|kct|không chịu thuế)/);
      if (mRate) {
        setField('vat_rate', mRate[1].replace(/\s+/g, '').toUpperCase(), lineObj);
      }
    }

    // Tiền hàng, tiền thuế, chiết khấu, tổng thanh toán
    const numbersInLine = raw.match(
      /(?<!\d)\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\b\d{4,12}\b/g
    );
    let lastAmount: number | null = null;
    if (numbersInLine && numbersInLine.length > 0) {
      lastAmount = parseVietnameseNumber(numbersInLine[numbersInLine.length - 1]);
    }

    if (lastAmount !== null) {
      if (
        [
          'cộng tiền hàng',
          'cong tien hang',
          'tiền trước thuế',
          'thành tiền chưa có thuế',
          'total amount without vat',
          'subtotal',
        ].some((k) => lower.includes(k))
      ) {
        if (inv.subtotal_amount === null) {
          setField('subtotal_amount', lastAmount, lineObj);
        }
      } else if (
        [
          'tiền thuế gtgt',
          'tien thue gtgt',
          'cộng tiền thuế',
          'thuế giá trị gia tăng',
          'vat amount',
          'tax amount',
        ].some((k) => lower.includes(k)) &&
        !lower.includes('tổng cộng')
      ) {
        if (inv.vat_amount === null) {
          setField('vat_amount', lastAmount, lineObj);
        }
      } else if (['chiết khấu', 'chiet khau', 'giảm trừ', 'discount'].some((k) => lower.includes(k))) {
        if (inv.discount_amount === null) {
          setField('discount_amount', lastAmount, lineObj);
        }
      } else if (
        [
          'tổng cộng tiền thanh toán',
          'tong cong tien thanh toan',
          'tổng tiền thanh toán',
          'tổng thanh toán',
          'total payment',
          'grand total',
          'total amount',
        ].some((k) => lower.includes(k))
      ) {
        setField('total_amount', lastAmount, lineObj);
      }
    }

    // Loại tiền tệ
    if (['đơn vị tiền tệ', 'loại tiền', 'currency', 'tỷ giá'].some((k) => lower.includes(k))) {
      if (lower.includes('usd')) setField('currency', 'USD', lineObj);
      else if (lower.includes('eur')) setField('currency', 'EUR', lineObj);
      else if (lower.includes('vnd') || lower.includes('vnđ')) setField('currency', 'VND', lineObj);
    }

    // Tóm tắt hàng hóa
    if (currentZone === 'TABLE') {
      const mItem = raw.match(/^\s*(\d{1,2})\s+([A-Za-zÀ-ỹ0-9][^:]{4,90})/);
      if (
        mItem &&
        !['cộng tiền', 'thuế suất', 'tổng cộng', 'số tiền viết bằng chữ'].some((s) =>
          lower.includes(s)
        )
      ) {
        const desc = mItem[2].split('   ')[0].trim();
        if (desc.length >= 3 && !itemDescriptions.includes(desc)) {
          itemDescriptions.push(desc);
        }
      }
    }
  }

  if (itemDescriptions.length > 0) {
    inv.items_summary = itemDescriptions.slice(0, 5).join('; ');
    inv.field_sources['items_summary'] = inv.extraction_method;
  }

  const requiredFields: (keyof ExtractedInvoice)[] = [
    'seller_name',
    'seller_tax_id',
    'invoice_number',
    'invoice_date',
    'subtotal_amount',
    'vat_amount',
    'total_amount',
  ];

  for (const req of requiredFields) {
    const val = inv[req];
    const conf = inv.field_confidences[req as string] ?? 0;
    if (val === null || val === '' || (conf > 0 && conf < 0.85)) {
      if (!inv.uncertain_fields.includes(req as string)) {
        inv.uncertain_fields.push(req as string);
      }
    }
  }

  return inv;
}

export function validateSingleInvoice(
  inv: ExtractedInvoice,
  roundingTolerance = 5
): ExtractedInvoice {
  const issues: ValidationIssue[] = [];

  if (!inv.seller_name.trim()) {
    issues.push({
      code: 'MISSING_SELLER_NAME',
      severity: 'WARNING',
      field: 'seller_name',
      message: 'Chưa nhận diện được Tên người bán. Cần kiểm tra đối chiếu với file PDF gốc.',
    });
  }

  if (!inv.seller_tax_id.trim()) {
    issues.push({
      code: 'MISSING_SELLER_MST',
      severity: 'ERROR',
      field: 'seller_tax_id',
      message: 'Thiếu Mã số thuế người bán.',
    });
  } else if (!VALID_MST_REGEX.test(inv.seller_tax_id.trim())) {
    issues.push({
      code: 'INVALID_SELLER_MST_FORMAT',
      severity: 'ERROR',
      field: 'seller_tax_id',
      message: `MST người bán '${inv.seller_tax_id}' không đúng định dạng chuẩn (10 số hoặc 10-3 số).`,
    });
  }

  if (inv.buyer_tax_id.trim() && !VALID_MST_REGEX.test(inv.buyer_tax_id.trim())) {
    issues.push({
      code: 'INVALID_BUYER_MST_FORMAT',
      severity: 'WARNING',
      field: 'buyer_tax_id',
      message: `MST người mua '${inv.buyer_tax_id}' không đúng định dạng chuẩn.`,
    });
  }

  if (
    inv.seller_tax_id.trim() &&
    inv.buyer_tax_id.trim() &&
    inv.seller_tax_id.trim() === inv.buyer_tax_id.trim()
  ) {
    issues.push({
      code: 'SAME_SELLER_BUYER_MST',
      severity: 'ERROR',
      field: 'buyer_tax_id',
      message: 'MST người bán và MST người mua trùng nhau. Vui lòng kiểm tra có bị gán nhầm không.',
    });
  }

  if (!inv.invoice_number.trim()) {
    issues.push({
      code: 'MISSING_INVOICE_NUMBER',
      severity: 'ERROR',
      field: 'invoice_number',
      message: 'Thiếu Số hóa đơn.',
    });
  }

  if (!inv.invoice_date.trim()) {
    issues.push({
      code: 'MISSING_INVOICE_DATE',
      severity: 'WARNING',
      field: 'invoice_date',
      message: 'Thiếu Ngày lập hóa đơn.',
    });
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.invoice_date.trim())) {
    issues.push({
      code: 'INVALID_INVOICE_DATE',
      severity: 'ERROR',
      field: 'invoice_date',
      message: `Ngày hóa đơn '${inv.invoice_date}' không hợp lệ (cần dạng YYYY-MM-DD).`,
    });
  }

  if (inv.total_amount === null) {
    issues.push({
      code: 'MISSING_TOTAL_AMOUNT',
      severity: 'ERROR',
      field: 'total_amount',
      message: 'Thiếu Tổng tiền thanh toán.',
    });
  } else if (inv.subtotal_amount !== null && inv.vat_amount !== null) {
    const discount = inv.discount_amount ?? 0;
    const expectedTotal = inv.subtotal_amount - discount + inv.vat_amount;
    const diff = Math.abs(expectedTotal - inv.total_amount);
    if (diff > roundingTolerance) {
      issues.push({
        code: 'MATH_MISMATCH_TOTAL',
        severity: 'ERROR',
        field: 'total_amount',
        message: `Sai lệch cộng tiền: Tiền trước thuế (${inv.subtotal_amount.toLocaleString('vi-VN')}) - Chiết khấu (${discount.toLocaleString('vi-VN')}) + Tiền thuế (${inv.vat_amount.toLocaleString('vi-VN')}) = ${expectedTotal.toLocaleString('vi-VN')}, lệch ${diff.toLocaleString('vi-VN')} so với Tổng thanh toán (${inv.total_amount.toLocaleString('vi-VN')}).`,
      });
      if (!inv.uncertain_fields.includes('total_amount')) {
        inv.uncertain_fields.push('total_amount');
      }
    }

    if (inv.vat_rate && inv.vat_rate.endsWith('%') && inv.subtotal_amount > 0) {
      const rateNum = Number(inv.vat_rate.replace('%', '').trim()) / 100;
      if (Number.isFinite(rateNum)) {
        const expectedVat = (inv.subtotal_amount - discount) * rateNum;
        const vatDiff = Math.abs(expectedVat - inv.vat_amount);
        if (vatDiff > Math.max(roundingTolerance, inv.subtotal_amount * 0.002)) {
          issues.push({
            code: 'VAT_RATE_MISMATCH',
            severity: 'WARNING',
            field: 'vat_amount',
            message: `Tiền thuế (${inv.vat_amount.toLocaleString('vi-VN')}) lệch so với mức thuế suất ${inv.vat_rate} (dự kiến ~${Math.round(expectedVat).toLocaleString('vi-VN')}).`,
          });
        }
      }
    }
  }

  inv.validation_issues = issues;

  const hasError = issues.some((i) => i.severity === 'ERROR');
  const hasWarning = issues.some((i) => i.severity === 'WARNING');

  if (inv.verification_status === 'VERIFIED' && !hasError) {
    // Giữ trạng thái VERIFIED do người dùng đã xác nhận và không có lỗi nghiêm trọng
  } else if (hasError || hasWarning || inv.uncertain_fields.length > 0) {
    inv.verification_status = 'NEEDS_REVIEW';
  } else {
    inv.verification_status = 'VERIFIED';
  }

  return inv;
}

export function validateInvoiceBatch(
  invoices: ExtractedInvoice[],
  roundingTolerance = 5
): ExtractedInvoice[] {
  const cloned = invoices.map((inv) => ({
    ...inv,
    uncertain_fields: [...inv.uncertain_fields],
    validation_issues: [],
  }));

  for (const inv of cloned) {
    validateSingleInvoice(inv, roundingTolerance);
  }

  for (let i = 0; i < cloned.length; i++) {
    for (let j = i + 1; j < cloned.length; j++) {
      const a = cloned[i];
      const b = cloned[j];

      if (a.file_sha256 && a.file_sha256 === b.file_sha256) {
        appendDuplicateIssue(
          a,
          'DUPLICATE_FILE_HASH',
          'ERROR',
          'source_filename',
          `Trùng nội dung file PDF (cùng mã băm SHA-256) với file '${b.source_filename}'.`
        );
        appendDuplicateIssue(
          b,
          'DUPLICATE_FILE_HASH',
          'ERROR',
          'source_filename',
          `Trùng nội dung file PDF (cùng mã băm SHA-256) với file '${a.source_filename}'.`
        );
        continue;
      }

      const numA = a.invoice_number.trim().replace(/^0+/, '');
      const numB = b.invoice_number.trim().replace(/^0+/, '');
      if (numA && numA === numB) {
        const mstA = a.seller_tax_id.trim();
        const mstB = b.seller_tax_id.trim();
        const symA = a.invoice_symbol.trim().toUpperCase();
        const symB = b.invoice_symbol.trim().toUpperCase();

        if (mstA && mstA === mstB && (!symA || !symB || symA === symB)) {
          appendDuplicateIssue(
            a,
            'DUPLICATE_INVOICE_EXACT',
            'ERROR',
            'invoice_number',
            `Trùng Số hóa đơn (${a.invoice_number}) và MST người bán (${mstA}) với file '${b.source_filename}'.`
          );
          appendDuplicateIssue(
            b,
            'DUPLICATE_INVOICE_EXACT',
            'ERROR',
            'invoice_number',
            `Trùng Số hóa đơn (${b.invoice_number}) và MST người bán (${mstB}) với file '${a.source_filename}'.`
          );
        } else if (a.total_amount !== null && a.total_amount === b.total_amount) {
          appendDuplicateIssue(
            a,
            'DUPLICATE_INVOICE_SUSPECTED',
            'WARNING',
            'invoice_number',
            `Nghi ngờ trùng: Cùng Số hóa đơn (${a.invoice_number}) và cùng Tổng tiền (${a.total_amount.toLocaleString('vi-VN')}) với file '${b.source_filename}', cần đối chiếu MST/Ký hiệu.`
          );
          appendDuplicateIssue(
            b,
            'DUPLICATE_INVOICE_SUSPECTED',
            'WARNING',
            'invoice_number',
            `Nghi ngờ trùng: Cùng Số hóa đơn (${b.invoice_number}) và cùng Tổng tiền (${b.total_amount.toLocaleString('vi-VN')}) với file '${a.source_filename}', cần đối chiếu MST/Ký hiệu.`
          );
        }
      }
    }
  }

  return cloned;
}

function appendDuplicateIssue(
  inv: ExtractedInvoice,
  code: string,
  severity: 'ERROR' | 'WARNING',
  field: string,
  message: string
) {
  if (!inv.validation_issues.some((iss) => iss.code === code && iss.message === message)) {
    inv.validation_issues.push({ code, severity, field, message });
  }
  inv.verification_status = 'DUPLICATE_WARNING';
}

const COLUMN_SYNONYMS: Record<string, string[]> = {
  stt: ['stt', 'no', 'no.', 'số thứ tự', 'so thu tu'],
  invoice_symbol: ['ký hiệu', 'ky hieu', 'mẫu số', 'ký hiệu hđ', 'serial', 'symbol'],
  invoice_number: ['số hóa đơn', 'so hoa don', 'số hđ', 'invoice no', 'invoice number', 'số'],
  invoice_date: ['ngày hóa đơn', 'ngay hoa don', 'ngày lập', 'ngày tháng', 'ngay', 'date', 'invoice date'],
  seller_name: ['tên người bán', 'ten nguoi ban', 'đơn vị bán', 'nhà cung cấp', 'người bán', 'seller', 'vendor'],
  seller_tax_id: ['mã số thuế người bán', 'mst người bán', 'mst bán', 'mã số thuế', 'mst', 'tax code', 'seller tax id'],
  seller_address: ['địa chỉ người bán', 'dia chi nguoi ban', 'địa chỉ', 'address'],
  buyer_name: ['tên người mua', 'ten nguoi mua', 'đơn vị mua', 'khách hàng', 'người mua', 'buyer'],
  buyer_tax_id: ['mst người mua', 'mã số thuế người mua', 'buyer tax id'],
  items_summary: ['nội dung', 'mặt hàng', 'tên hàng hóa', 'diễn giải', 'hàng hóa dịch vụ', 'description'],
  subtotal_amount: [
    'tiền trước thuế',
    'doanh số mua chưa có thuế',
    'giá trị chưa thuế',
    'thành tiền chưa thuế',
    'cộng tiền hàng',
    'subtotal',
    'amount before tax',
  ],
  vat_rate: ['thuế suất', 'thue suat', '% thuế', 'vat rate', 'tax rate'],
  vat_amount: ['tiền thuế', 'thuế gtgt', 'tiền thuế gtgt', 'vat amount', 'tax amount'],
  discount_amount: ['chiết khấu', 'giảm trừ', 'discount'],
  total_amount: ['tổng tiền', 'tổng thanh toán', 'tổng cộng', 'thành tiền', 'total amount', 'grand total'],
  currency: ['loại tiền', 'tiền tệ', 'đvt tiền', 'currency'],
  notes: ['ghi chú', 'note', 'notes', 'nhận xét'],
  source_filename: ['tên file', 'file nguồn', 'tệp đính kèm', 'source file'],
  verification_status: ['trạng thái', 'xác minh', 'status'],
};

export function matchHeaderToField(headerText: string): string | null {
  if (!headerText) return null;
  const norm = headerText.toLowerCase().trim().replace(/\s+/g, ' ');
  for (const [fieldKey, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const syn of synonyms) {
      if (norm === syn) return fieldKey;
    }
  }
  let bestField: string | null = null;
  let bestLen = 0;
  for (const [fieldKey, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const syn of synonyms) {
      if (norm.includes(syn) && syn.length > bestLen) {
        bestField = fieldKey;
        bestLen = syn.length;
      }
    }
  }
  return bestField;
}

/**
 * Tạo nội dung file PDF hợp lệ (chuẩn PDF 1.4) không chứa dữ liệu nhạy cảm
 * dùng cho bộ kiểm thử PDF điện tử, PDF scan, PDF nhiều trang và kiểm tra trùng lặp.
 */
export function buildSyntheticPdfBuffer(
  lines: string[],
  mode: 'TEXT_LAYER' | 'SCANNED_IMAGE' = 'TEXT_LAYER'
): Uint8Array {
  const escapedLines = lines.map((l) =>
    l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  );

  let streamContent = 'BT\n/F1 11 Tf\n40 760 Td\n16 TL\n';
  if (mode === 'TEXT_LAYER') {
    for (const line of escapedLines) {
      streamContent += `(${line}) Tj T*\n`;
    }
  } else {
    // Trang scan chỉ chứa bitmap/metadata ảnh scan và bình luận OCR_SCAN_DATA để test luồng PaddleOCR
    streamContent += `(SCAN_IMAGE_ONLY_PAGE) Tj T*\n`;
    for (const line of escapedLines) {
      streamContent += `%PADDLE_SCAN_LINE: ${line}\n`;
    }
  }
  streamContent += 'ET\n';

  const pdfText = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${streamContent.length} >>
stream
${streamContent}endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
450
%%EOF`;

  return new TextEncoder().encode(pdfText);
}
