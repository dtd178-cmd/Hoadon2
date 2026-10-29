import {
  ExtractedInvoice,
  ExtractionMethod,
  OcrTextLine,
  ValidationIssue,
} from '../types/invoice';

const SELLER_FOLDED_MARKERS = [
  'don vi ban hang',
  'ten don vi ban hang',
  'ten don vi ban',
  'don vi ban',
  'ten nguoi ban',
  'nguoi ban hang',
  'nguoi ban',
  'ben ban',
  'cong ty ban hang',
  'don vi xuat hoa don',
  'cong ty xuat hoa don',
  'nha cung cap',
  'seller',
  'vendor',
  'supplier',
  'merchandiser',
  'issued by',
];

const BUYER_FOLDED_MARKERS = [
  'ho ten nguoi mua hang',
  'ho va ten nguoi mua hang',
  'ho ten nguoi mua',
  'nguoi mua hang',
  'don vi mua hang',
  'ten don vi mua hang',
  'ten don vi mua',
  'don vi mua',
  'ten nguoi mua',
  'nguoi mua',
  'ben mua',
  'khach hang',
  'ten khach hang',
  'buyer',
  'customer',
  'bill to',
  'sold to',
  'purchaser',
];

const TABLE_START_FOLDED_MARKERS = [
  'stt',
  'ten hang hoa',
  'dich vu',
  'don vi tinh',
  'so luong',
  'don gia',
  'thanh tien',
  'description',
  'quantity',
  'unit price',
];

const VALID_MST_REGEX = /^\d{10}(-\d{3})?$/;
const MST_EXTRACT_REGEX = /(?<!\d)(\d{10}(?:\s*-\s*\d{3})?)(?!\d)/g;

const SELLER_LABEL_PREFIX_RE =
  /^\s*(?:tên\s+đơn\s+vị\s+bán(?:\s+hàng)?|ten\s+don\s+vi\s+ban(?:\s+hang)?|đơn\s+vị\s+bán(?:\s+hàng)?|don\s+vi\s+ban(?:\s+hang)?|tên\s+người\s+bán(?:\s+hàng)?|ten\s+nguoi\s+ban(?:\s+hang)?|người\s+bán(?:\s+hàng)?|nguoi\s+ban(?:\s+hang)?|bên\s+bán|ben\s+ban|bên\s+a|ben\s+a|công\s+ty\s+bán(?:\s+hàng)?|cong\s+ty\s+ban(?:\s+hang)?|đơn\s+vị\s+xuất\s+hóa\s+đơn|don\s+vi\s+xuat\s+hoa\s+don|công\s+ty\s+xuất\s+hóa\s+đơn|cong\s+ty\s+xuat\s+hoa\s+don|nhà\s+cung\s+cấp|nha\s+cung\s+cap|seller(?:'s)?\s*name|seller|vendor|supplier|merchandiser|issued\s+by)(?:\s*\([^)]*\))*(?:\s*\/\s*(?:seller(?:'s)?\s*name|seller|vendor|supplier))?\s*[:：\-\–\—]+\s*/i;

const BUYER_UNIT_LABEL_PREFIX_RE =
  /^\s*(?:tên\s+đơn\s+vị(?:\s+mua(?:\s+hàng)?)?|ten\s+don\s+vi(?:\s+mua(?:\s+hang)?)?|đơn\s+vị\s+mua(?:\s+hàng)?|don\s+vi\s+mua(?:\s+hang)?|tên\s+người\s+mua|ten\s+nguoi\s+mua|tên\s+khách\s+hàng|ten\s+khach\s+hang|khách\s+hàng|khach\s+hang|bên\s+mua|ben\s+mua|bên\s+b|ben\s+b|buyer(?:'s)?\s*name|buyer|customer(?:'s)?\s*name|customer|company\s*name|bill\s+to|sold\s+to|purchaser)(?:\s*\([^)]*\))*(?:\s*\/\s*(?:buyer|customer|company\s*name))?\s*[:：\-\–\—]+\s*/i;

