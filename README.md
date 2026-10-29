# VNInvoice OCR — Hệ Thống Đọc Hóa Đơn PDF Bằng PaddleOCR & Xuất Excel Theo Mẫu

Ứng dụng đọc hàng loạt hóa đơn điện tử PDF (có lớp văn bản) và PDF scan (hình ảnh) bằng **PaddleOCR chạy trực tiếp trên máy chủ riêng** (Windows 10 ở nhà hoặc máy chủ dự phòng MacBook Pro 2017 CPU Intel), tự động kiểm tra tính toàn vẹn toán học, phát hiện hóa đơn trùng lặp và xuất bảng kê vào đúng cấu trúc file Excel mẫu (`.xlsx`) do người dùng cung cấp.

---

## 1. Sơ Đồ Kiến Trúc Hệ Thống

```text
+-----------------------------------------------------------------------------------+
|                        THIẾT BỊ NGƯỜI DÙNG (CLIENT)                               |
|  - Máy tính Windows tại nơi làm việc / Laptop / iPhone (Safari iOS)               |
|  - Không cần cài Python hay thư viện OCR trên máy khách                           |
|  - Giao diện tĩnh React + TypeScript (triển khai trên Cloudflare Pages hoặc LAN)  |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          | HTTPS + Header Xác Thực (X-API-Token)
                                          | Kết nối an toàn qua Cloudflare Tunnel
                                          v (Không mở port trực tiếp trên Router)
+-----------------------------------------------------------------------------------+
|               MÁY CHỦ RIÊNG TẠI NHÀ (WINDOWS 10 / MACBOOK PRO 2017 INTEL)         |
|                                                                                   |
|  [ FastAPI Server (127.0.0.1:8000) ]                                              |
|     |-- 1. Xác thực API Token (auth.py) & Giới hạn dung lượng/số file             |
|     |-- 2. Kiểm tra chữ ký %PDF- thực tế & Mã băm SHA-256 (pdf_processor.py)     |
|     |-- 3. Phân tích từng trang PDF bằng PyMuPDF (fitz):                          |
|     |       +-- Trang có lớp văn bản chuẩn ---> Trích xuất trực tiếp (0 giây OCR) |
|     |       +-- Trang scan / ảnh / lỗi font -> Render PNG 200 DPI (từng trang)    |
|     |                                                 |                           |
|     |                                                 v                           |
|     |                                    [ PaddleOCR Engine CPU ]                 |
|     |                                    - use_angle_cls=True (chống xoay 90/180) |
|     |                                    - lang='vi' / 'en'                       |
|     |                                    - Gom hộp chữ theo hàng ngang (Y-coord)  |
|     |-- 4. Bộ trích xuất hóa đơn (invoice_extractor.py):                          |
|     |       - Phân vùng Seller Zone vs Buyer Zone (không nhầm MST mua/bán)        |
|     |-- 5. Kiểm tra & Phát hiện trùng (validator.py):                             |
|     |       - Kiểm tra MST, Ngày, Tiền trước thuế - CK + Thuế = Tổng tiền         |
|     |       - Cảnh báo trùng SHA-256, trùng Số HĐ + MST, hoặc nghi ngờ trùng      |
|     |-- 6. Xuất Excel theo mẫu (excel_exporter.py - openpyxl):                    |
|     |       - Giữ nguyên sheet, dòng tiêu đề, định dạng ô và công thức có sẵn     |
|     +-- 7. Xóa tự động toàn bộ file PDF tạm sau khi xử lý & che MST trong log     |
+-----------------------------------------------------------------------------------+
```

---

## 2. Cấu Trúc Thư Mục Dự Án

