import React, { useState, useEffect } from 'react';
import { X, Check, AlertTriangle, Calculator, FileText } from 'lucide-react';
import { ExtractedInvoice, ExtractionMethod } from '../types/invoice';

interface InvoiceEditDrawerProps {
  invoice: ExtractedInvoice | null;
  onClose: () => void;
  onSave: (updated: ExtractedInvoice, markVerified: boolean) => void;
}

const SOURCE_LABELS: Record<ExtractionMethod, string> = {
  PDF_TEXT: 'Lớp văn bản PDF',
  PADDLE_OCR: 'PaddleOCR',
  HYBRID: 'Kết hợp PDF + OCR',
  USER_EDITED: 'Người dùng đã sửa',
};

export const InvoiceEditDrawer: React.FC<InvoiceEditDrawerProps> = ({
  invoice,
  onClose,
  onSave,
}) => {
  const [draft, setDraft] = useState<ExtractedInvoice | null>(null);

  useEffect(() => {
    if (invoice) {
      setDraft({
        ...invoice,
        uncertain_fields: [...invoice.uncertain_fields],
        field_sources: { ...invoice.field_sources },
        field_confidences: { ...invoice.field_confidences },
        field_pages: { ...invoice.field_pages },
        validation_issues: [...invoice.validation_issues],
      });
    } else {
      setDraft(null);
    }
  }, [invoice]);

  if (!draft) return null;

  const updateTextField = (field: keyof ExtractedInvoice, value: string) => {
    setDraft((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        [field]: value,
        extraction_method: 'USER_EDITED',
        field_sources: {
          ...prev.field_sources,
          [field as string]: 'USER_EDITED',
        },
        uncertain_fields: prev.uncertain_fields.filter((f) => f !== field),
      };
    });
  };

  const updateNumberField = (field: keyof ExtractedInvoice, rawValue: string) => {
    const cleaned = rawValue.replace(/[^\d.-]/g, '');
    const numVal = cleaned === '' ? null : Number(cleaned);
    setDraft((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        [field]: Number.isFinite(numVal) ? numVal : null,
        extraction_method: 'USER_EDITED',
        field_sources: {
          ...prev.field_sources,
          [field as string]: 'USER_EDITED',
        },
        uncertain_fields: prev.uncertain_fields.filter((f) => f !== field),
      };
    });
  };

  const handleRecalculateTotal = () => {
    const sub = draft.subtotal_amount ?? 0;
    const disc = draft.discount_amount ?? 0;
    const vat = draft.vat_amount ?? 0;
    const computedTotal = sub - disc + vat;
    setDraft((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        total_amount: computedTotal,
        extraction_method: 'USER_EDITED',
        field_sources: {
          ...prev.field_sources,
          total_amount: 'USER_EDITED',
        },
        uncertain_fields: prev.uncertain_fields.filter((f) => f !== 'total_amount'),
      };
    });
  };

  const renderFieldMeta = (fieldKey: string) => {
    const src = draft.field_sources[fieldKey] || draft.extraction_method;
    const conf = draft.field_confidences[fieldKey];
    const page = draft.field_pages[fieldKey] || 1;
    const isUncertain = draft.uncertain_fields.includes(fieldKey);

    return (
      <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
        <span>Nguồn: {SOURCE_LABELS[src] || src}</span>
        <span aria-hidden="true">·</span>
        <span className="font-mono tabular-nums">Trang {page}</span>
        {conf !== undefined && src !== 'USER_EDITED' && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">Độ tin cậy: {Math.round(conf * 100)}%</span>
          </>
        )}
        {isUncertain && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-amber-700 font-medium">Cần xác minh</span>
          </>
        )}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-invoice-title"
    >
      <div className="w-full max-w-2xl bg-white h-full flex flex-col border-l border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="drawer-invoice-title"
              className="text-lg font-semibold text-slate-900 truncate"
            >
              Kiểm tra & Chỉnh sửa Hóa đơn #{draft.invoice_number || 'Chưa rõ số'}
            </h2>
            <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5 truncate">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{draft.source_filename}</span>
              <span aria-hidden="true">·</span>
              <span>{SOURCE_LABELS[draft.extraction_method]}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cửa sổ chỉnh sửa hóa đơn"
            className="p-2.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Danh sách cảnh báo của hóa đơn này */}
          {draft.validation_issues.length > 0 && (
            <div className="p-4 bg-amber-50/80 border border-amber-200 rounded-lg space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                <span>Cảnh báo kiểm tra dữ liệu ({draft.validation_issues.length})</span>
              </div>
              <ul className="space-y-1.5 text-xs text-amber-900">
                {draft.validation_issues.map((iss, idx) => (
                  <li key={idx} className="leading-relaxed">
                    <strong className="font-semibold">[{iss.severity}]</strong> {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Nhóm 1: Thông tin Định danh Hóa đơn */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 pb-2 border-b border-slate-200">
              01. Định danh Hóa đơn
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label
                  htmlFor="edit-invoice-symbol"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Ký hiệu hóa đơn
                </label>
                <input
                  id="edit-invoice-symbol"
                  type="text"
                  value={draft.invoice_symbol}
                  onChange={(e) => updateTextField('invoice_symbol', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('invoice_symbol')}
              </div>

              <div>
                <label
                  htmlFor="edit-invoice-number"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Số hóa đơn *
                </label>
                <input
                  id="edit-invoice-number"
                  type="text"
                  value={draft.invoice_number}
                  onChange={(e) => updateTextField('invoice_number', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('invoice_number')}
              </div>

              <div>
                <label
                  htmlFor="edit-invoice-date"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Ngày lập (YYYY-MM-DD) *
                </label>
                <input
                  id="edit-invoice-date"
                  type="text"
                  placeholder="2026-10-20"
                  value={draft.invoice_date}
                  onChange={(e) => updateTextField('invoice_date', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('invoice_date')}
              </div>
            </div>
          </div>

          {/* Nhóm 2: Thông tin Người bán (Seller) */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 pb-2 border-b border-slate-200">
              02. Thông tin Người bán (Đơn vị phát hành hóa đơn)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <label
                  htmlFor="edit-seller-name"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Tên người bán *
                </label>
                <input
                  id="edit-seller-name"
                  type="text"
                  value={draft.seller_name}
                  onChange={(e) => updateTextField('seller_name', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('seller_name')}
              </div>

              <div>
                <label
                  htmlFor="edit-seller-mst"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  MST người bán *
                </label>
                <input
                  id="edit-seller-mst"
                  type="text"
                  value={draft.seller_tax_id}
                  onChange={(e) => updateTextField('seller_tax_id', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('seller_tax_id')}
              </div>
            </div>

            <div>
              <label
                htmlFor="edit-seller-address"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Địa chỉ người bán
              </label>
              <input
                id="edit-seller-address"
                type="text"
                value={draft.seller_address}
                onChange={(e) => updateTextField('seller_address', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>

          {/* Nhóm 3: Thông tin Người mua (Buyer) */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 pb-2 border-b border-slate-200">
              03. Thông tin Người mua (Phân tách độc lập với Người bán)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <label
                  htmlFor="edit-buyer-name"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Tên đơn vị / Người mua
                </label>
                <input
                  id="edit-buyer-name"
                  type="text"
                  value={draft.buyer_name}
                  onChange={(e) => updateTextField('buyer_name', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-buyer-mst"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  MST người mua
                </label>
                <input
                  id="edit-buyer-mst"
                  type="text"
                  value={draft.buyer_tax_id}
                  onChange={(e) => updateTextField('buyer_tax_id', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          </div>

          {/* Nhóm 4: Giá trị Tiền hàng, Thuế & Tổng thanh toán */}
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                04. Giá trị Tài chính & Đối chiếu Toán học
              </h3>
              <button
                type="button"
                onClick={handleRecalculateTotal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Calculator className="w-3.5 h-3.5" />
                <span>Tính lại Tổng = Trước thuế - CK + Thuế</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label
                  htmlFor="edit-subtotal"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Tiền trước thuế *
                </label>
                <input
                  id="edit-subtotal"
                  type="number"
                  value={draft.subtotal_amount ?? ''}
                  onChange={(e) => updateNumberField('subtotal_amount', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('subtotal_amount')}
              </div>

              <div>
                <label
                  htmlFor="edit-vat-rate"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Thuế suất GTGT
                </label>
                <input
                  id="edit-vat-rate"
                  type="text"
                  placeholder="8% hoặc 10%"
                  value={draft.vat_rate}
                  onChange={(e) => updateTextField('vat_rate', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-vat-amount"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Tiền thuế GTGT *
                </label>
                <input
                  id="edit-vat-amount"
                  type="number"
                  value={draft.vat_amount ?? ''}
                  onChange={(e) => updateNumberField('vat_amount', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('vat_amount')}
              </div>

              <div>
                <label
                  htmlFor="edit-discount"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Chiết khấu / Điều chỉnh
                </label>
                <input
                  id="edit-discount"
                  type="number"
                  value={draft.discount_amount ?? ''}
                  onChange={(e) => updateNumberField('discount_amount', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-total-amount"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Tổng tiền thanh toán *
                </label>
                <input
                  id="edit-total-amount"
                  type="number"
                  value={draft.total_amount ?? ''}
                  onChange={(e) => updateNumberField('total_amount', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums font-semibold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                {renderFieldMeta('total_amount')}
              </div>

              <div>
                <label
                  htmlFor="edit-currency"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Loại tiền tệ
                </label>
                <input
                  id="edit-currency"
                  type="text"
                  value={draft.currency}
                  onChange={(e) => updateTextField('currency', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          </div>

          {/* Nhóm 5: Nội dung hàng hóa & Ghi chú */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 pb-2 border-b border-slate-200">
              05. Nội dung Hàng hóa / Dịch vụ & Ghi chú
            </h3>
            <div>
              <label
                htmlFor="edit-items-summary"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Tóm tắt hàng hóa, dịch vụ
              </label>
              <input
                id="edit-items-summary"
                type="text"
                value={draft.items_summary}
                onChange={(e) => updateTextField('items_summary', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label
                htmlFor="edit-notes"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Ghi chú kế toán
              </label>
              <input
                id="edit-notes"
                type="text"
                placeholder="Ghi chú xác minh hoặc hạch toán..."
                value={draft.notes}
                onChange={(e) => updateTextField('notes', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Hủy bỏ
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onSave(draft, false)}
              className="px-4 py-2.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              Lưu chỉnh sửa
            </button>
            <button
              type="button"
              onClick={() => onSave(draft, true)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Check className="w-4 h-4" />
              <span>Lưu & Đánh dấu Đã xác minh</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