const BUYER_PERSON_LABEL_PREFIX_RE =
  /^\s*(?:họ\s+và\s+tên\s+người\s+mua(?:\s+hàng)?|ho\s+va\s+ten\s+nguoi\s+mua(?:\s+hang)?|họ\s+tên\s+người\s+mua(?:\s+hàng)?|ho\s+ten\s+nguoi\s+mua(?:\s+hang)?|người\s+mua\s+hàng|nguoi\s+mua\s+hang|người\s+mua|nguoi\s+mua)(?:\s*\([^)]*\))*\s*[:：\-\–\—]+\s*/i;

export function normalizeVnText(text: string): string {
  if (!text) return '';
  return text.normalize('NFC').trim();
}

export function foldVnAscii(text: string): string {
  if (!text) return '';
  return normalizeVnText(text)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function isPlaceholderValue(val: string): boolean {
  if (!val) return true;
  const cleaned = val.replace(/[\s._\-–—:：,;]+/g, '');
  return cleaned.length < 2;
}

export function stripPartyLabel(
  rawLine: string,
  role: 'seller' | 'buyer_unit' | 'buyer_person' = 'seller'
): string {
  const text = normalizeVnText(rawLine);
  if (!text) return '';

  let cleaned = text;
  if (role === 'seller') {
    cleaned = text.replace(SELLER_LABEL_PREFIX_RE, '');
  } else if (role === 'buyer_unit') {
    cleaned = text.replace(BUYER_UNIT_LABEL_PREFIX_RE, '');
  } else {
    cleaned = text.replace(BUYER_PERSON_LABEL_PREFIX_RE, '');
  }

  if (cleaned === text) {
    const colonMatch = text.match(/^([^:：]{2,48}?)\s*[:：]\s*(.+)$/);
    if (colonMatch) {
      const prefixFolded = foldVnAscii(colonMatch[1]);
      const remainder = colonMatch[2].trim();
      if (role === 'seller' && SELLER_FOLDED_MARKERS.some((m) => prefixFolded.includes(m))) {
        cleaned = remainder;
      } else if (
        role !== 'seller' &&
        (BUYER_FOLDED_MARKERS.some((m) => prefixFolded.includes(m)) ||
          prefixFolded.includes('ten don vi') ||
          prefixFolded.includes('company name'))
      ) {
        cleaned = remainder;
      }
    }
  }

  cleaned = cleaned.split(
    /\s{2,}(?:mã\s+số\s+thuế|ma\s+so\s+thue|mst|tax\s+code|tax\s+id)\b/i
  )[0];
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[:：\-\–\—]+\s*/, '')
    .trim();

  if (isPlaceholderValue(cleaned)) return '';
  return cleaned;
}

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
  if (!text) return null;
  const folded = foldVnAscii(text);
  const mVn = folded.match(/ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})/);
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
  let buyerUnitCandidate: { name: string; line: OcrTextLine } | null = null;
  let buyerPersonCandidate: { name: string; line: OcrTextLine } | null = null;
  const itemDescriptions: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineObj = lines[idx];
    const raw = normalizeVnText(lineObj.text);
    if (!raw) continue;
    const folded = foldVnAscii(raw);

    const hasBuyerMarker = BUYER_FOLDED_MARKERS.some((m) => folded.includes(m));
    const hasSellerMarker = SELLER_FOLDED_MARKERS.some((m) => folded.includes(m));

    if (hasBuyerMarker && !hasSellerMarker) {
      currentZone = 'BUYER';
    } else if (hasSellerMarker && !hasBuyerMarker) {
      currentZone = 'SELLER';
    } else if (
      (currentZone === 'SELLER' || currentZone === 'BUYER') &&
      TABLE_START_FOLDED_MARKERS.filter((m) => folded.includes(m)).length >= 2
    ) {
      currentZone = 'TABLE';
    }

    // Ký hiệu hóa đơn
    if (!inv.invoice_symbol) {
      const mSym = folded.match(
        /(?:ky\s*hieu|serial(?:\s*no\.?)?|mau\s*so\s*[-/]\s*ky\s*hieu)\s*(?:\([^)]*\))?\s*[:：\-]?\s*([A-Z0-9/]{5,14})/i
      );
      if (mSym) {
        setField('invoice_symbol', mSym[1].trim().toUpperCase(), lineObj);
      }
    }

    // Số hóa đơn
    if (!inv.invoice_number) {
      const excluded = ['ma so thue', 'tai khoan', 'dien thoai', 'so luong', 'so thu tu'];
      const isExcluded =
        excluded.some((ex) => folded.includes(ex)) &&
        !folded.includes('so hoa don') &&
        !folded.includes('invoice no');
      if (!isExcluded) {
        const mNum = folded.match(
          /(?:so\s*hoa\s*don|invoice\s*(?:no\.?|number)|(?:\bso\b|\bno\.?)\s*(?:\([^)]*\))?)\s*[:：\-]?\s*([0-9]{1,12})\b/i
        );
        if (mNum) {
          setField('invoice_number', mNum[1].trim(), lineObj);
        }
      }
    }

    // Ngày lập hóa đơn
    if (!inv.invoice_date) {
      if (['ngay', 'date', 'thang', 'nam'].some((k) => folded.includes(k))) {
        const normDt = normalizeDateStr(raw);
        if (normDt) {
          setField('invoice_date', normDt, lineObj);
        }
      }
    }

    // Tên người bán
    if (hasSellerMarker && !hasBuyerMarker && !inv.seller_name) {
      const isTaxOrAddrOnly = [
        'ma so thue',
        'mst',
        'tax code',
        'dia chi',
        'address',
        'so tai khoan',
        'dien thoai',
      ].some((p) => folded.startsWith(p));
      if (!isTaxOrAddrOnly) {
        const extractedSeller = stripPartyLabel(raw, 'seller');
        if (extractedSeller && extractedSeller !== raw && extractedSeller.length >= 3) {
          setField('seller_name', extractedSeller, lineObj);
        } else if (idx + 1 < lines.length) {
          const nextRaw = normalizeVnText(lines[idx + 1].text);
          const nextFolded = foldVnAscii(nextRaw);
          if (
            nextRaw.length > 4 &&
            !nextRaw.includes(':') &&
            !nextRaw.includes('：') &&
            !BUYER_FOLDED_MARKERS.some((bm) => nextFolded.includes(bm)) &&
            !['ma so thue', 'mst', 'dia chi', 'so tai khoan'].some((p) =>
              nextFolded.startsWith(p)
            )
          ) {
            setField('seller_name', nextRaw, lines[idx + 1]);
          }
        }
      }
    }

    // Tên người mua
    const isBuyerContextLine =
      hasBuyerMarker ||
      (currentZone === 'BUYER' &&
        /^\s*(?:tên\s+đơn\s+vị|ten\s+don\s+vi|đơn\s+vị|don\s+vi|company\s*name)\b/i.test(folded));
    if (isBuyerContextLine && !hasSellerMarker) {
      const isBuyerTaxOrAddrOnly = [
        'ma so thue',
        'mst',
        'tax code',
        'dia chi',
        'address',
        'so tai khoan',
        'hinh thuc thanh toan',
      ].some((p) => folded.startsWith(p));
      if (!isBuyerTaxOrAddrOnly) {
        const isPersonLabel =
          ['ho ten nguoi mua', 'ho va ten nguoi mua', 'nguoi mua hang'].some((p) =>
            folded.includes(p)
          ) && !folded.includes('don vi');
        if (isPersonLabel) {
          const valPerson = stripPartyLabel(raw, 'buyer_person');
          if (valPerson && valPerson !== raw && !buyerPersonCandidate) {
            buyerPersonCandidate = { name: valPerson, line: lineObj };
          }
        } else {
          const valUnit = stripPartyLabel(raw, 'buyer_unit');
          if (valUnit && valUnit !== raw && !buyerUnitCandidate) {
            buyerUnitCandidate = { name: valUnit, line: lineObj };
          }
        }
      }
    }

    // Nhận diện tên Công ty ở phần đầu (HEADER/SELLER) trước khi vào vùng BUYER
    if (!inv.seller_name && (currentZone === 'HEADER' || currentZone === 'SELLER') && !hasBuyerMarker) {
      if (
        /\b(cong\s+ty|doanh\s+nghiep|tap\s+doan|chi\s+nhanh|hop\s+tac\s+xa|ho\s+kinh\s+doanh)\b/i.test(
          folded
        )
      ) {
        if (
          !folded.includes('nguoi mua') &&
          !folded.includes('don vi mua') &&
          !folded.includes('khach hang')
        ) {
          const cleanedCompany = stripPartyLabel(raw, 'seller');
          if (cleanedCompany.length >= 5) {
            setField('seller_name', cleanedCompany, lineObj);
            currentZone = 'SELLER';
          }
        }
      }
    }

    // Mã số thuế (MST) — Phân biệt rõ MST người bán và MST người mua
    if (['ma so thue', 'mst', 'tax code', 'tax id'].some((k) => folded.includes(k))) {
      const matches = Array.from(raw.matchAll(MST_EXTRACT_REGEX));
      for (const mstMatch of matches) {
        const mstVal = mstMatch[1].replace(/\s+/g, '');
        const prefixBeforeMst = foldVnAscii(raw.slice(0, mstMatch.index ?? 0));

        const isExplicitBuyerMst =
          ['nguoi mua', 'don vi mua', 'ben mua', 'buyer', 'customer', 'khach hang'].some(
            (b) => prefixBeforeMst.includes(b) || folded.includes(b)
          ) &&
          !['nguoi ban', 'don vi ban', 'ben ban', 'seller', 'vendor'].some((s) =>
            prefixBeforeMst.includes(s)
          );

        const isExplicitSellerMst =
          ['nguoi ban', 'don vi ban', 'ben ban', 'seller', 'vendor', 'supplier', 'nha cung cap'].some(
            (s) => prefixBeforeMst.includes(s) || folded.includes(s)
          ) && !isExplicitBuyerMst;

        if (isExplicitBuyerMst) {
          if (!inv.buyer_tax_id) {
            setField('buyer_tax_id', mstVal, lineObj);
          }
        } else if (isExplicitSellerMst) {
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
      const mAddr = raw.match(/^(?:địa\s*chỉ|dia\s*chi|address)\s*(?:\([^)]*\))?\s*[:：\-]\s*(.+)/i);
      if (mAddr && !isPlaceholderValue(mAddr[1]) && mAddr[1].trim().length >= 5) {
        setField('seller_address', mAddr[1].trim(), lineObj);
      }
    }

    // Thuế suất GTGT
    if (
      !inv.vat_rate &&
      ['thue suat', 'vat rate', 'thue gtgt'].some((k) => folded.includes(k))
    ) {
      const mRate = folded.match(/(\d{1,2}\s*%|kct|khong\s+chiu\s+thue|kkknt)/);
      if (mRate) {
        let rateStr = mRate[1].replace(/\s+/g, '').toUpperCase();
        if (rateStr.includes('KHONG')) rateStr = 'KCT';
        setField('vat_rate', rateStr, lineObj);
      }
    }

    // Tiền hàng, tiền thuế, chiết khấu, tổng thanh toán
    const numbersInLine = raw.match(
      /(?<!\d)-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\b\d{4,12}\b/g
    );
    let lastAmount: number | null = null;
    if (numbersInLine && numbersInLine.length > 0) {
      lastAmount = parseVietnameseNumber(numbersInLine[numbersInLine.length - 1]);
    }

    if (lastAmount !== null) {
      if (
        [
          'cong tien hang',
          'tien truoc thue',
          'thanh tien chua co thue',
          'doanh so mua chua co thue',
          'total amount without vat',
          'subtotal',
        ].some((k) => folded.includes(k)) &&
        !folded.includes('tong cong tien thanh toan')
      ) {
        if (inv.subtotal_amount === null) {
          setField('subtotal_amount', lastAmount, lineObj);
        }
      } else if (
        [
          'tien thue gtgt',
          'cong tien thue',
          'thue gia tri gia tang',
          'vat amount',
          'tax amount',
        ].some((k) => folded.includes(k)) &&
        !folded.includes('tong cong')
      ) {
        if (inv.vat_amount === null) {
          setField('vat_amount', lastAmount, lineObj);
        }
      } else if (['chiet khau', 'giam tru', 'discount'].some((k) => folded.includes(k))) {
        if (inv.discount_amount === null) {
          setField('discount_amount', Math.abs(lastAmount), lineObj);
        }
      } else if (
        [
          'tong cong tien thanh toan',
          'tong tien thanh toan',
          'tong thanh toan',
          'total payment',
          'grand total',
          'total amount',
        ].some((k) => folded.includes(k)) &&
        !folded.includes('without vat')
      ) {
        setField('total_amount', lastAmount, lineObj);
      }
    }

    // Loại tiền tệ
    if (['don vi tien te', 'loai tien', 'currency', 'ty gia'].some((k) => folded.includes(k))) {
      if (folded.includes('usd')) setField('currency', 'USD', lineObj);
      else if (folded.includes('eur')) setField('currency', 'EUR', lineObj);
      else if (folded.includes('vnd')) setField('currency', 'VND', lineObj);
    }

    // Tóm tắt hàng hóa
    if (currentZone === 'TABLE') {
      const mItem = raw.match(/^\s*(\d{1,2})\s+([A-Za-zÀ-ỹ0-9][^:：]{4,90})/);
      if (
        mItem &&
        !['cong tien', 'thue suat', 'tong cong', 'so tien viet bang chu'].some((s) =>
          folded.includes(s)
        )
      ) {
        const desc = mItem[2].split('   ')[0].trim();
        if (desc.length >= 3 && !itemDescriptions.includes(desc)) {
          itemDescriptions.push(desc);
        }
      }
    }
  }

  if (buyerUnitCandidate) {
    setField('buyer_name', buyerUnitCandidate.name, buyerUnitCandidate.line);
  } else if (buyerPersonCandidate) {
    setField('buyer_name', buyerPersonCandidate.name, buyerPersonCandidate.line);
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

function normalizeInvoiceNumber(rawNum: string): string {
  const cleaned = (rawNum || '').trim().replace(/\s+/g, '');
  if (!cleaned) return '';
  const stripped = cleaned.replace(/^0+/, '');
  return stripped || '0';
}

export function validateSingleInvoice(
  inv: ExtractedInvoice,
  roundingTolerance = 5
): ExtractedInvoice {
  const existingDupIssues = inv.validation_issues.filter((i) =>
    i.code.startsWith('DUPLICATE_')
  );
  const issues: ValidationIssue[] = [];

  if (!inv.seller_name.trim()) {
    issues.push({
      code: 'MISSING_SELLER_NAME',
      severity: 'WARNING',
      field: 'seller_name',
      message: 'Chưa nhận diện được Tên người bán. Cần kiểm tra đối chiếu với file PDF gốc.',
    });
  }

  const sellerMst = inv.seller_tax_id.trim().replace(/\s+/g, '');
  if (!sellerMst) {
    issues.push({
      code: 'MISSING_SELLER_MST',
      severity: 'ERROR',
      field: 'seller_tax_id',
      message: 'Thiếu Mã số thuế người bán.',
    });
  } else if (!VALID_MST_REGEX.test(sellerMst)) {
    issues.push({
      code: 'INVALID_SELLER_MST_FORMAT',
      severity: 'ERROR',
      field: 'seller_tax_id',
      message: `MST người bán '${inv.seller_tax_id}' không đúng định dạng chuẩn (10 số hoặc 10-3 số).`,
    });
  }

  const buyerMst = inv.buyer_tax_id.trim().replace(/\s+/g, '');
  if (buyerMst && !VALID_MST_REGEX.test(buyerMst)) {
    issues.push({
      code: 'INVALID_BUYER_MST_FORMAT',
      severity: 'WARNING',
      field: 'buyer_tax_id',
      message: `MST người mua '${inv.buyer_tax_id}' không đúng định dạng chuẩn.`,
    });
  }

  if (sellerMst && buyerMst && sellerMst === buyerMst) {
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
    // Làm tròn tới 2 chữ số thập phân để tránh sai số dấu chấm động nhị phân
    const expectedWithDisc = Math.round((inv.subtotal_amount - discount + inv.vat_amount) * 100) / 100;
    const expectedNoDisc = Math.round((inv.subtotal_amount + inv.vat_amount) * 100) / 100;
    const diffWithDisc = Math.abs(expectedWithDisc - inv.total_amount);
    const diffNoDisc = Math.abs(expectedNoDisc - inv.total_amount);
    const bestDiff = Math.min(diffWithDisc, diffNoDisc);

    if (bestDiff > roundingTolerance) {
      issues.push({
        code: 'MATH_MISMATCH_TOTAL',
        severity: 'ERROR',
        field: 'total_amount',
        message: `Sai lệch cộng tiền: Tiền trước thuế (${inv.subtotal_amount.toLocaleString('vi-VN')}) - Chiết khấu (${discount.toLocaleString('vi-VN')}) + Tiền thuế (${inv.vat_amount.toLocaleString('vi-VN')}) = ${expectedWithDisc.toLocaleString('vi-VN')}, lệch ${diffWithDisc.toLocaleString('vi-VN')} so với Tổng thanh toán (${inv.total_amount.toLocaleString('vi-VN')}).`,
      });
      if (!inv.uncertain_fields.includes('total_amount')) {
        inv.uncertain_fields.push('total_amount');
      }
    }

    if (inv.vat_rate && inv.vat_rate.endsWith('%') && inv.subtotal_amount > 0) {
      const rateNum = Number(inv.vat_rate.replace('%', '').trim()) / 100;
      if (Number.isFinite(rateNum)) {
        const expectedVat1 = (inv.subtotal_amount - discount) * rateNum;
        const expectedVat2 = inv.subtotal_amount * rateNum;
        const vatDiff = Math.min(
          Math.abs(expectedVat1 - inv.vat_amount),
          Math.abs(expectedVat2 - inv.vat_amount)
        );
        if (vatDiff > Math.max(roundingTolerance, inv.subtotal_amount * 0.002)) {
          issues.push({
            code: 'VAT_RATE_MISMATCH',
            severity: 'WARNING',
            field: 'vat_amount',
            message: `Tiền thuế (${inv.vat_amount.toLocaleString('vi-VN')}) lệch so với mức thuế suất ${inv.vat_rate} (dự kiến ~${Math.round(expectedVat1).toLocaleString('vi-VN')}).`,
          });
        }
      }
    }
  }

  inv.validation_issues = [...issues, ...existingDupIssues];

  if (existingDupIssues.length > 0) {
    inv.verification_status = 'DUPLICATE_WARNING';
    return inv;
  }

  const hasError = issues.some((i) => i.severity === 'ERROR');
  const hasWarning = issues.some((i) => i.severity === 'WARNING');

  if (inv.verification_status === 'VERIFIED' && !hasError && !hasWarning) {
    inv.verification_status = 'VERIFIED';
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
    verification_status:
      inv.verification_status === 'DUPLICATE_WARNING' ? 'NEEDS_REVIEW' : inv.verification_status,
  }));

  for (const inv of cloned) {
    validateSingleInvoice(inv, roundingTolerance);
  }

  for (let i = 0; i < cloned.length; i++) {
    for (let j = i + 1; j < cloned.length; j++) {
      const a = cloned[i];
      const b = cloned[j];

      if (a.file_sha256 && b.file_sha256 && a.file_sha256 === b.file_sha256) {
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

      const numA = normalizeInvoiceNumber(a.invoice_number);
      const numB = normalizeInvoiceNumber(b.invoice_number);
      const mstA = a.seller_tax_id.trim().replace(/\s+/g, '');
      const mstB = b.seller_tax_id.trim().replace(/\s+/g, '');
      const symA = a.invoice_symbol.trim().replace(/\s+/g, '').toUpperCase();
      const symB = b.invoice_symbol.trim().replace(/\s+/g, '').toUpperCase();
      const sameTotal =
        a.total_amount !== null &&
        b.total_amount !== null &&
        Math.abs(a.total_amount - b.total_amount) <= roundingTolerance;
      const sameDate = Boolean(a.invoice_date.trim() && a.invoice_date.trim() === b.invoice_date.trim());

      if (numA && numA === numB) {
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
        } else if (sameTotal || (sameDate && (!mstA || !mstB || mstA === mstB))) {
          appendDuplicateIssue(
            a,
            'DUPLICATE_INVOICE_SUSPECTED',
            'WARNING',
            'invoice_number',
            `Nghi ngờ trùng: Cùng Số hóa đơn (${a.invoice_number}) và cùng Tổng tiền (${(a.total_amount ?? 0).toLocaleString('vi-VN')}) với file '${b.source_filename}', cần đối chiếu MST/Ký hiệu.`
          );
          appendDuplicateIssue(
            b,
            'DUPLICATE_INVOICE_SUSPECTED',
            'WARNING',
            'invoice_number',
            `Nghi ngờ trùng: Cùng Số hóa đơn (${b.invoice_number}) và cùng Tổng tiền (${(b.total_amount ?? 0).toLocaleString('vi-VN')}) với file '${a.source_filename}', cần đối chiếu MST/Ký hiệu.`
          );
        }
      } else if ((!numA || !numB) && mstA && mstA === mstB && sameDate && sameTotal) {
        appendDuplicateIssue(
          a,
          'DUPLICATE_INVOICE_SUSPECTED',
          'WARNING',
          'invoice_number',
          `Nghi ngờ trùng: Cùng MST người bán (${mstA}), cùng Ngày (${a.invoice_date}) và cùng Tổng tiền (${(a.total_amount ?? 0).toLocaleString('vi-VN')}) với file '${b.source_filename}'.`
        );
        appendDuplicateIssue(
          b,
          'DUPLICATE_INVOICE_SUSPECTED',
          'WARNING',
          'invoice_number',
          `Nghi ngờ trùng: Cùng MST người bán (${mstB}), cùng Ngày (${b.invoice_date}) và cùng Tổng tiền (${(b.total_amount ?? 0).toLocaleString('vi-VN')}) với file '${a.source_filename}'.`
        );
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
  if (!inv.uncertain_fields.includes(field)) {
    inv.uncertain_fields.push(field);
  }
  inv.verification_status = 'DUPLICATE_WARNING';
}

const COLUMN_SYNONYMS: Record<string, string[]> = {
  stt: ['stt', 'no', 'no.', 'số thứ tự', 'so thu tu', 'index'],
  invoice_symbol: ['ký hiệu', 'ky hieu', 'mẫu số', 'mau so', 'ký hiệu hđ', 'serial', 'symbol'],
  invoice_number: ['số hóa đơn', 'so hoa don', 'số hđ', 'so hd', 'invoice no', 'invoice number', 'số', 'so'],
  invoice_date: ['ngày hóa đơn', 'ngay hoa don', 'ngày lập', 'ngay lap', 'ngày tháng', 'ngay', 'date', 'invoice date'],
  seller_name: ['tên người bán', 'ten nguoi ban', 'đơn vị bán', 'don vi ban', 'nhà cung cấp', 'người bán', 'seller', 'vendor'],
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
  total_amount: ['tổng tiền', 'tổng thanh toán', 'tổng tiền thanh toán', 'tổng cộng', 'thành tiền', 'total amount', 'grand total'],
  equal_col_h: ['bằng cột h', 'bang cot h', 'cột i = cột h', 'cot i = cot h', 'giá trị quy đổi', 'gia tri quy doi'],
  currency: ['loại tiền', 'tiền tệ', 'đvt tiền', 'currency'],
  notes: ['ghi chú', 'note', 'notes', 'nhận xét'],
  source_filename: ['tên file', 'file nguồn', 'tệp đính kèm', 'source file'],
  verification_status: ['trạng thái', 'xác minh', 'status'],
};

export function matchHeaderToField(headerText: string): string | null {
  if (!headerText) return null;
  const norm = normalizeVnText(headerText).toLowerCase().replace(/\s+/g, ' ');
  const folded = foldVnAscii(headerText);

  for (const [fieldKey, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const syn of synonyms) {
      const synFolded = foldVnAscii(syn);
      if (norm === syn || folded === synFolded) return fieldKey;
    }
  }
  let bestField: string | null = null;
  let bestLen = 0;
  for (const [fieldKey, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const syn of synonyms) {
      const synFolded = foldVnAscii(syn);
      if ((norm.includes(syn) || (synFolded && folded.includes(synFolded))) && synFolded.length > bestLen) {
        if (synFolded === 'so' && ['doanh so', 'mau so', 'ma so'].some((x) => folded.includes(x))) {
          continue;
        }
        bestField = fieldKey;
        bestLen = synFolded.length;
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