```text
/
├── backend/                        # Mã nguồn Backend Python + FastAPI + PaddleOCR
│   ├── .env.example                # Mẫu cấu hình biến môi trường máy chủ
│   ├── requirements.txt            # Phiên bản thư viện đã kiểm chứng cho Win10 & Mac Intel
│   ├── app/
│   │   ├── __init__.py
│   │   ├── config.py               # Cấu hình giới hạn file, DPI, timeout, dọn file tạm
│   │   ├── logger.py               # Ghi log an toàn (tự động che giấu MST trên log)
│   │   ├── auth.py                 # Xác thực X-API-Token bằng hmac.compare_digest
│   │   ├── models.py               # Cấu trúc dữ liệu hóa đơn, tọa độ OCR, lỗi kiểm tra
│   │   ├── pdf_processor.py        # Kiểm tra %PDF-, đọc text layer & render ảnh từng trang
│   │   ├── ocr_engine.py           # Khởi tạo và gọi PaddleOCR thật + gom dòng tọa độ
│   │   ├── invoice_extractor.py    # Trích xuất trường hóa đơn (tách vùng Bán / Mua)
│   │   ├── validator.py            # Kiểm tra MST, công thức cộng tiền & phát hiện trùng
│   │   ├── excel_exporter.py       # Đọc cấu trúc mẫu Excel và xuất bảng kê bằng openpyxl
│   │   ├── task_manager.py         # Quản lý hàng đợi 20-100 file, tiến độ, hủy tác vụ
│   │   └── main.py                 # Ứng dụng FastAPI và các REST API endpoints
│   └── tests/
│       └── test_invoice_pipeline.py # Bộ kiểm thử tự động cho Backend Python
├── scripts/                        # Kịch bản cài đặt, chạy và dừng máy chủ thuận tiện
│   ├── setup_win10.bat             # Tự động tạo venv và cài đặt trên Windows 10
│   ├── start_server_win10.bat      # Khởi động máy chủ FastAPI + PaddleOCR trên Windows 10
│   ├── stop_server_win10.bat       # Dừng máy chủ trên cổng 8000 và xóa sạch file tạm
│   └── start_server_mac_intel.sh   # Khởi động máy chủ dự phòng trên MacBook Pro 2017 Intel
├── docs/
│   └── DEPLOYMENT_AND_SECURITY.md  # Tài liệu Cloudflare Tunnel, Cloudflare Pages, Sao lưu & Quay lui
├── src/                            # Mã nguồn Frontend React + TypeScript
│   ├── types/invoice.ts            # Kiểu dữ liệu TypeScript đồng bộ với Backend
│   ├── utils/invoiceLogic.ts       # Logic kiểm tra, phát hiện trùng, phân tích mẫu & tạo PDF mẫu
│   ├── utils/invoiceLogic.test.ts  # Bộ kiểm thử đơn vị (node:test) cho Frontend
│   ├── components/                 # Các thành phần giao diện (Upload, Bảng dữ liệu, Sửa, Excel, Docs)
│   └── App.tsx                     # Giao diện chính tương thích Windows & iPhone Safari
├── server.ts                       # Máy chủ Express phục vụ giao diện & cầu nối API
└── package.json
```

---

## 3. Lý Do Chọn Phiên Bản Thư Viện (Tương Thích Windows 10 & MacBook Pro 2017 Intel)

| Thành phần | Phiên bản chọn | Lý do kỹ thuật & tương thích |
| :--- | :--- | :--- |
| **Python** | `3.10.11` (64-bit) | Phiên bản ổn định nhất có sẵn gói cài đặt biên dịch sẵn (pre-built wheels) của `paddlepaddle` cho cả Windows 10 x86_64 và macOS Intel x86_64. |
| **PaddlePaddle** | `paddlepaddle==2.6.2` | Bản CPU ổn định, chạy tốt trên CPU Intel đời 6–10 (bao gồm MacBook Pro 2017 Core i5/i7) mà không đòi hỏi GPU NVIDIA hay tập lệnh AVX-512. |
| **PaddleOCR** | `paddleocr==2.8.1` | Hỗ trợ đầy đủ `use_angle_cls=True` (xoay trang) và `lang='vi'`/`'en'`, không gặp lỗi xung đột pipeline mới của PaddleX 3.0 beta trên Windows. |
| **NumPy** | `numpy==1.26.4` | Ghim dưới `2.0.0` để tránh lỗi `AttributeError / ABI incompatibility` với `opencv-python-headless` và `paddleocr 2.8.1`. |
| **PyMuPDF** | `PyMuPDF==1.24.10` | Trích xuất lớp văn bản cực nhanh và render trang PDF thành ảnh PNG ở 200 DPI mà **không cần cài đặt Poppler rời** trên Windows 10. |
| **openpyxl** | `openpyxl==3.1.5` | Giữ nguyên các sheet, định dạng màu sắc/viền ô và công thức khi ghi dữ liệu vào file Excel mẫu `.xlsx`. |

