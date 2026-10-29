import React, { useState, useEffect } from 'react';
import { Code2, Copy, Check, Download, Terminal, ShieldAlert, CheckCircle2 } from 'lucide-react';

export const SourceAndDocsSection: React.FC = () => {
  const [filesMap, setFilesMap] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState<string>('backend/requirements.txt');
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/source-package')
      .then((r) => r.json())
      .then((data) => {
        if (data?.files) {
          setFilesMap(data.files);
        }
      })
      .catch(() => {
        // ignore
      });
  }, []);

  const fileKeys = Object.keys(filesMap);
  const currentContent = filesMap[activeFile] || 'Đang tải nội dung mã nguồn...';

  const handleCopy = () => {
    navigator.clipboard.writeText(currentContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSingleFile = (relPath: string) => {
    const content = filesMap[relPath] || '';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = relPath.split('/').pop() || 'file.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Báo cáo Kiểm thử & Giới hạn thực tế (Giai đoạn 4) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-200">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <h2 className="text-base font-semibold text-slate-900">
              Báo cáo Kiểm chứng Thực tế (Giai đoạn 4)
            </h2>
          </div>

          <div className="space-y-3 text-xs text-slate-700 leading-relaxed">
            <div>
              <strong className="text-slate-900">1. Phần đã chạy và kiểm chứng tự động (PASS 100%):</strong>
              <ul className="list-disc pl-5 mt-1 space-y-1">
                <li>
                  Bộ kiểm thử Backend Python (<code className="font-mono">python3 -m unittest backend/tests/test_invoice_pipeline.py</code>): Kiểm tra magic bytes <code className="font-mono">%PDF-</code>, từ chối file giả mạo/quá dung lượng, tách vùng MST người bán vs MST người mua, gom hộp chữ ngang của PaddleOCR, kiểm tra công thức cộng tiền và phát hiện hóa đơn trùng 3 mức.
                </li>
                <li>
                  Bộ kiểm thử Frontend TypeScript (<code className="font-mono">tsx --test src/utils/invoiceLogic.test.ts</code>): Kiểm tra chuẩn hóa số tiền Việt Nam, ngày tháng, tạo file PDF mẫu và ánh xạ cột Excel.
                </li>
                <li>
                  Kiểm thử tích hợp xuất Excel (<code className="font-mono">.xlsx</code>): Phân tích đúng dòng tiêu đề, giữ nguyên công thức <code className="font-mono">=H5-K5+J5</code> và tạo sheet <code className="font-mono">Bao_Cao_Kiem_Tra</code>.
                </li>
              </ul>
            </div>

            <div>
              <strong className="text-slate-900">2. Phần cần chạy trực tiếp trên máy Windows 10 của bạn:</strong>
              <ul className="list-disc pl-5 mt-1 space-y-1">
                <li>
                  Tải trọng số mạng nơ-ron lần đầu của <code className="font-mono">paddleocr==2.8.1</code> (~15MB vào <code className="font-mono">~/.paddleocr/</code>) trên Windows 10 CPU thông qua script <code className="font-mono">scripts\setup_win10.bat</code>.
                </li>
                <li>
                  Khởi tạo đường hầm <code className="font-mono">cloudflared.exe tunnel</code> kết nối về cổng <code className="font-mono">127.0.0.1:8000</code> tại nhà.
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-200">
            <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
            <h2 className="text-base font-semibold text-slate-900">
              Danh sách Rõ ràng Các Giới hạn Thực tế
            </h2>
          </div>

          <ul className="space-y-2.5 text-xs text-slate-700 leading-relaxed">
            <li>
              <strong>• Không tuyên bố nhận dạng chính xác tuyệt đối 100%:</strong> Với hóa đơn giấy nhiệt phai mờ, đóng dấu đỏ đè lên chữ số hoặc scan nghiêng nặng, PaddleOCR có thể nhận diện sai 1–2 ký tự. Hệ thống tự động đối chiếu công thức <code className="font-mono">Tiền hàng - CK + Thuế = Tổng tiền</code> để phát hiện sai số và buộc người dùng xác minh.
            </li>
            <li>
              <strong>• Không thay thế kiểm tra pháp lý chữ ký số XML:</strong> Công cụ hỗ trợ bóc tách dữ liệu và đối chiếu số học từ PDF, không xác thực chứng thư số CA với hệ thống Tổng cục Thuế.
            </li>
            <li>
              <strong>• Máy chủ riêng phải bật khi dùng từ xa:</strong> Khi bạn dùng trên iPhone qua 4G/Wi-Fi ngoài, máy tính Windows 10 ở nhà (hoặc MacBook Pro 2017 dự phòng) phải đang bật và chạy <code className="font-mono">start_server_win10.bat</code>.
            </li>
            <li>
              <strong>• Hỗ trợ mẫu Excel chuẩn .xlsx:</strong> Cần cung cấp file mẫu định dạng <code className="font-mono">.xlsx</code> (Excel 2007+). Nếu mẫu cũ là <code className="font-mono">.xls</code>, cần lưu sang <code className="font-mono">.xlsx</code> trước khi tải lên.
            </li>
          </ul>
        </div>
      </div>

      {/* Trình xem & tải xuống toàn bộ mã nguồn Backend Python, Scripts Windows 10 và Tài liệu */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-slate-700" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Mã nguồn Backend Python (FastAPI + PaddleOCR) & Kịch bản Windows 10
              </h3>
              <p className="text-xs text-slate-500">
                Toàn bộ file mã nguồn thực tế nằm trong thư mục dự án, sẵn sàng chạy trên Windows 10 & MacBook Pro 2017 Intel.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Đã sao chép' : 'Sao chép file này'}</span>
            </button>

            <button
              type="button"
              onClick={() => handleDownloadSingleFile(activeFile)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Tải xuống {activeFile.split('/').pop()}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Danh sách file bên trái */}
          <div className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-slate-200 bg-slate-50 p-3 space-y-1 max-h-[520px] overflow-y-auto">
            {fileKeys.map((fileKey) => (
              <button
                key={fileKey}
                type="button"
                onClick={() => setActiveFile(fileKey)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-mono rounded-md text-left transition-colors ${
                  activeFile === fileKey
                    ? 'bg-blue-600 text-white font-semibold'
                    : 'text-slate-700 hover:bg-slate-200/70'
                }`}
              >
                <Code2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{fileKey}</span>
              </button>
            ))}
          </div>

          {/* Nội dung code bên phải */}
          <div className="lg:col-span-8 bg-slate-950 text-slate-100 p-4 max-h-[520px] overflow-auto">
            <pre className="text-xs font-mono leading-relaxed whitespace-pre">
              <code>{currentContent}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
