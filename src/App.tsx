import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Play,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  Search,
  Edit3,
  FileSpreadsheet,
  FlaskConical,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import {
  BatchTaskResponse,
  ExcelTemplateAnalysis,
  ExtractedInvoice,
  ServerConnectionConfig,
  VerificationStatus,
} from './types/invoice';
import { createSampleTestPdfFiles } from './utils/sampleBatchFactory';
import { validateInvoiceBatch } from './utils/invoiceLogic';
import { InvoiceEditDrawer } from './components/InvoiceEditDrawer';
import { ExcelTemplateSection } from './components/ExcelTemplateSection';
import { ServerSecuritySection } from './components/ServerSecuritySection';
import { SourceAndDocsSection } from './components/SourceAndDocsSection';

type ActiveTab = 'workspace' | 'excel' | 'security' | 'docs';
type StatusFilter = 'ALL' | 'NEEDS_REVIEW' | 'DUPLICATE_WARNING' | 'VERIFIED';

const DEFAULT_TOKEN = 'vn-invoice-local-dev-token';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workspace');

  // Cấu hình kết nối máy chủ (chỉ lưu trong sessionStorage để bảo mật)
  const [serverConfig, setServerConfig] = useState<ServerConnectionConfig>(() => {
    try {
      const saved = sessionStorage.getItem('vn_invoice_server_cfg');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return {
      mode: 'BUILTIN_GATEWAY',
      remoteUrl: 'http://127.0.0.1:8000',
      apiToken: DEFAULT_TOKEN,
    };
  });

  // Danh sách file PDF người dùng đã chọn chờ xử lý
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [currentTask, setCurrentTask] = useState<BatchTaskResponse | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Dữ liệu hóa đơn đã trích xuất
  const [invoices, setInvoices] = useState<ExtractedInvoice[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [editingInvoice, setEditingInvoice] = useState<ExtractedInvoice | null>(null);

  // Cấu hình & Phân tích mẫu Excel
  const [templateAnalysis, setTemplateAnalysis] = useState<ExcelTemplateAnalysis | null>(null);
  const [isAnalyzingExcel, setIsAnalyzingExcel] = useState<boolean>(false);
  const [isExportingExcel, setIsExportingExcel] = useState<boolean>(false);

  // Trạng thái Health Check & Dọn file tạm
  const [healthData, setHealthData] = useState<Record<string, unknown> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const getApiUrl = (endpoint: string) => {
    if (serverConfig.mode === 'REMOTE_FASTAPI' && serverConfig.remoteUrl) {
      return `${serverConfig.remoteUrl.replace(/\/+$/, '')}${endpoint}`;
    }
    return endpoint;
  };

  const getAuthHeaders = (): Record<string, string> => ({
    'X-API-Token': serverConfig.apiToken,
  });

  const checkServerHealth = async () => {
    setHealthError(null);
    try {
      const res = await fetch(getApiUrl('/api/health'), {
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`Máy chủ trả về mã lỗi HTTP ${res.status}`);
      }
      const data = await res.json();
      setHealthData(data);
    } catch (err: unknown) {
      setHealthData(null);
      setHealthError(
        err instanceof Error
          ? `Không thể kết nối tới máy chủ OCR (${err.message}). Vui lòng kiểm tra máy chủ Windows 10 đã bật chưa.`
          : 'Mất kết nối tới máy chủ OCR.'
      );
    }
  };

  useEffect(() => {
    checkServerHealth();
  }, [serverConfig]);

  // Tự động nạp bộ dữ liệu mẫu kiểm thử ngay lần đầu để có thể trải nghiệm luồng hoàn chỉnh
  useEffect(() => {
    const sampleFiles = createSampleTestPdfFiles();
    setSelectedFiles(sampleFiles);
    runUploadBatch(sampleFiles);
  }, []);

  const handleUpdateServerConfig = (next: ServerConnectionConfig) => {
    setServerConfig(next);
    try {
      sessionStorage.setItem('vn_invoice_server_cfg', JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const newFiles = Array.from(fileList);
    setSelectedFiles((prev) => [...prev, ...newFiles]);
    setUploadError(null);
    e.target.value = '';
  };

  const handleLoadSampleBatch = () => {
    const samples = createSampleTestPdfFiles();
    setSelectedFiles(samples);
    setUploadError(null);
    runUploadBatch(samples);
  };

  const runUploadBatch = async (filesToProcess: File[]) => {
    if (filesToProcess.length === 0) {
      setUploadError('Vui lòng chọn ít nhất 1 file PDF hóa đơn trước khi bắt đầu.');
      return;
    }

    setIsUploading(true);
    setUploadError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const formData = new FormData();
      for (const file of filesToProcess) {
        formData.append('files', file, file.name);
      }

      const res = await fetch(getApiUrl('/api/tasks/upload'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
        signal: controller.signal,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data?.detail || `Lỗi tải file lên máy chủ (HTTP ${res.status}).`
        );
      }

      const taskResult = data as BatchTaskResponse;
      setCurrentTask(taskResult);
      setInvoices(taskResult.invoices || []);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setUploadError('Đã hủy tác vụ tải lên và xử lý theo yêu cầu của người dùng.');
      } else {
        setUploadError(
          err instanceof Error
            ? err.message
            : 'Kết nối bị gián đoạn khi đang tải file (có thể do chuyển ứng dụng hoặc khóa màn hình iPhone). Hãy nhấn Thử lại.'
        );
      }
    } finally {
      setIsUploading(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelBatch = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (currentTask?.task_id) {
      try {
        await fetch(getApiUrl(`/api/tasks/${currentTask.task_id}/cancel`), {
          method: 'POST',
          headers: getAuthHeaders(),
        });
      } catch {
        // ignore
      }
    }
    setIsUploading(false);
  };

  const handleSaveEditedInvoice = async (
    updated: ExtractedInvoice,
    markVerified: boolean
  ) => {
    const nextList = invoices.map((inv) => {
      if (inv.id !== updated.id) return inv;
      return {
        ...updated,
        verification_status: markVerified ? ('VERIFIED' as VerificationStatus) : updated.verification_status,
      };
    });

    // Chạy kiểm tra dữ liệu và đối chiếu trùng lặp ngay lập tức
    const revalidated = validateInvoiceBatch(nextList);
    if (markVerified) {
      const target = revalidated.find((r) => r.id === updated.id);
      if (target && !target.validation_issues.some((i) => i.severity === 'ERROR')) {
        target.verification_status = 'VERIFIED';
        target.uncertain_fields = [];
      }
    }

    setInvoices(revalidated);
    setEditingInvoice(null);

    try {
      await fetch(getApiUrl('/api/invoices/validate'), {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ invoices: revalidated }),
      });
    } catch {
      // Đã cập nhật trạng thái kiểm tra cục bộ
    }
  };

  const handleQuickMarkVerified = (invoiceId: string) => {
    setInvoices((prev) =>
      prev.map((inv) =>
        inv.id === invoiceId
          ? { ...inv, verification_status: 'VERIFIED', uncertain_fields: [] }
          : inv
      )
    );
  };

  const handleUploadExcelTemplate = async (file: File) => {
    setIsAnalyzingExcel(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file, file.name);
      const res = await fetch(getApiUrl('/api/excel/analyze-template'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || 'Không thể phân tích file Excel mẫu.');
      }
      setTemplateAnalysis(data as ExcelTemplateAnalysis);
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error ? err.message : 'Lỗi khi phân tích file Excel mẫu.'
      );
    } finally {
      setIsAnalyzingExcel(false);
    }
  };

  const handleGenerateSampleTemplate = async () => {
    setIsAnalyzingExcel(true);
    setUploadError(null);
    try {
      const res = await fetch(getApiUrl('/api/excel/generate-sample-template'), {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || 'Lỗi nạp mẫu bảng kê chuẩn.');
      }
      setTemplateAnalysis(data as ExcelTemplateAnalysis);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Lỗi tạo mẫu bảng kê.');
    } finally {
      setIsAnalyzingExcel(false);
    }
  };

  const handleExportExcel = async (
    targetSheet: string,
    customMapping: Record<number, string>,
    includeAuditSheet: boolean
  ) => {
    if (!templateAnalysis?.template_id) {
      setUploadError('Vui lòng tải lên hoặc nạp file Excel mẫu trước khi xuất dữ liệu.');
      return;
    }
    if (invoices.length === 0) {
      setUploadError('Không có dữ liệu hóa đơn để xuất ra Excel.');
      return;
    }

    setIsExportingExcel(true);
    setUploadError(null);
    try {
      const res = await fetch(getApiUrl('/api/excel/export'), {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_id: templateAnalysis.template_id,
          invoices,
          target_sheet: targetSheet,
          custom_column_mapping: customMapping,
          include_audit_sheet: includeAuditSheet,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.detail || `Lỗi xuất Excel (HTTP ${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Bang_Ke_${templateAnalysis.template_filename.replace(/\.xlsx$/i, '')}_Da_Ghi.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Lỗi khi tải xuống file Excel.');
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handleCleanupTemp = async () => {
    setCleanupMessage(null);
    try {
      const res = await fetch(getApiUrl('/api/system/cleanup'), {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || 'Không thể xóa file tạm.');
      }
      setCleanupMessage(
        `Đã xóa sạch ${data.cleaned_items ?? 0} file/thư mục tạm trên máy chủ.`
      );
    } catch (err: unknown) {
      setCleanupMessage(err instanceof Error ? err.message : 'Lỗi khi dọn file tạm.');
    }
  };

  // Thống kê KPI trên lô hiện tại
  const totalInvoicesCount = invoices.length;
  const verifiedCount = invoices.filter((i) => i.verification_status === 'VERIFIED').length;
  const reviewOrDupCount = invoices.filter(
    (i) =>
      i.verification_status === 'NEEDS_REVIEW' ||
      i.verification_status === 'DUPLICATE_WARNING'
  ).length;
  const totalPaymentSum = invoices.reduce((acc, i) => acc + (i.total_amount ?? 0), 0);

  // Lọc danh sách hóa đơn
  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter !== 'ALL' && inv.verification_status !== statusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const matchSeller = inv.seller_name.toLowerCase().includes(q);
      const matchMst = inv.seller_tax_id.toLowerCase().includes(q);
      const matchNo = inv.invoice_number.toLowerCase().includes(q);
      const matchFile = inv.source_filename.toLowerCase().includes(q);
      return matchSeller || matchMst || matchNo || matchFile;
    }
    return true;
  });

  const formatVnd = (val: number | null) => {
    if (val === null || val === undefined) return '—';
    return val.toLocaleString('vi-VN');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 Zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 bg-white border-b border-slate-200">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('workspace');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          VNInvoice OCR
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="Điều hướng chính"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
        >
          <a
            href="#workspace"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('workspace');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeTab === 'workspace'
                ? 'text-slate-900 border-b-2 border-blue-600 font-semibold'
                : ''
            }`}
          >
            Bàn làm việc OCR
          </a>
          <a
            href="#excel"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('excel');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeTab === 'excel'
                ? 'text-slate-900 border-b-2 border-blue-600 font-semibold'
                : ''
            }`}
          >
            Xuất Excel Mẫu
          </a>
          <a
            href="#security"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('security');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeTab === 'security'
                ? 'text-slate-900 border-b-2 border-blue-600 font-semibold'
                : ''
            }`}
          >
            Máy chủ & Bảo mật
          </a>
          <a
            href="#docs"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('docs');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeTab === 'docs'
                ? 'text-slate-900 border-b-2 border-blue-600 font-semibold'
                : ''
            }`}
          >
            Mã nguồn & Kiểm thử
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              setActiveTab('workspace');
              fileInputRef.current?.click();
            }}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            Chọn File PDF
          </button>
          <input
            ref={fileInputRef}
            id="global-pdf-upload"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={handleFileInputChange}
            className="sr-only"
          />
        </div>
      </header>

      {/* Thanh chuyển tab cho màn hình điện thoại nhỏ (iPhone Safari) */}
      <div className="md:hidden grid grid-cols-4 bg-white border-b border-slate-200 px-2 py-1.5 gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('workspace')}
          className={`px-2 py-2.5 text-xs font-medium rounded-md text-center truncate ${
            activeTab === 'workspace'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Hóa đơn
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('excel')}
          className={`px-2 py-2.5 text-xs font-medium rounded-md text-center truncate ${
            activeTab === 'excel'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Xuất Excel
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('security')}
          className={`px-2 py-2.5 text-xs font-medium rounded-md text-center truncate ${
            activeTab === 'security'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Máy chủ
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('docs')}
          className={`px-2 py-2.5 text-xs font-medium rounded-md text-center truncate ${
            activeTab === 'docs'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Mã nguồn
        </button>
      </div>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Thông báo lỗi toàn cục rõ ràng (không để màn hình trắng) */}
        {uploadError && (
          <div
            role="alert"
            className="p-4 bg-red-50 border border-red-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2.5 text-xs text-red-800">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Thông báo xử lý</div>
                <div className="mt-0.5 leading-relaxed">{uploadError}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {selectedFiles.length > 0 && (
                <button
                  type="button"
                  onClick={() => runUploadBatch(selectedFiles)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-700 rounded-md hover:bg-red-800 transition-colors whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Thử tải lên lại</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="px-3 py-1.5 text-xs font-medium text-red-800 bg-red-100 rounded-md hover:bg-red-200 transition-colors whitespace-nowrap shrink-0"
              >
                Đóng
              </button>
            </div>
          </div>
        )}

        {activeTab === 'workspace' && (
          <div className="space-y-6">
            {/* Khu vực Tiếp nhận File PDF & Tiến độ Xử lý */}
            <section
              aria-labelledby="upload-section-heading"
              className="bg-white border border-slate-200 rounded-lg p-5 sm:p-6 space-y-5"
            >
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <h1
                    id="upload-section-heading"
                    className="text-xl font-bold text-slate-900 tracking-tight"
                  >
                    Đọc Hàng Loạt Hóa Đơn PDF (Lớp Văn Bản & PaddleOCR)
                  </h1>
                  <p className="text-xs sm:text-sm text-slate-600 mt-1">
                    Hỗ trợ 20–100 file PDF/lần. Tự động ưu tiên đọc lớp văn bản PDF và chỉ gọi PaddleOCR trên các trang scan hình ảnh.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Upload className="w-4 h-4 text-slate-600" />
                    <span>Thêm File PDF ({selectedFiles.length})</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleLoadSampleBatch}
                    disabled={isUploading}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <FlaskConical className="w-4 h-4 text-blue-600" />
                    <span>Nạp 5 PDF Mẫu Kiểm Thử</span>
                  </button>

                  {isUploading ? (
                    <button
                      type="button"
                      onClick={handleCancelBatch}
                      className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors whitespace-nowrap shrink-0"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>Hủy Tác Vụ</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => runUploadBatch(selectedFiles)}
                      disabled={selectedFiles.length === 0}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                    >
                      <Play className="w-4 h-4" />
                      <span>Bắt đầu Đọc & Trích xuất ({selectedFiles.length} file)</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Thanh tổng tiến độ và danh sách từng file PDF */}
              {currentTask && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 text-slate-700 font-medium">
                      <span>Tiến độ tổng thể lô ({currentTask.task_id}):</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums font-semibold text-slate-900">
                        {currentTask.completed_files}/{currentTask.total_files} hoàn tất
                      </span>
                      {currentTask.failed_files > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-red-700 font-semibold font-mono tabular-nums">
                            {currentTask.failed_files} file lỗi
                          </span>
                        </>
                      )}
                    </div>
                    <span className="font-mono tabular-nums font-semibold text-blue-700">
                      {currentTask.overall_progress_pct}%
                    </span>
                  </div>

                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-600 transition-transform duration-150 origin-left"
                      style={{
                        transform: `scaleX(${currentTask.overall_progress_pct / 100})`,
                      }}
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                    {currentTask.files.map((f) => (
                      <div
                        key={f.file_id}
                        className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-col justify-between gap-1.5 text-xs"
                      >
                        <div className="font-medium text-slate-900 truncate" title={f.filename}>
                          {f.filename}
                        </div>
                        <div className="flex items-center gap-1.5 text-slate-500 font-mono tabular-nums">
                          <span>{(f.size_bytes / 1024).toFixed(1)} KB</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {f.extraction_method === 'PADDLE_OCR'
                              ? 'PaddleOCR'
                              : f.extraction_method === 'PDF_TEXT'
                              ? 'PDF Text'
                              : 'Kiểm tra'}
                          </span>
                        </div>
                        <div className="pt-1 border-t border-slate-200/80 flex items-center justify-between">
                          {f.status === 'COMPLETED' && (
                            <span className="text-emerald-700 font-medium">Hoàn tất (100%)</span>
                          )}
                          {f.status === 'FAILED' && (
                            <span
                              className="text-red-700 font-medium truncate"
                              title={f.error_message}
                            >
                              Lỗi: {f.error_message}
                            </span>
                          )}
                          {f.status === 'PROCESSING' && (
                            <span className="text-blue-700 font-medium">
                              Đang xử lý ({f.progress_pct}%)
                            </span>
                          )}
                          {f.status === 'CANCELLED' && (
                            <span className="text-slate-500">Đã hủy</span>
                          )}
                          {f.status === 'QUEUED' && (
                            <span className="text-slate-500">Đang chờ</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Khi người dùng chọn thêm file mới chưa bấm chạy */}
              {selectedFiles.length > 0 && !currentTask && (
                <div className="flex items-center justify-between text-xs text-slate-600 pt-2">
                  <span>
                    Đã chọn {selectedFiles.length} file PDF sẵn sàng gửi tới máy chủ OCR.
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedFiles([])}
                    className="inline-flex items-center gap-1 text-red-700 hover:underline"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Xóa danh sách chọn</span>
                  </button>
                </div>
              )}
            </section>

            {/* 4-Column KPI Summary Strip */}
            <section
              aria-label="Thống kê kết quả trích xuất"
              className="grid grid-cols-2 lg:grid-cols-4 gap-4"
            >
              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-500">Tổng số hóa đơn đọc được</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                  {totalInvoicesCount}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Tách biệt MST Bán & MST Mua
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-500">Đạt chuẩn / Đã xác minh</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-emerald-700 mt-1">
                  {verifiedCount}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Khớp công thức cộng tiền & MST
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-500">Cần xác minh / Nghi trùng</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-amber-700 mt-1">
                  {reviewOrDupCount}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Có cảnh báo sai số hoặc trùng số HĐ
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-500">Tổng giá trị thanh toán</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1 truncate">
                  {formatVnd(totalPaymentSum)} <span className="text-xs font-normal">VND</span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Sẵn sàng kết xuất bảng kê Excel
                </div>
              </div>
            </section>

            {/* Bảng Dữ Liệu Trích Xuất Hóa Đơn */}
            <section
              aria-labelledby="extracted-table-heading"
              className="bg-white border border-slate-200 rounded-lg overflow-hidden"
            >
              {/* Thanh công cụ lọc & tìm kiếm */}
              <div className="p-4 sm:px-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h2
                    id="extracted-table-heading"
                    className="text-base font-semibold text-slate-900 whitespace-nowrap"
                  >
                    Bảng Dữ Liệu Hóa Đơn Trích Xuất
                  </h2>

                  {/* Interactive Filter Segmented Control */}
                  <div
                    role="group"
                    aria-label="Lọc theo trạng thái xác minh"
                    className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto"
                  >
                    <button
                      type="button"
                      onClick={() => setStatusFilter('ALL')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        statusFilter === 'ALL'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Tất cả ({invoices.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusFilter('NEEDS_REVIEW')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        statusFilter === 'NEEDS_REVIEW'
                          ? 'bg-white text-amber-800 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Cần xác minh (
                      {invoices.filter((i) => i.verification_status === 'NEEDS_REVIEW').length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusFilter('DUPLICATE_WARNING')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        statusFilter === 'DUPLICATE_WARNING'
                          ? 'bg-white text-red-800 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Cảnh báo trùng (
                      {invoices.filter((i) => i.verification_status === 'DUPLICATE_WARNING').length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusFilter('VERIFIED')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        statusFilter === 'VERIFIED'
                          ? 'bg-white text-emerald-800 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Đã xác minh ({verifiedCount})
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative flex-1 sm:w-64">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      aria-label="Tìm theo tên người bán, MST hoặc số hóa đơn"
                      placeholder="Tìm người bán, MST, số HĐ..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveTab('excel')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <FileSpreadsheet className="w-4 h-4" />
                    <span>Chuyển sang Xuất Excel Mẫu</span>
                  </button>
                </div>
              </div>

              {/* Nội dung bảng */}
              {filteredInvoices.length === 0 ? (
                <div className="py-12 px-6 text-center space-y-3">
                  <div className="text-sm font-medium text-slate-800">
                    Không có hóa đơn nào khớp với bộ lọc hiện tại
                  </div>
                  <p className="text-xs text-slate-500">
                    Hãy tải lên file PDF hóa đơn hoặc nhấn nút "Nạp 5 PDF Mẫu Kiểm Thử" để xem kết quả trích xuất.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
                        <th className="py-3 px-4">Số HĐ / Ngày lập</th>
                        <th className="py-3 px-4">Người bán & MST Bán</th>
                        <th className="py-3 px-4">Người mua & MST Mua</th>
                        <th className="py-3 px-4 text-right">Tiền trước thuế</th>
                        <th className="py-3 px-4 text-right">Thuế GTGT</th>
                        <th className="py-3 px-4 text-right">Tổng thanh toán</th>
                        <th className="py-3 px-4">Kiểm tra & Nguồn đọc</th>
                        <th className="py-3 px-4 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-xs">
                      {filteredInvoices.map((inv) => {
                        const isDup = inv.verification_status === 'DUPLICATE_WARNING';
                        const isReview = inv.verification_status === 'NEEDS_REVIEW';

                        return (
                          <tr
                            key={inv.id}
                            className={`hover:bg-slate-50/90 transition-colors ${
                              isDup
                                ? 'bg-red-50/30'
                                : isReview
                                ? 'bg-amber-50/30'
                                : ''
                            }`}
                          >
                            {/* Số hóa đơn & Ngày */}
                            <td className="py-3 px-4 align-top">
                              <div className="font-mono font-semibold text-slate-900">
                                {inv.invoice_number || 'Chưa rõ'}
                              </div>
                              <div className="flex items-center gap-1.5 text-slate-500 font-mono tabular-nums mt-0.5">
                                <span>{inv.invoice_symbol || '—'}</span>
                                <span aria-hidden="true">·</span>
                                <span>{inv.invoice_date || '—'}</span>
                              </div>
                              <div
                                className="text-slate-400 truncate max-w-[160px] mt-0.5"
                                title={inv.source_filename}
                              >
                                {inv.source_filename}
                              </div>
                            </td>

                            {/* Người bán & MST Bán */}
                            <td className="py-3 px-4 align-top max-w-[240px]">
                              <div className="font-medium text-slate-900 leading-snug">
                                {inv.seller_name || 'Chưa nhận diện tên người bán'}
                              </div>
                              <div className="font-mono tabular-nums text-slate-600 mt-0.5">
                                MST Bán: <strong className="font-semibold">{inv.seller_tax_id || 'Thiếu'}</strong>
                              </div>
                              {inv.items_summary && (
                                <div className="text-slate-500 truncate mt-0.5" title={inv.items_summary}>
                                  HH: {inv.items_summary}
                                </div>
                              )}
                            </td>

                            {/* Người mua & MST Mua */}
                            <td className="py-3 px-4 align-top max-w-[200px]">
                              <div className="text-slate-800 truncate" title={inv.buyer_name}>
                                {inv.buyer_name || '—'}
                              </div>
                              <div className="font-mono tabular-nums text-slate-500 mt-0.5">
                                MST Mua: {inv.buyer_tax_id || '—'}
                              </div>
                            </td>

                            {/* Tiền trước thuế */}
                            <td className="py-3 px-4 align-top text-right font-mono tabular-nums text-slate-800">
                              {formatVnd(inv.subtotal_amount)}
                            </td>

                            {/* Tiền thuế GTGT */}
                            <td className="py-3 px-4 align-top text-right font-mono tabular-nums text-slate-800">
                              <div>{formatVnd(inv.vat_amount)}</div>
                              {inv.vat_rate && (
                                <div className="text-slate-500">({inv.vat_rate})</div>
                              )}
                            </td>

                            {/* Tổng thanh toán */}
                            <td className="py-3 px-4 align-top text-right font-mono tabular-nums font-semibold text-slate-900">
                              {formatVnd(inv.total_amount)}
                              <div className="text-slate-400 font-normal">{inv.currency}</div>
                            </td>

                            {/* Trạng thái & Cảnh báo (Unboxed metadata per Zero-Pill rule) */}
                            <td className="py-3 px-4 align-top max-w-[260px]">
                              <div className="flex items-center gap-1.5 font-medium">
                                {inv.verification_status === 'VERIFIED' && (
                                  <span className="inline-flex items-center gap-1 text-emerald-700">
                                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                    <span>Đã xác minh</span>
                                  </span>
                                )}
                                {inv.verification_status === 'NEEDS_REVIEW' && (
                                  <span className="inline-flex items-center gap-1 text-amber-700">
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                    <span>Cần xác minh</span>
                                  </span>
                                )}
                                {inv.verification_status === 'DUPLICATE_WARNING' && (
                                  <span className="inline-flex items-center gap-1 text-red-700">
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                    <span>Cảnh báo trùng lặp</span>
                                  </span>
                                )}
                                <span aria-hidden="true" className="text-slate-400">·</span>
                                <span className="text-slate-500 font-normal">
                                  {inv.extraction_method === 'PADDLE_OCR'
                                    ? 'PaddleOCR'
                                    : inv.extraction_method === 'USER_EDITED'
                                    ? 'Đã sửa'
                                    : 'PDF Text'}
                                </span>
                              </div>

                              {inv.validation_issues.length > 0 && (
                                <ul className="mt-1 space-y-0.5 text-slate-600">
                                  {inv.validation_issues.map((iss, iIdx) => (
                                    <li
                                      key={iIdx}
                                      className={
                                        iss.severity === 'ERROR'
                                          ? 'text-red-700 leading-snug'
                                          : 'text-amber-800 leading-snug'
                                      }
                                    >
                                      • {iss.message}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>

                            {/* Thao tác */}
                            <td className="py-3 px-4 align-top text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setEditingInvoice(inv)}
                                  aria-label={`Sửa hóa đơn số ${inv.invoice_number || inv.source_filename}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                  <span>Sửa</span>
                                </button>

                                {inv.verification_status !== 'VERIFIED' && (
                                  <button
                                    type="button"
                                    onClick={() => handleQuickMarkVerified(inv.id)}
                                    aria-label={`Xác nhận hóa đơn số ${inv.invoice_number || inv.source_filename}`}
                                    className="px-2.5 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-md transition-colors whitespace-nowrap shrink-0"
                                  >
                                    Duyệt
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'excel' && (
          <ExcelTemplateSection
            invoices={invoices}
            templateAnalysis={templateAnalysis}
            onUploadTemplate={handleUploadExcelTemplate}
            onGenerateSampleTemplate={handleGenerateSampleTemplate}
            onExportExcel={handleExportExcel}
            isAnalyzing={isAnalyzingExcel}
            isExporting={isExportingExcel}
          />
        )}

        {activeTab === 'security' && (
          <ServerSecuritySection
            config={serverConfig}
            onUpdateConfig={handleUpdateServerConfig}
            healthData={healthData}
            healthError={healthError}
            onCheckHealth={checkServerHealth}
            onCleanupTemp={handleCleanupTemp}
            cleanupMessage={cleanupMessage}
          />
        )}

        {activeTab === 'docs' && <SourceAndDocsSection />}
      </main>

      {/* Footer yên tĩnh, không chứa telemetry giả */}
      <footer className="mt-auto border-t border-slate-200 bg-white px-6 py-4 text-xs text-slate-500 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          VNInvoice OCR — Hệ thống Đọc Hóa Đơn PDF bằng PaddleOCR & Xuất Bảng Kê Excel Theo Mẫu (Tự vận hành 100%).
        </div>
        <div className="flex items-center gap-2">
          <span>Windows 10 CPU</span>
          <span aria-hidden="true">·</span>
          <span>MacBook Pro 2017 Intel</span>
          <span aria-hidden="true">·</span>
          <span>Tương thích iPhone Safari</span>
        </div>
      </footer>

      {/* Cửa sổ chỉnh sửa hóa đơn chi tiết */}
      <InvoiceEditDrawer
        invoice={editingInvoice}
        onClose={() => setEditingInvoice(null)}
        onSave={handleSaveEditedInvoice}
      />
    </div>
  );
}
