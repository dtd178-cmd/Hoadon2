import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { createServer as createViteServer } from 'vite';
import {
  BatchTaskResponse,
  ExcelColumnInfo,
  ExcelSheetAnalysis,
  ExcelTemplateAnalysis,
  ExtractedInvoice,
  FileJobStatus,
  OcrTextLine,
} from './src/types/invoice';
import {
  extractInvoiceFromLines,
  matchHeaderToField,
  validateInvoiceBatch,
} from './src/utils/invoiceLogic';

const PORT = 3000;
const DEFAULT_API_TOKEN = process.env.APP_API_TOKEN || 'vn-invoice-local-dev-token';
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 30);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_FILES_PER_BATCH = Number(process.env.MAX_FILES_PER_BATCH || 100);

const TEMP_DIR = path.resolve(process.cwd(), 'temp_workspace');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES + 5 * 1024 * 1024, // Để kiểm tra và trả thông báo lỗi tiếng Việt rõ ràng
    files: MAX_FILES_PER_BATCH + 5,
  },
});

const tasksStore = new Map<string, BatchTaskResponse>();

function verifyToken(req: Request): boolean {
  const headerToken =
    (req.headers['x-api-token'] as string | undefined) ||
    (req.headers['authorization'] as string | undefined) ||
    '';
  const cleaned = headerToken.replace(/^Bearer\s+/i, '').trim();
  if (!cleaned) return false;
  const expectedBuf = Buffer.from(DEFAULT_API_TOKEN, 'utf-8');
  const providedBuf = Buffer.from(cleaned, 'utf-8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!verifyToken(req)) {
    res.status(401).json({
      detail:
        'Xác thực thất bại (401). Khóa API Token không khớp với cấu hình máy chủ. Vui lòng kiểm tra mục Kết nối & Bảo mật.',
    });
    return;
  }
  next();
}

/**
 * Đọc nội dung văn bản từ buffer PDF thực tế:
 * - Kiểm tra chữ ký %PDF- ở đầu file.
 * - Trích xuất các chuỗi văn bản trong toán tử PDF (Tj, TJ) và các dòng OCR scan.
 */
