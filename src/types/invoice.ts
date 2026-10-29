export type ExtractionMethod = 'PDF_TEXT' | 'PADDLE_OCR' | 'HYBRID' | 'USER_EDITED';

export type VerificationStatus = 'VERIFIED' | 'NEEDS_REVIEW' | 'DUPLICATE_WARNING' | 'ERROR';

export type IssueSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface OcrTextLine {
  text: string;
  confidence: number;
  page: number;
  bbox?: number[][];
  source: ExtractionMethod;
}

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  field: string;
  message: string;
}

export interface ExtractedInvoice {
  id: string;
  source_filename: string;
  file_size_bytes: number;
  file_sha256: string;
  page_count: number;
  extraction_method: ExtractionMethod;

  seller_name: string;
  seller_tax_id: string;
  seller_address: string;

  invoice_symbol: string;
  invoice_number: string;
  invoice_date: string;

  buyer_name: string;
  buyer_tax_id: string;

  subtotal_amount: number | null;
  vat_rate: string;
  vat_amount: number | null;
  discount_amount: number | null;
  total_amount: number | null;
  currency: string;

  items_summary: string;
  notes: string;

  verification_status: VerificationStatus;
  uncertain_fields: string[];
  field_sources: Record<string, ExtractionMethod>;
  field_confidences: Record<string, number>;
  field_pages: Record<string, number>;
  validation_issues: ValidationIssue[];
}

export interface FileJobStatus {
  file_id: string;
  filename: string;
  size_bytes: number;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress_pct: number;
  error_message: string;
  extraction_method: string;
  page_count: number;
}

export interface BatchTaskResponse {
  task_id: string;
  created_at: number;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  total_files: number;
  completed_files: number;
  failed_files: number;
  cancel_requested: boolean;
  overall_progress_pct: number;
  files: FileJobStatus[];
  invoices: ExtractedInvoice[];
}

export interface ExcelColumnInfo {
  col_index: number;
  col_letter: string;
  header_text: string;
  mapped_field: string | null;
  has_formula: boolean;
  formula_template: string | null;
}

export interface ExcelSheetAnalysis {
  sheet_name: string;
  header_row: number;
  start_data_row: number;
  max_row: number;
  max_column: number;
  columns: ExcelColumnInfo[];
  formula_columns: string[];
}

export interface ExcelTemplateAnalysis {
  template_id: string;
  template_filename: string;
  sheet_names: string[];
  active_sheet: string;
  sheets: ExcelSheetAnalysis[];
}

export interface ServerConnectionConfig {
  mode: 'BUILTIN_GATEWAY' | 'REMOTE_FASTAPI';
  remoteUrl: string;
  apiToken: string;
}
