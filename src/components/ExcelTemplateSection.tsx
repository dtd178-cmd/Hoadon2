import React, { useState } from 'react';
import {
  FileSpreadsheet,
  Upload,
  Download,
  CheckCircle2,
  AlertCircle,
  FileDown,
  RotateCcw,
} from 'lucide-react';
import { ExcelTemplateAnalysis, ExtractedInvoice } from '../types/invoice';

interface ExcelTemplateSectionProps {
  invoices: ExtractedInvoice[];
  templateAnalysis: ExcelTemplateAnalysis | null;
  onUploadTemplate: (file: File) => Promise<void>;
  onGenerateSampleTemplate: () => Promise<void>;
  onExportExcel: (
    targetSheet: string,
    customMapping: Record<number, string>,
    includeAuditSheet: boolean
  ) => Promise<void>;
  onStartNewBatch?: () => void;
  isAnalyzing: boolean;
  isExporting: boolean;
}

const AVAILABLE_FIELDS: { value: string; label: string }[] = [
  { value: '', label: '-- Bỏ qua / Giữ nguyên cột mẫu --' },
  { value: 'stt', label: 'STT (Số thứ tự tự động)' },
  { value: 'invoice_symbol', label: 'Ký hiệu hóa đơn' },
  { value: 'invoice_number', label: 'Số hóa đơn' },
  { value: 'invoice_date', label: 'Ngày lập hóa đơn' },
  { value: 'seller_name', label: 'Tên người bán' },
  { value: 'seller_tax_id', label: 'Mã số thuế người bán' },
  { value: 'seller_address', label: 'Địa chỉ người bán' },
  { value: 'buyer_name', label: 'Tên người mua' },
  { value: 'buyer_tax_id', label: 'Mã số thuế người mua' },
  { value: 'items_summary', label: 'Mặt hàng / Nội dung hàng hóa' },
  { value: 'subtotal_amount', label: 'Tiền hàng trước thuế' },
  { value: 'vat_rate', label: 'Thuế suất GTGT' },
  { value: 'vat_amount', label: 'Tiền thuế GTGT' },
  { value: 'discount_amount', label: 'Chiết khấu / Điều chỉnh' },
  { value: 'total_amount', label: 'Tổng tiền thanh toán' },
  { value: 'currency', label: 'Loại tiền tệ' },
  { value: 'notes', label: 'Ghi chú' },
  { value: 'source_filename', label: 'Tên file PDF nguồn' },
  { value: 'verification_status', label: 'Trạng thái xác minh' },
];