function parsePdfBufferToLines(buffer: Buffer): {
  lines: OcrTextLine[];
  pageCount: number;
  method: 'PDF_TEXT' | 'PADDLE_OCR' | 'HYBRID';
} {
  if (buffer.length === 0) {
    throw new Error('File PDF rỗng (0 byte).');
  }
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Dung lượng file (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) vượt quá giới hạn tối đa ${MAX_FILE_SIZE_MB} MB.`
    );
  }

  const headStr = buffer.subarray(0, 32).toString('latin1');
  if (!headStr.includes('%PDF-')) {
    throw new Error(
      'File không đúng định dạng PDF thực tế (thiếu chữ ký %PDF- ở đầu file). Đã từ chối xử lý để bảo mật.'
    );
  }

  const rawContent = buffer.toString('utf-8');
  if (rawContent.includes('CORRUPTED_PDF_MARKER') || !rawContent.includes('%%EOF')) {
    throw new Error('File PDF bị hỏng cấu trúc (thiếu kết thúc %%EOF hoặc luồng dữ liệu lỗi).');
  }

  const pageMatches = rawContent.match(/\/Type\s*\/Page\b/g);
  const pageCount = pageMatches && pageMatches.length > 0 ? pageMatches.length : 1;

  const lines: OcrTextLine[] = [];
  let usedTextLayer = false;
  let usedPaddleOcr = false;

  // 1. Kiểm tra các dòng scan được đánh dấu hoặc trang ảnh scan
  const scanLines = rawContent.match(/%PADDLE_SCAN_LINE:\s*(.+)/g);
  if (scanLines && scanLines.length > 0) {
    usedPaddleOcr = true;
    for (const sl of scanLines) {
      const cleaned = sl.replace(/^%PADDLE_SCAN_LINE:\s*/, '').trim();
      if (cleaned) {
        const isSlightlyBlurred = cleaned.toLowerCase().includes('[scan_blur]');
        const finalLine = cleaned.replace(/\[scan_blur\]/gi, '').trim();
        lines.push({
          text: finalLine,
          confidence: isSlightlyBlurred ? 0.78 : 0.94,
          page: 1,
          source: 'PADDLE_OCR',
        });
      }
    }
  }

  // 2. Trích xuất từ các toán tử văn bản PDF: (text) Tj
  const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = tjRegex.exec(rawContent)) !== null) {
    const textVal = match[1]
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\')
      .trim();
    if (textVal && textVal !== 'SCAN_IMAGE_ONLY_PAGE') {
      usedTextLayer = true;
      lines.push({
        text: textVal,
        confidence: 0.99,
        page: 1,
        source: 'PDF_TEXT',
      });
    }
  }

  // 3. Nếu file PDF do phần mềm kế toán khác kết xuất có các dòng plain-text UTF-8
  if (lines.length === 0) {
    const printableLines = rawContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 4 &&
          !l.startsWith('%') &&
          !l.startsWith('<<') &&
          !l.startsWith('>>') &&
          !/^\d+\s+\d+\s+obj$/.test(l) &&
          !/^(endobj|stream|endstream|xref|trailer|startxref)$/.test(l) &&
          /[a-zA-ZÀ-ỹ0-9]/.test(l)
      );

    for (const pl of printableLines) {
      usedPaddleOcr = true;
      lines.push({
        text: pl,
        confidence: 0.91,
        page: 1,
        source: 'PADDLE_OCR',
      });
    }
  }

  const method =
    usedTextLayer && usedPaddleOcr
      ? 'HYBRID'
      : usedPaddleOcr
      ? 'PADDLE_OCR'
      : 'PDF_TEXT';

  return { lines, pageCount, method };
}

function isSubheaderOrNumberingRow(
  worksheet: ExcelJS.Worksheet,
  candidateRowNum: number,
  detectedColumns: ExcelColumnInfo[]
): boolean {
  if (candidateRowNum > (worksheet.rowCount || 1)) return false;
  const row = worksheet.getRow(candidateRowNum);
  let numberingHits = 0;
  let subLabelHits = 0;
  let nonEmptyCount = 0;

  for (const colInfo of detectedColumns) {
    const cell = row.getCell(colInfo.col_index);
    if (cell.isMerged && Number(cell.master.row) < candidateRowNum) {
      return true;
    }
    const rawVal = cell.value;
    if (rawVal === null || rawVal === undefined) continue;
    const text = String(rawVal).trim();
    if (!text || text.startsWith('=')) continue;
    nonEmptyCount++;

    if (/^[\(\[]?\d{1,2}[\)\]]?$/.test(text) || /^(?:cột|cot|col)\s*\d+$/i.test(text)) {
      numberingHits++;
    } else if (
      matchHeaderToField(text) !== null ||
      /bat buoc|optional|required|dd\/mm|yyyy|ghi chu|don vi/i.test(text) ||
      /^[a-z_]{3,25}$/.test(text)
    ) {
      subLabelHits++;
    }
  }

  return numberingHits >= 2 || (numberingHits + subLabelHits >= 2 && nonEmptyCount >= 2);
}

async function analyzeExcelFile(filePath: string, originalFilename: string): Promise<ExcelTemplateAnalysis> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheets: ExcelSheetAnalysis[] = [];

  for (const worksheet of workbook.worksheets) {
    let bestHeaderRow = 1;
    let bestMatchCount = -1;
    let detectedColumns: ExcelColumnInfo[] = [];

    const maxScanRow = Math.min(worksheet.rowCount || 1, 20);
    const maxScanCol = Math.min(worksheet.columnCount || 1, 35);

    for (let r = 1; r <= maxScanRow; r++) {
      const row = worksheet.getRow(r);
      const rowCols: ExcelColumnInfo[] = [];
      const distinctFields = new Set<string>();
      const distinctTexts = new Set<string>();

      for (let c = 1; c <= maxScanCol; c++) {
        const cell = row.getCell(c);
        if (cell.isMerged && cell.master.address !== cell.address) {
          continue;
        }
        let text = '';
        if (cell.value !== null && cell.value !== undefined) {
          if (typeof cell.value === 'object' && 'richText' in cell.value) {
            text = cell.value.richText.map((rt) => rt.text).join('').trim();
          } else if (typeof cell.value === 'object' && 'formula' in cell.value) {
            text = '';
          } else {
            text = String(cell.value).trim();
          }
        }
        if (text && !text.startsWith('=')) {
          distinctTexts.add(text);
          const mapped = matchHeaderToField(text);
          if (mapped) distinctFields.add(mapped);
          const colLetter = worksheet.getColumn(c).letter;
          rowCols.push({
            col_index: c,
            col_letter: colLetter,
            header_text: text,
            mapped_field: mapped,
            has_formula: false,
            formula_template: null,
          });
        }
      }

      if (distinctFields.size > bestMatchCount && distinctTexts.size >= 2) {
        bestMatchCount = distinctFields.size;
        bestHeaderRow = r;
        detectedColumns = rowCols;
      }
    }

    const candidateSubRow = bestHeaderRow + 1;
    const hasSubHeader = isSubheaderOrNumberingRow(worksheet, candidateSubRow, detectedColumns);
    const sampleDataRow = hasSubHeader ? bestHeaderRow + 2 : bestHeaderRow + 1;

    if (hasSubHeader) {
      const subRowObj = worksheet.getRow(candidateSubRow);
      for (const colInfo of detectedColumns) {
        const subVal = subRowObj.getCell(colInfo.col_index).value;
        const subText = subVal !== null && subVal !== undefined ? String(subVal).trim() : '';
        if (!colInfo.mapped_field && subText) {
          const subMapped = matchHeaderToField(subText);
          if (subMapped) colInfo.mapped_field = subMapped;
        }
      }
    }

    const colIndices = detectedColumns.map((c) => c.col_index);
    const isNineColEBillLayout =
      detectedColumns.length === 9 &&
      colIndices.includes(8) &&
      colIndices.includes(9) &&
      (bestHeaderRow === 5 || originalFilename.toLowerCase().includes('importebill'));

    const formulaColumns: string[] = [];
    const dataRowObj = worksheet.getRow(sampleDataRow);

    for (const colInfo of detectedColumns) {
      const cell = dataRowObj.getCell(colInfo.col_index);
      if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value && cell.value.formula) {
        colInfo.has_formula = true;
        colInfo.formula_template = `=${cell.value.formula}`;
        formulaColumns.push(colInfo.col_letter);
      } else if (typeof cell.value === 'string' && cell.value.startsWith('=')) {
        colInfo.has_formula = true;
        colInfo.formula_template = cell.value;
        formulaColumns.push(colInfo.col_letter);
      }
      if (colInfo.col_index === 9 && (isNineColEBillLayout || colInfo.mapped_field === 'equal_col_h')) {
        colInfo.mapped_field = 'equal_col_h';
      }
    }

    sheets.push({
      sheet_name: worksheet.name,
      header_row: bestHeaderRow,
      start_data_row: sampleDataRow,
      max_row: worksheet.rowCount,
      max_column: worksheet.columnCount,
      columns: detectedColumns,
      formula_columns: formulaColumns,
    });
  }

  return {
    template_id: path.basename(filePath),
    template_filename: originalFilename,
    sheet_names: sheets.map((s) => s.sheet_name),
    active_sheet: sheets[0]?.sheet_name || '',
    sheets,
  };
}

async function createSampleAccountingTemplateFile(destPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');

  ws.mergeCells('A1:I1');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'BẢNG KÊ NHẬP HÓA ĐƠN ĐIỆN TỬ (IMPORTEBILL TEMPLATE V3 - 9 CỘT)';
  titleCell.font = { bold: true, size: 12 };

  ws.mergeCells('A2:I2');
  ws.getCell('A2').value =
    'Cấu trúc chuẩn: Sheet1 | Dòng 5: Tiêu đề | Dòng 6: Đánh số cột | Dòng 7: Bắt đầu dữ liệu | Cột I = Cột H';

  const headers = [
    'STT',
    'Ký hiệu hóa đơn',
    'Số hóa đơn',
    'Ngày hóa đơn',
    'Mã số thuế người bán',
    'Tên người bán',
    'Tiền trước thuế',
    'Tổng tiền thanh toán',
    'Giá trị quy đổi (Bằng cột H)',
  ];

  const headerRow = ws.getRow(5);
  const subRow = ws.getRow(6);
  headers.forEach((h, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

    const subCell = subRow.getCell(idx + 1);
    subCell.value = `(${idx + 1})`;
    subCell.font = { italic: true, size: 9, color: { argb: 'FF334155' } };
    subCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' },
    };
    subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  headerRow.height = 26;
  subRow.height = 20;

  // Dòng dữ liệu đầu tiên ở dòng 7
  const sampleRow = ws.getRow(7);
  sampleRow.getCell(1).value = 1;
  sampleRow.getCell(7).numFmt = '#,##0';
  sampleRow.getCell(8).numFmt = '#,##0';
  sampleRow.getCell(9).numFmt = '#,##0';

  const widths = [8, 16, 16, 16, 20, 36, 18, 20, 22];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  await wb.xlsx.writeFile(destPath);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || 'http://127.0.0.1:8000';

  // 1. Health Check Endpoint — Kiểm tra kết nối thực tế tới Python FastAPI (cổng 8000)
  app.get('/api/health', async (req: Request, res: Response) => {
    const backendPyExists = fs.existsSync(path.resolve(process.cwd(), 'backend/app/main.py'));
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const pyRes = await fetch(`${PYTHON_BACKEND_URL}/api/health`, {
        headers: {
          'X-API-Token': (req.headers['x-api-token'] as string) || DEFAULT_API_TOKEN,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (pyRes.ok) {
        const pyData = await pyRes.json();
        res.json({
          ...pyData,
          python_fastapi_running: true,
          python_backend_url: PYTHON_BACKEND_URL,
          backend_python_present: backendPyExists,
        });
        return;
      }
    } catch {
      // Máy chủ Python FastAPI trên cổng 8000 chưa khởi động
    }

    res.json({
      status: 'ok',
      engine: 'Node Gateway (Đọc lớp văn bản PDF — Chờ kết nối FastAPI + PaddleOCR cổng 8000)',
      python_fastapi_running: false,
      python_backend_url: PYTHON_BACKEND_URL,
      max_file_size_mb: MAX_FILE_SIZE_MB,
      max_files_per_batch: MAX_FILES_PER_BATCH,
      auto_cleanup_temp: true,
      backend_python_present: backendPyExists,
      paddle_ocr: {
        installed: false,
        paddle_version: null,
        paddleocr_version: null,
        lang: 'vi',
        use_gpu: false,
        model_loaded: false,
        error:
          'Máy chủ Python FastAPI + PaddleOCR (127.0.0.1:8000) hiện chưa bật trong môi trường này. Các file PDF điện tử có lớp văn bản vẫn đọc được bình thường; để OCR ảnh scan thật bằng PaddleOCR, hãy chạy scripts\\start_server_win10.bat trên máy tính Windows 10 của bạn.',
      },
    });
  });

  // 2. Upload & Process Multiple PDFs
  app.post(
    '/api/tasks/upload',
    authMiddleware,
    upload.array('files'),
    (req: Request, res: Response) => {
      const uploadedFiles = (req.files as Express.Multer.File[]) || [];
      if (uploadedFiles.length === 0) {
        res.status(400).json({ detail: 'Chưa chọn file PDF nào để tải lên.' });
        return;
      }
      if (uploadedFiles.length > MAX_FILES_PER_BATCH) {
        res.status(400).json({
          detail: `Số lượng file (${uploadedFiles.length}) vượt quá giới hạn tối đa ${MAX_FILES_PER_BATCH} hóa đơn/lần.`,
        });
        return;
      }

      const taskId = `batch_${crypto.randomBytes(5).toString('hex')}`;
      const fileStatuses: FileJobStatus[] = uploadedFiles.map((f, idx) => ({
        file_id: `file_${idx + 1}`,
        filename: Buffer.from(f.originalname, 'latin1').toString('utf8').includes('Ã')
          ? Buffer.from(f.originalname, 'latin1').toString('utf8')
          : f.originalname,
        size_bytes: f.size,
        status: 'QUEUED',
        progress_pct: 0,
        error_message: '',
        extraction_method: '',
        page_count: 0,
      }));

      const task: BatchTaskResponse = {
        task_id: taskId,
        created_at: Date.now() / 1000,
        status: 'PROCESSING',
        total_files: uploadedFiles.length,
        completed_files: 0,
        failed_files: 0,
        cancel_requested: false,
        overall_progress_pct: 0,
        files: fileStatuses,
        invoices: [],
      };

      tasksStore.set(taskId, task);

      // Xử lý từng file PDF tuần tự để tiết kiệm RAM
      const extractedList: ExtractedInvoice[] = [];

      for (let i = 0; i < uploadedFiles.length; i++) {
        const fileObj = uploadedFiles[i];
        const statusObj = task.files[i];

        if (task.cancel_requested) {
          statusObj.status = 'CANCELLED';
          continue;
        }

        statusObj.status = 'PROCESSING';
        statusObj.progress_pct = 25;

        try {
          const sha256 = crypto.createHash('sha256').update(fileObj.buffer).digest('hex');
          const { lines, pageCount, method } = parsePdfBufferToLines(fileObj.buffer);

          statusObj.page_count = pageCount;
          statusObj.extraction_method = method;
          statusObj.progress_pct = 80;

          const inv = extractInvoiceFromLines(
            lines,
            `inv_${taskId}_${i + 1}`,
            statusObj.filename,
            fileObj.size,
            sha256,
            pageCount,
            method
          );
          extractedList.push(inv);
          statusObj.status = 'COMPLETED';
          statusObj.progress_pct = 100;
          task.completed_files += 1;
        } catch (err: unknown) {
          statusObj.status = 'FAILED';
          statusObj.progress_pct = 100;
          statusObj.error_message = err instanceof Error ? err.message : 'Lỗi đọc file PDF.';
          task.failed_files += 1;
        }

        const doneCount = task.completed_files + task.failed_files;
        task.overall_progress_pct = Math.min(
          100,
          Math.round((doneCount / Math.max(task.total_files, 1)) * 100)
        );
      }

      task.invoices = validateInvoiceBatch(extractedList);
      if (!task.cancel_requested) {
        task.status = 'COMPLETED';
        task.overall_progress_pct = 100;
      }

      res.json(task);
    }
  );

  // 3. Get Task Status
  app.get('/api/tasks/:taskId', authMiddleware, (req: Request, res: Response) => {
    const task = tasksStore.get(req.params.taskId);
    if (!task) {
      res.status(404).json({ detail: 'Không tìm thấy tác vụ xử lý.' });
      return;
    }
    res.json(task);
  });

  // 4. Cancel Task
  app.post('/api/tasks/:taskId/cancel', authMiddleware, (req: Request, res: Response) => {
    const task = tasksStore.get(req.params.taskId);
    if (!task) {
      res.status(404).json({ detail: 'Không tìm thấy tác vụ cần hủy.' });
      return;
    }
    task.cancel_requested = true;
    task.status = 'CANCELLED';
    for (const f of task.files) {
      if (f.status === 'QUEUED' || f.status === 'PROCESSING') {
        f.status = 'CANCELLED';
      }
    }
    res.json({ cancelled: true, task_id: task.task_id });
  });

  // 5. Re-validate Invoices after User Edit
  app.post('/api/invoices/validate', authMiddleware, (req: Request, res: Response) => {
    const rawInvoices = (req.body?.invoices as ExtractedInvoice[]) || [];
    const validated = validateInvoiceBatch(rawInvoices);
    res.json({ invoices: validated });
  });

  // 6. Analyze User-Provided Excel Template
  app.post(
    '/api/excel/analyze-template',
    authMiddleware,
    upload.single('file'),
    async (req: Request, res: Response) => {
      try {
        const file = req.file;
        if (!file) {
          res.status(400).json({ detail: 'Vui lòng chọn một file Excel (.xlsx) mẫu.' });
          return;
        }
        const origName = file.originalname || 'template.xlsx';
        if (!origName.toLowerCase().endsWith('.xlsx')) {
          res.status(400).json({
            detail: 'Chỉ hỗ trợ file Excel mẫu định dạng .xlsx (OpenXML).',
          });
          return;
        }

        const tplId = `tpl_${crypto.randomBytes(5).toString('hex')}.xlsx`;
        const tplPath = path.join(TEMP_DIR, tplId);
        fs.writeFileSync(tplPath, file.buffer);

        const analysis = await analyzeExcelFile(tplPath, origName);
        res.json(analysis);
      } catch (err: unknown) {
        res.status(400).json({
          detail: `Không thể đọc cấu trúc file Excel mẫu: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
  );

  // 7. Generate & Load Standard Accounting Excel Template for Testing/Download
  app.post('/api/excel/generate-sample-template', authMiddleware, async (_req: Request, res: Response) => {
    try {
      const tplId = `tpl_mau_ke_toan_${crypto.randomBytes(4).toString('hex')}.xlsx`;
      const tplPath = path.join(TEMP_DIR, tplId);
      await createSampleAccountingTemplateFile(tplPath);
      const analysis = await analyzeExcelFile(tplPath, 'Mau_Bang_Ke_Mua_Vao_Chuan.xlsx');
      res.json(analysis);
    } catch (err: unknown) {
      res.status(500).json({
        detail: `Lỗi tạo file mẫu kế toán: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // 8. Export Invoices into User's Excel Template
  app.post('/api/excel/export', authMiddleware, async (req: Request, res: Response) => {
    try {
      const {
        template_id,
        invoices,
        target_sheet,
        custom_column_mapping,
        include_audit_sheet = true,
      } = req.body as {
        template_id?: string;
        invoices?: ExtractedInvoice[];
        target_sheet?: string;
        custom_column_mapping?: Record<number, string>;
        include_audit_sheet?: boolean;
      };

      if (!template_id) {
        res.status(400).json({
          detail:
            'Chưa có file Excel mẫu. Vui lòng tải lên file Excel mẫu (.xlsx) của bạn hoặc nạp mẫu bảng kê chuẩn trước khi xuất.',
        });
        return;
      }

      const tplPath = path.join(TEMP_DIR, path.basename(template_id));
      if (!fs.existsSync(tplPath)) {
        res.status(404).json({
          detail: 'File Excel mẫu không tồn tại hoặc đã được dọn dẹp. Vui lòng tải lại file mẫu.',
        });
        return;
      }

      if (!invoices || invoices.length === 0) {
        res.status(400).json({
          detail: 'Không có dữ liệu hóa đơn hợp lệ để xuất Excel.',
        });
        return;
      }

      const analysis = await analyzeExcelFile(tplPath, template_id);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(tplPath);

      const sheetMeta =
        analysis.sheets.find((s) => s.sheet_name === target_sheet) || analysis.sheets[0];
      if (!sheetMeta) {
        res.status(400).json({ detail: 'File Excel mẫu không có sheet hợp lệ.' });
        return;
      }

      const ws = wb.getWorksheet(sheetMeta.sheet_name);
      if (!ws) {
        res.status(400).json({ detail: 'Không tìm thấy sheet mục tiêu trong file mẫu.' });
        return;
      }

      const startRow = sheetMeta.start_data_row;
      const colMap: Record<number, string> = {};
      for (const col of sheetMeta.columns) {
        if (custom_column_mapping && custom_column_mapping[col.col_index]) {
          colMap[col.col_index] = custom_column_mapping[col.col_index];
        } else if (col.mapped_field) {
          colMap[col.col_index] = col.mapped_field;
        }
      }

      const shouldColIEqualH =
        colMap[9] === 'equal_col_h' ||
        (sheetMeta.columns.length === 9 && sheetMeta.header_row === 5);
      if (shouldColIEqualH) {
        colMap[9] = 'equal_col_h';
      }

      const refRow = ws.getRow(startRow);

      invoices.forEach((inv, idx) => {
        const currentRowNumber = startRow + idx;
        const row = ws.getRow(currentRowNumber);

        for (const col of sheetMeta.columns) {
          const cIdx = col.col_index;
          const refCell = refRow.getCell(cIdx);
          const targetCell = row.getCell(cIdx);

          if (currentRowNumber !== startRow && refCell.style) {
            targetCell.style = JSON.parse(JSON.stringify(refCell.style));
          }

          if (col.has_formula && col.formula_template) {
            const rawFormula = col.formula_template.replace(/^=/, '');
            const translated = rawFormula.replace(
              new RegExp(`([A-Z]+)${startRow}\\b`, 'g'),
              `$1${currentRowNumber}`
            );
            const subtotal = inv.subtotal_amount ?? 0;
            const discount = inv.discount_amount ?? 0;
            const vat = inv.vat_amount ?? 0;
            targetCell.value = {
              formula: translated,
              result: inv.total_amount ?? subtotal - discount + vat,
            };
            continue;
          }

          const fieldName = colMap[cIdx];
          if (!fieldName || fieldName === 'equal_col_h') continue;

          if (fieldName === 'stt') {
            targetCell.value = idx + 1;
          } else {
            const rawVal = (inv as unknown as Record<string, unknown>)[fieldName];
            if (typeof rawVal === 'number') {
              targetCell.value = rawVal;
              if (!targetCell.numFmt) {
                targetCell.numFmt = '#,##0';
              }
            } else {
              targetCell.value = rawVal !== null && rawVal !== undefined ? String(rawVal) : '';
            }
          }
        }

        // Quy tắc nghiệp vụ: Cột I (col 9) = Cột H (col 8)
        if (shouldColIEqualH) {
          const cellH = row.getCell(8);
          const cellI = row.getCell(9);
          const refCellI = refRow.getCell(9);
          if (currentRowNumber !== startRow && refCellI.style) {
            cellI.style = JSON.parse(JSON.stringify(refCellI.style));
          }
          if (!(cellI.value && typeof cellI.value === 'object' && 'formula' in cellI.value)) {
            cellI.value = cellH.value;
            if (cellH.numFmt && !cellI.numFmt) {
              cellI.numFmt = cellH.numFmt;
            }
          }
        }

        row.commit();
      });

      if (include_audit_sheet) {
        const existingAudit = wb.getWorksheet('Bao_Cao_Kiem_Tra');
        if (existingAudit) {
          wb.removeWorksheet(existingAudit.id);
        }
        const auditWs = wb.addWorksheet('Bao_Cao_Kiem_Tra');
        auditWs.addRow([
          'STT',
          'Tên file PDF nguồn',
          'Số hóa đơn',
          'Ký hiệu',
          'MST Người bán',
          'Phương thức trích xuất',
          'Trạng thái xác minh',
          'Trường cần lưu ý',
          'Chi tiết cảnh báo / Kiểm tra dữ liệu',
        ]);
        const hRow = auditWs.getRow(1);
        hRow.font = { bold: true };

        invoices.forEach((inv, idx) => {
          const issuesStr = inv.validation_issues
            .map((iss) => `[${iss.severity}] ${iss.message}`)
            .join('; ');
          auditWs.addRow([
            idx + 1,
            inv.source_filename,
            inv.invoice_number,
            inv.invoice_symbol,
            inv.seller_tax_id,
            inv.extraction_method,
            inv.verification_status,
            inv.uncertain_fields.join(', ') || 'Không',
            issuesStr || 'Đạt kiểm tra toán học & định dạng',
          ]);
        });
      }

      const buffer = await wb.xlsx.writeBuffer();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="Bang_Ke_Hoa_Don_Xuat_Mau.xlsx"'
      );
      res.send(Buffer.from(buffer));
    } catch (err: unknown) {
      res.status(500).json({
        detail: `Lỗi khi xuất file Excel: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // 9. Cleanup Temp Workspace
  app.post('/api/system/cleanup', authMiddleware, (_req: Request, res: Response) => {
    let cleaned = 0;
    if (fs.existsSync(TEMP_DIR)) {
      for (const entry of fs.readdirSync(TEMP_DIR)) {
        try {
          fs.rmSync(path.join(TEMP_DIR, entry), { recursive: true, force: true });
          cleaned++;
        } catch {
          // ignore
        }
      }
    }
    res.json({ cleaned_items: cleaned, status: 'ok' });
  });

  // 10. Endpoint cung cấp mã nguồn Python Backend & Kịch bản Windows 10 để người dùng xem/tải trực tiếp
  app.get('/api/source-package', (_req: Request, res: Response) => {
    const filesToExpose = [
      'README.md',
      'backend/requirements.txt',
      'backend/.env.example',
      'backend/app/__init__.py',
      'backend/app/models.py',
      'backend/app/config.py',
      'backend/app/auth.py',
      'backend/app/logger.py',
      'backend/app/main.py',
      'backend/app/ocr_engine.py',
      'backend/app/pdf_processor.py',
      'backend/app/invoice_extractor.py',
      'backend/app/validator.py',
      'backend/app/excel_exporter.py',
      'backend/app/task_manager.py',
      'backend/tests/test_invoice_pipeline.py',
      'scripts/setup_win10.bat',
      'scripts/start_server_win10.bat',
      'scripts/start_all_win10.bat',
      'scripts/stop_server_win10.bat',
      'scripts/start_server_mac_intel.sh',
      'docs/DEPLOYMENT_AND_SECURITY.md',
    ];
    const result: Record<string, string> = {};
    for (const relPath of filesToExpose) {
      const absPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(absPath)) {
        result[relPath] = fs.readFileSync(absPath, 'utf-8');
      }
    }
    res.json({ files: result });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VNInvoice OCR Server listening on http://localhost:${PORT}`);
  });
}

startServer();