---

## 4. Hướng Dẫn Cài Đặt Từ Đầu Trên Windows 10

### Bước 1: Cài đặt Python 3.10 (64-bit) và Microsoft Visual C++ Redistributable
1. Tải và cài đặt **Microsoft Visual C++ Redistributable 2015–2022 (x64)** từ trang chủ Microsoft (bắt buộc để `paddlepaddle` và `opencv` nạp thư viện `.dll` trên Windows 10).
2. Tải **Python 3.10.11 (Windows installer 64-bit)** từ `python.org`.
3. Khi chạy bộ cài đặt Python, **bắt buộc tích chọn ô `"Add Python 3.10 to PATH"`** trước khi nhấn *Install Now*.

### Bước 2: Chạy kịch bản cài đặt tự động
1. Giải nén thư mục dự án vào ổ đĩa (ví dụ `C:\VNInvoiceOCR` — nên chọn đường dẫn không dấu để tránh lỗi đường dẫn C++ của OpenCV).
2. Nhấp đúp vào file `scripts\setup_win10.bat`.
   - Kịch bản sẽ tự động tạo môi trường ảo `.venv`, nâng cấp `pip`, cài đặt đúng các phiên bản trong `backend\requirements.txt` và tạo file `backend\.env`.
3. Mở file `backend\.env` bằng Notepad và đặt một chuỗi mật khẩu bảo mật cho biến `APP_API_TOKEN` (ví dụ: `APP_API_TOKEN=MatKhauRiengCuaBan2026`).

### Bước 3: Khởi động và Dừng máy chủ
- **Khởi động máy chủ**: Nhấp đúp vào `scripts\start_server_win10.bat`. Lần chạy đầu tiên, PaddleOCR sẽ tự động tải mô hình nhận dạng chữ (`det`, `rec`, `cls` khoảng ~15MB) vào thư mục `~/.paddleocr/`.
- **Kiểm tra hoạt động**: Mở trình duyệt truy cập `http://127.0.0.1:8000/api/health`.
- **Dừng máy chủ & xóa file tạm**: Nhấp đúp vào `scripts\stop_server_win10.bat`.

---

## 5. Danh Sách Rõ Ràng Các Giới Hạn Thực Tế (Assumptions & Limitations)

1. **Giới hạn độ chính xác OCR tiếng Việt**: Mô hình đa ngôn ngữ Latin/Việt (`lang='vi'`) của PaddleOCR nhận diện rất tốt chữ số, mã số thuế, số hóa đơn, ngày tháng và tên công ty in hoa, nhưng với hóa đơn giấy in kim/giấy nhiệt bị nhòe hoặc phông chữ nghệ thuật có thể nhầm lẫn một số dấu thanh tiếng Việt. Ứng dụng luôn đánh dấu các trường độ tin cậy `< 85%` để người dùng xác minh.
2. **Không thay thế xác thực chữ ký số pháp lý**: Ứng dụng kiểm tra định dạng MST và công thức toán học để hỗ trợ kế toán nhập liệu, **không** kiểm tra hiệu lực chứng thư số XML/CA trên hệ thống Tổng cục Thuế.
3. **Phụ thuộc trạng thái bật của máy chủ riêng**: Khi truy cập từ iPhone hoặc máy tính văn phòng qua Cloudflare Tunnel, máy tính Windows 10 (hoặc MacBook Pro 2017 dự phòng) ở nhà **phải đang bật và chạy `start_server_win10.bat`**. Nếu máy chủ tắt, giao diện sẽ báo mất kết nối rõ ràng và hiển thị nút thử lại.
4. **Giới hạn định dạng Excel mẫu**: Hỗ trợ định dạng chuẩn `.xlsx` (Excel 2007 trở lên). Nếu file mẫu cũ đang ở định dạng `.xls` (Excel 97-2003), người dùng cần mở bằng Excel và chọn *Save As -> Excel Workbook (.xlsx)* trước khi tải lên.
