import React, { useState } from 'react';
import {
  ShieldCheck,
  Server,
  RefreshCw,
  Trash2,
  Lock,
  Smartphone,
  AlertTriangle,
} from 'lucide-react';
import { ServerConnectionConfig } from '../types/invoice';

interface ServerSecuritySectionProps {
  config: ServerConnectionConfig;
  onUpdateConfig: (next: ServerConnectionConfig) => void;
  healthData: Record<string, unknown> | null;
  healthError: string | null;
  onCheckHealth: () => Promise<void>;
  onCleanupTemp: () => Promise<void>;
  cleanupMessage: string | null;
}

export const ServerSecuritySection: React.FC<ServerSecuritySectionProps> = ({
  config,
  onUpdateConfig,
  healthData,
  healthError,
  onCheckHealth,
  onCleanupTemp,
  cleanupMessage,
}) => {
  const [mode, setMode] = useState<'BUILTIN_GATEWAY' | 'REMOTE_FASTAPI'>(config.mode);
  const [remoteUrl, setRemoteUrl] = useState<string>(config.remoteUrl);
  const [apiToken, setApiToken] = useState<string>(config.apiToken);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateConfig({
      mode,
      remoteUrl: remoteUrl.trim().replace(/\/+$/, ''),
      apiToken: apiToken.trim(),
    });
    setSavedNotice('Đã áp dụng cấu hình kết nối và lưu Khóa xác thực vào phiên làm việc (sessionStorage).');
    setTimeout(() => setSavedNotice(null), 4000);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Cột cấu hình kết nối & xác thực */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-6">
          <form onSubmit={handleSave} className="space-y-5">
            <div className="pb-4 border-b border-slate-200">
              <h2 className="text-lg font-semibold text-slate-900">
                Kết nối Máy chủ OCR & Xác thực Bảo mật
              </h2>
              <p className="text-sm text-slate-600 mt-1">
                Mọi yêu cầu tải file PDF, chạy PaddleOCR và xuất Excel đều bắt buộc xác thực bằng Header <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">X-API-Token</code>. Không nhúng khóa bí mật vào mã nguồn công khai.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-800 mb-2">
                Chế độ kết nối Backend
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setMode('BUILTIN_GATEWAY')}
                  className={`p-3.5 text-left rounded-lg border transition-colors ${
                    mode === 'BUILTIN_GATEWAY'
                      ? 'border-blue-600 bg-blue-50/50 text-slate-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="text-xs font-semibold">Máy chủ Cổng Tích Hợp (Mặc định)</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Kết nối trực tiếp tới endpoint nội bộ `/api/*` trên máy chủ hiện tại.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setMode('REMOTE_FASTAPI')}
                  className={`p-3.5 text-left rounded-lg border transition-colors ${
                    mode === 'REMOTE_FASTAPI'
                      ? 'border-blue-600 bg-blue-50/50 text-slate-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="text-xs font-semibold">
                    Máy chủ Windows 10 Từ Xa (Cloudflare Tunnel)
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Kết nối HTTPS từ iPhone / Cloudflare Pages về FastAPI + PaddleOCR tại nhà.
                  </div>
                </button>
              </div>
            </div>

            {mode === 'REMOTE_FASTAPI' && (
              <div>
                <label
                  htmlFor="remote-server-url"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Địa chỉ HTTPS Cloudflare Tunnel hoặc LAN của máy chủ Windows 10
                </label>
                <input
                  id="remote-server-url"
                  type="url"
                  placeholder="https://ocr-home.tenmiencuaban.com hoặc http://127.0.0.1:8000"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            )}

            <div>
              <label
                htmlFor="api-token-input"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Khóa xác thực máy chủ (APP_API_TOKEN)
              </label>
              <div className="relative">
                <input
                  id="api-token-input"
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Mặc định khi chạy thử: <code className="font-mono">vn-invoice-local-dev-token</code>. Chỉ lưu tạm trong <code className="font-mono">sessionStorage</code>, tự xóa khi đóng tab trình duyệt.
              </p>
            </div>

            {savedNotice && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">
                {savedNotice}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="submit"
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Lock className="w-4 h-4" />
                <span>Lưu Cấu hình Kết nối</span>
              </button>

              <button
                type="button"
                onClick={onCheckHealth}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Kiểm tra Kết nối Máy chủ (/api/health)</span>
              </button>
            </div>
          </form>

          {/* Dọn dẹp file tạm */}
          <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="text-xs font-semibold text-slate-900">
                Xóa File Tạm Trên Máy Chủ Riêng
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Xóa toàn bộ file PDF và bảng kê tạm thời trong thư mục <code className="font-mono">temp_workspace</code> ngay lập tức.
              </div>
            </div>
            <button
              type="button"
              onClick={onCleanupTemp}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-4 h-4" />
              <span>Xóa Sạch File Tạm Ngay</span>
            </button>
          </div>
          {cleanupMessage && (
            <div className="text-xs text-emerald-700 font-medium">{cleanupMessage}</div>
          )}
        </div>

        {/* Cột trạng thái máy chủ & giải thích bảo mật luồng dữ liệu */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div>
            <h3 className="text-base font-semibold text-slate-900 pb-3 border-b border-slate-200 flex items-center gap-2">
              <Server className="w-4 h-4 text-slate-700" />
              <span>Trạng thái Máy chủ OCR Hiện tại</span>
            </h3>

            {healthError ? (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-red-800">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>Không thể kết nối tới Máy chủ OCR</span>
                </div>
                <p className="text-xs text-red-700 leading-relaxed">{healthError}</p>
                <p className="text-xs text-red-700">
                  Lưu ý: Ứng dụng không hoạt động nếu máy chủ Windows 10 ở nhà (hoặc MacBook dự phòng) đang tắt. Hãy kiểm tra file <code className="font-mono">start_server_win10.bat</code>.
                </p>
                <button
                  type="button"
                  onClick={onCheckHealth}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-red-700 rounded-md hover:bg-red-800 transition-colors"
                >
                  Thử kết nối lại
                </button>
              </div>
            ) : healthData ? (
              <dl className="mt-4 space-y-2.5 text-xs">
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <dt className="text-slate-500">Trạng thái phản hồi:</dt>
                  <dd className="font-semibold text-emerald-700">Đang hoạt động (HTTP 200 OK)</dd>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <dt className="text-slate-500">Nhân xử lý:</dt>
                  <dd className="font-mono text-slate-900 text-right">
                    {String(healthData.engine || 'FastAPI + PaddleOCR')}
                  </dd>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <dt className="text-slate-500">Giới hạn dung lượng / Số lượng:</dt>
                  <dd className="font-mono tabular-nums text-slate-900">
                    {String(healthData.max_file_size_mb || 25)} MB /{' '}
                    {String(healthData.max_files_per_batch || 100)} file
                  </dd>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <dt className="text-slate-500">Tự động xóa PDF tạm:</dt>
                  <dd className="font-medium text-slate-900">
                    {healthData.auto_cleanup_temp ? 'Bật (Xóa ngay sau khi đọc)' : 'Tắt'}
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="mt-4 text-xs text-slate-500">Đang kiểm tra trạng thái máy chủ...</div>
            )}
          </div>

          <div className="space-y-3 pt-2 border-t border-slate-200">
            <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-blue-600" />
              <span>Khi nào dữ liệu được gửi từ iPhone / Máy tính về Máy chủ ở nhà?</span>
            </h4>
            <ul className="space-y-2 text-xs text-slate-600 leading-relaxed">
              <li>
                1. <strong>Khi chọn file PDF trên iPhone/Windows:</strong> File chỉ nằm trong bộ nhớ trình duyệt cho tới khi bạn bấm <em>"Bắt đầu Đọc & Trích xuất Hóa đơn"</em>.
              </li>
              <li>
                2. <strong>Trong quá trình xử lý:</strong> File PDF được truyền qua kết nối HTTPS (Cloudflare Tunnel) thẳng về máy chủ Windows 10 ở nhà của bạn. Không gửi qua bất kỳ API OCR bên thứ ba nào.
              </li>
              <li>
                3. <strong>Sau khi trích xuất:</strong> Máy chủ xóa ngay file PDF gốc trong thư mục tạm và che giấu Mã số thuế trong nhật ký hệ thống (log).
              </li>
            </ul>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <Smartphone className="w-4 h-4 text-slate-600" />
              <span>Tương thích Safari iOS (iPhone)</span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Nếu bạn chuyển ứng dụng hoặc khóa màn hình iPhone khi đang tải nhiều file PDF lên và kết nối mạng bị ngắt quãng, hệ thống sẽ giữ nguyên danh sách file đã chọn và hiển thị nút <strong>"Thử tải lên lại"</strong> mà không làm trắng trang.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