export const ExcelTemplateSection: React.FC<ExcelTemplateSectionProps> = ({
  invoices,
  templateAnalysis,
  onUploadTemplate,
  onGenerateSampleTemplate,
  onExportExcel,
  onStartNewBatch,
  isAnalyzing,
  isExporting,
}) => {
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [customMapping, setCustomMapping] = useState<Record<number, string>>({});
  const [includeAuditSheet, setIncludeAuditSheet] = useState<boolean>(true);

  const activeSheetName = selectedSheet || templateAnalysis?.active_sheet || '';
  const currentSheetMeta =
    templateAnalysis?.sheets.find((s) => s.sheet_name === activeSheetName) ||
    templateAnalysis?.sheets[0];

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCustomMapping({});
    await onUploadTemplate(file);
    e.target.value = '';
  };

  const handleDownloadErrorReportCsv = () => {
    const headers = [
      'STT',
      'File Nguon',
      'So Hoa Don',
      'Ky Hieu',
      'MST Nguoi Ban',
      'Trang Thai',
      'Canh Bao / Loi Kiem Tra',
    ];
    const rows = invoices.map((inv, idx) => {
      const issues = inv.validation_issues
        .map((i) => `[${i.severity}] ${i.message}`)
        .join(' | ');
      return [
        idx + 1,
        `"${inv.source_filename.replace(/"/g, '""')}"`,
        `"${inv.invoice_number}"`,
        `"${inv.invoice_symbol}"`,
        `"${inv.seller_tax_id}"`,
        inv.verification_status,
        `"${(issues || 'Hợp lệ').replace(/"/g, '""')}"`,
      ].join(',');
    });
    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Bao_Cao_Kiem_Tra_Hoa_Don.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Phần tải lên hoặc tạo file mẫu */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-6 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Cấu hình File Excel Mẫu (.xlsx) & Ánh xạ Cột
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Hệ thống đọc trực tiếp cấu trúc các sheet, dòng tiêu đề, định dạng ô và bảo toàn công thức có sẵn trong file mẫu của bạn.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <label
              htmlFor="excel-template-input"
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-4 h-4 text-slate-600" />
              <span>{ isAnalyzing ? 'Đang phân tích mẫu...' : 'Tải lên File Excel Mẫu (.xlsx)' }</span>
              <input
                id="excel-template-input"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFileChange}
                className="sr-only"
              />
            </label>

            <button
              type="button"
              onClick={onGenerateSampleTemplate}
              disabled={isAnalyzing}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Nạp Mẫu Bảng Kê Kế Toán Chuẩn (.xlsx)</span>
            </button>
          </div>
        </div>

        {/* Trạng thái chưa có file mẫu */}
        {!templateAnalysis ? (
          <div className="py-10 text-center space-y-3">
            <AlertCircle className="w-8 h-8 text-amber-600 mx-auto" />
            <div className="text-sm font-medium text-slate-900">
              Chưa có file Excel mẫu được cung cấp
            </div>
            <p className="text-xs text-slate-600 max-w-xl mx-auto leading-relaxed">
              Theo quy tắc bảo toàn cấu trúc, ứng dụng không tự ý giả định cấu trúc bảng kê khi chưa có file mẫu. Vui lòng tải lên file Excel mẫu (`.xlsx`) của đơn vị bạn hoặc nhấn nút <strong>"Nạp Mẫu Bảng Kê Kế Toán Chuẩn (.xlsx)"</strong> ở trên để kiểm tra ngay.
            </p>
          </div>
        ) : (
          <div className="pt-6 space-y-6">
            {/* Thông tin tổng quan về mẫu đã phân tích */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-50 p-4 rounded-lg border border-slate-200">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Đã phân tích mẫu: {templateAnalysis.template_filename}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span>Số sheet: {templateAnalysis.sheet_names.length}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Dòng tiêu đề phát hiện: Dòng {currentSheetMeta?.header_row ?? 1}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Dòng bắt đầu ghi dữ liệu: Dòng {currentSheetMeta?.start_data_row ?? 2}
                  </span>
                  {currentSheetMeta && currentSheetMeta.formula_columns.length > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-blue-700 font-medium">
                        Cột bảo toàn công thức: {currentSheetMeta.formula_columns.join(', ')}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label htmlFor="select-target-sheet" className="text-xs font-medium text-slate-700">
                  Sheet ghi dữ liệu:
                </label>
                <select
                  id="select-target-sheet"
                  value={activeSheetName}
                  onChange={(e) => setSelectedSheet(e.target.value)}
                  className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {templateAnalysis.sheet_names.map((sName) => (
                    <option key={sName} value={sName}>
                      {sName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Bảng ánh xạ cột chi tiết */}
            {currentSheetMeta && (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
                      <th className="py-2.5 px-4 w-20">Cột Excel</th>
                      <th className="py-2.5 px-4">Tên cột gốc trong File Mẫu</th>
                      <th className="py-2.5 px-4">Công thức / Định dạng bảo toàn</th>
                      <th className="py-2.5 px-4">Trường dữ liệu hóa đơn sẽ ghi vào</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs">
                    {currentSheetMeta.columns.map((col) => {
                      const effectiveField =
                        customMapping[col.col_index] !== undefined
                          ? customMapping[col.col_index]
                          : col.mapped_field || '';

                      return (
                        <tr key={col.col_index} className="hover:bg-slate-50/80">
                          <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                            Cột {col.col_letter}
                          </td>
                          <td className="py-2.5 px-4 font-medium text-slate-900">
                            {col.header_text}
                          </td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">
                            {col.has_formula ? (
                              <span className="text-blue-700 font-medium">
                                Giữ công thức ({col.formula_template})
                              </span>
                            ) : (
                              <span>Giữ nguyên font & định dạng ô</span>
                            )}
                          </td>
                          <td className="py-2.5 px-4">
                            {col.has_formula ? (
                              <span className="text-slate-500 italic">
                                Tự động dịch công thức theo từng dòng hóa đơn
                              </span>
                            ) : (
                              <select
                                aria-label={`Ánh xạ dữ liệu cho cột ${col.col_letter} (${col.header_text})`}
                                value={effectiveField}
                                onChange={(e) =>
                                  setCustomMapping((prev) => ({
                                    ...prev,
                                    [col.col_index]: e.target.value,
                                  }))
                                }
                                className="w-full max-w-xs px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
                              >
                                {AVAILABLE_FIELDS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Tùy chọn xuất và nút tải xuống */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-2">
              <label className="inline-flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeAuditSheet}
                  onChange={(e) => setIncludeAuditSheet(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                />
                <span>
                  Tạo thêm sheet <strong>Bao_Cao_Kiem_Tra</strong> (ghi lại nguồn OCR, cảnh báo sai số và trùng lặp)
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                {onStartNewBatch && (
                  <button
                    type="button"
                    onClick={onStartNewBatch}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-4 h-4 text-slate-600" />
                    <span>Nhập Bảng Khác</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleDownloadErrorReportCsv}
                  disabled={invoices.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <FileDown className="w-4 h-4" />
                  <span>Tải Báo cáo Kiểm tra (.CSV)</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onExportExcel(activeSheetName, customMapping, includeAuditSheet)
                  }
                  disabled={isExporting || invoices.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {isExporting
                      ? 'Đang kết xuất Excel...'
                      : `Tải xuống Bảng kê Excel (${invoices.length} hóa đơn)`}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
