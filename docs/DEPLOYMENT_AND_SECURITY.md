# Tài Liệu Kết Nối An Toàn Qua Mạng, Triển Khai Cloudflare & Sao Lưu / Quay Lui

---

## Phần 1: Kết Nối Từ Xa An Toàn Bằng Cloudflare Tunnel (Không Mở Cổng Router)

Để sử dụng ứng dụng từ **iPhone (4G/5G/Wi-Fi ngoài)** hoặc **máy tính tại nơi làm việc** kết nối về máy tính **Windows 10 ở nhà** mà không cần mở cổng (Port Forwarding) trên modem/router:

### 1. Luồng dữ liệu đi như thế nào?
- Khi bạn mở giao diện web trên iPhone hoặc máy tính công ty và chọn file PDF hóa đơn:
  1. Trình duyệt gửi file PDF qua kết nối mã hóa **HTTPS (TLS 1.3)** kèm header `X-API-Token` tới địa chỉ Cloudflare Tunnel của riêng bạn (ví dụ: `https://ocr-api.tenmiencuaban.com`).
  2. Dịch vụ `cloudflared` chạy ngầm trên máy Windows 10 ở nhà nhận dữ liệu qua đường hầm outbound và chuyển tiếp nội bộ vào `http://127.0.0.1:8000`.
  3. Toàn bộ quá trình đọc PDF và chạy PaddleOCR diễn ra 100% trên CPU máy Windows 10 ở nhà.
  4. Ngay sau khi trả kết quả JSON và xuất file Excel, file PDF tạm trên máy Windows 10 được xóa tự động.

### 2. Cài đặt Cloudflare Tunnel trên Windows 10
1. Tải `cloudflared-windows-amd64.exe` từ trang chính thức của Cloudflare và đổi tên thành `cloudflared.exe`.
2. Chạy thử nghiệm nhanh (Quick Tunnel miễn phí không cần tên miền riêng):
   ```bat
   cloudflared.exe tunnel --url http://127.0.0.1:8000
   ```
   Cloudflare sẽ cấp một đường dẫn dạng `https://xxxx-xxxx.trycloudflare.com`.
3. Dán đường dẫn HTTPS này và khóa `APP_API_TOKEN` vào mục **"Kết nối Máy chủ OCR"** trên giao diện ứng dụng (trên iPhone hoặc máy tính làm việc).
4. **Khuyến nghị cố định lâu dài**: Nếu có tên miền trên Cloudflare (miễn phí gói Free), vào *Cloudflare Zero Trust -> Networks -> Tunnels*, tạo một Named Tunnel trỏ `https://ocr-api.domaincuaban.com` về `http://127.0.0.1:8000` và bật thêm lớp **Cloudflare Access (Email OTP)** để bảo vệ kép.

---

## Phần 2: Triển Khai Giao Diện Tĩnh (Frontend) Lên Cloudflare Pages

Giao diện React + TypeScript được thiết kế tách biệt hoàn toàn với Backend, không chứa khóa bí mật trong mã nguồn và có thể triển khai miễn phí lên **Cloudflare Pages**:

1. Chạy lệnh kiểm tra và đóng gói giao diện tĩnh:
   ```bash
   npm install
   npm run build
   ```
   Kết quả biên dịch nằm trong thư mục `dist/`.
2. Đăng nhập vào [Cloudflare Dashboard](https://dash.cloudflare.com/) -> chọn **Workers & Pages** -> **Create application** -> **Pages** -> **Upload assets** (hoặc kết nối Git repository riêng tư).
3. Cấu hình thông số Build (nếu kết nối Git):
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. Sau khi triển khai, bạn có thể truy cập ứng dụng từ iPhone Safari qua địa chỉ `https://vn-invoice-ocr.pages.dev`, nhập địa chỉ Cloudflare Tunnel của máy chủ Windows 10 ở nhà và khóa `X-API-Token` để bắt đầu sử dụng.

---

## Phần 3: Hướng Dẫn Sao Lưu, Cập Nhật và Quay Lui Khi Lỗi (Backup & Rollback)

### 1. Sao lưu trước khi cập nhật
Trước khi nâng cấp phiên bản Python, thư viện hoặc mã nguồn:
1. Dừng máy chủ bằng `scripts\stop_server_win10.bat`.
2. Sao chép file cấu hình `backend\.env` và thư mục mẫu Excel của bạn ra một thư mục an toàn.
3. Xuất danh sách phiên bản thư viện hiện hành đang chạy ổn định:
   ```bat
   call .venv\Scripts\activate.bat
   pip freeze > backup_requirements_stable.txt
   ```

### 2. Quy trình cập nhật an toàn
1. Tạo bản sao thư mục dự án hiện tại (ví dụ: `C:\VNInvoiceOCR_Backup_2026_10`).
2. Cập nhật mã nguồn mới vào `C:\VNInvoiceOCR`.
3. Chạy bộ kiểm thử tự động trước khi đưa vào sử dụng:
   ```bat
   call .venv\Scripts\activate.bat
   python -m unittest backend/tests/test_invoice_pipeline.py -v
   ```

### 3. Quay lui (Rollback) khi gặp lỗi thư viện
Nếu sau khi cập nhật thư viện mới mà PaddleOCR hoặc PyMuPDF báo lỗi:
1. Chạy `scripts\stop_server_win10.bat`.
2. Xóa thư mục môi trường ảo bị lỗi:
   ```bat
   rmdir /s /q .venv
   ```
3. Khôi phục lại từ file `backend\requirements.txt` (hoặc `backup_requirements_stable.txt`) bằng cách chạy lại `scripts\setup_win10.bat`.
