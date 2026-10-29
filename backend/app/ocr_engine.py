"""
Module tích hợp PaddleOCR chạy trực tiếp trên máy chủ riêng (Windows 10 CPU / macOS Intel CPU).
- Không sử dụng bất kỳ dịch vụ đám mây bên ngoài nào.
- Hỗ trợ nhận diện góc xoay (use_angle_cls=True), tiếng Việt (lang='vi') và tiếng Anh (lang='en').
- Có tiền xử lý ảnh cơ bản (tăng độ tương phản cho hóa đơn scan mờ) và sắp xếp dòng văn bản
  theo tọa độ từ trên xuống dưới, từ trái sang phải để giữ cấu trúc bảng hóa đơn.
"""
import io
from typing import List, Optional
from .models import OcrTextLine
from .config import settings
from .logger import logger


class PaddleOcrEngine:
    def __init__(self, lang: Optional[str] = None, use_gpu: Optional[bool] = None):
        self.lang = lang or settings.ocr_lang
        self.use_gpu = settings.use_gpu if use_gpu is None else use_gpu
        self.use_angle_cls = settings.use_angle_cls
        self._ocr = None
        self._init_error: Optional[str] = None

    def _ensure_initialized(self) -> None:
        if self._ocr is not None:
            return
        try:
            from paddleocr import PaddleOCR  # type: ignore
        except ImportError as exc:
            self._init_error = (
                "Không thể nạp thư viện PaddleOCR hoặc PaddlePaddle. "
                "Hãy kiểm tra đã kích hoạt môi trường ảo (venv) và cài đặt: "
                "pip install paddlepaddle==2.6.2 paddleocr==2.8.1. "
                f"Chi tiết lỗi: {exc}"
            )
            logger.error(self._init_error)
            raise RuntimeError(self._init_error) from exc

        try:
            logger.info(
                "Đang khởi tạo mô hình PaddleOCR (lang=%s, use_gpu=%s, use_angle_cls=%s)...",
                self.lang,
                self.use_gpu,
                self.use_angle_cls,
            )
            # Khởi tạo theo chuẩn PaddleOCR 2.8.x (tương thích Windows 10 CPU & macOS Intel)
            self._ocr = PaddleOCR(
                use_angle_cls=self.use_angle_cls,
                lang=self.lang,
                use_gpu=self.use_gpu,
                show_log=False,
            )
            self._init_error = None
        except TypeError:
            # Tương thích dự phòng nếu người dùng cài PaddleOCR 3.x (nơi một số tham số đổi tên)
            from paddleocr import PaddleOCR  # type: ignore
            self._ocr = PaddleOCR(
                use_doc_orientation_classify=self.use_angle_cls,
                lang=self.lang,
            )
            self._init_error = None
        except Exception as exc:
            self._init_error = f"Lỗi khi khởi tạo mô hình PaddleOCR: {exc}"
            logger.error(self._init_error)
            raise RuntimeError(self._init_error) from exc

    def check_status(self) -> dict:
        """Kiểm tra trạng thái cài đặt PaddleOCR và PaddlePaddle mà không cần ép tải model nặng nếu chưa gọi."""
        try:
            import paddle  # type: ignore
            import paddleocr  # type: ignore
            return {
                "installed": True,
                "paddle_version": getattr(paddle, "__version__", "unknown"),
                "paddleocr_version": getattr(paddleocr, "__version__", "unknown"),
                "lang": self.lang,
                "use_gpu": self.use_gpu,
                "model_loaded": self._ocr is not None,
                "error": self._init_error,
            }
        except ImportError as exc:
            return {
                "installed": False,
                "paddle_version": None,
                "paddleocr_version": None,
                "lang": self.lang,
                "use_gpu": self.use_gpu,
                "model_loaded": False,
                "error": f"Thiếu thư viện PaddleOCR/PaddlePaddle trên máy chủ: {exc}",
            }

    def recognize_image_bytes(self, image_bytes: bytes, page_num: int = 1) -> List[OcrTextLine]:
        """
        Nhận diện văn bản từ mảng byte ảnh PNG của một trang PDF.
        Bao gồm tiền xử lý tăng cường độ nét và gom dòng theo tọa độ Y.
        """
        self._ensure_initialized()
        try:
            import numpy as np  # type: ignore
            from PIL import Image, ImageOps, ImageEnhance  # type: ignore
        except ImportError as exc:
            raise RuntimeError(f"Thiếu thư viện xử lý ảnh Pillow / numpy: {exc}") from exc

        with Image.open(io.BytesIO(image_bytes)) as pil_img:
            rgb_img = pil_img.convert("RGB")
            # Tăng nhẹ độ tương phản để hỗ trợ hóa đơn scan mờ hoặc giấy nhiệt phai màu
            enhancer = ImageEnhance.Contrast(rgb_img)
            enhanced_img = enhancer.enhance(1.2)
            enhanced_img = ImageOps.autocontrast(enhanced_img, cutoff=1)
            img_np = np.array(enhanced_img)

        result = self._ocr.ocr(img_np, cls=self.use_angle_cls)
        raw_items: List[OcrTextLine] = []

        if not result:
            return raw_items

        # Trong PaddleOCR 2.x, result là danh sách theo trang: [ [ [bbox, (text, score)], ... ] ]
        page_boxes = result[0] if isinstance(result, list) and len(result) > 0 else []
        if not page_boxes:
            return raw_items

        for item in page_boxes:
            if not item or len(item) < 2:
                continue
            bbox = item[0]
            text_info = item[1]
            if isinstance(text_info, (list, tuple)) and len(text_info) >= 2:
                text = str(text_info[0]).strip()
                score = float(text_info[1])
                if text:
                    raw_items.append(
                        OcrTextLine(
                            text=text,
                            confidence=round(score, 4),
                            page=page_num,
                            bbox=bbox,
                            source="PADDLE_OCR",
                        )
                    )

        return self._merge_horizontal_boxes_into_lines(raw_items)

    @staticmethod
    def _merge_horizontal_boxes_into_lines(items: List[OcrTextLine], y_tolerance: float = 12.0) -> List[OcrTextLine]:
        """
        Gom các hộp chữ (bounding boxes) nằm trên cùng một hàng ngang thành một dòng văn bản
        từ trái sang phải để bộ trích xuất nhận diện chính xác cặp 'Nhãn: Giá trị' trên bảng hóa đơn.
        """
        if not items:
            return []

        def get_y_top(line: OcrTextLine) -> float:
            if line.bbox and len(line.bbox) >= 1:
                return float(line.bbox[0][1])
            return 0.0

        def get_x_left(line: OcrTextLine) -> float:
            if line.bbox and len(line.bbox) >= 1:
                return float(line.bbox[0][0])
            return 0.0

        sorted_by_y = sorted(items, key=lambda it: (it.page, get_y_top(it), get_x_left(it)))
        merged_lines: List[OcrTextLine] = []
        current_group: List[OcrTextLine] = [sorted_by_y[0]]

        for item in sorted_by_y[1:]:
            prev = current_group[-1]
            if item.page == prev.page and abs(get_y_top(item) - get_y_top(current_group[0])) <= y_tolerance:
                current_group.append(item)
            else:
                merged_lines.append(PaddleOcrEngine._combine_group(current_group))
                current_group = [item]

        if current_group:
            merged_lines.append(PaddleOcrEngine._combine_group(current_group))

        return merged_lines

    @staticmethod
    def _combine_group(group: List[OcrTextLine]) -> OcrTextLine:
        group_sorted = sorted(
            group,
            key=lambda it: float(it.bbox[0][0]) if it.bbox and len(it.bbox) >= 1 else 0.0,
        )
        combined_text = "   ".join(it.text for it in group_sorted)
        avg_conf = round(sum(it.confidence for it in group_sorted) / len(group_sorted), 4)
        first_bbox = group_sorted[0].bbox
        last_bbox = group_sorted[-1].bbox
        combined_bbox = first_bbox
        if first_bbox and last_bbox and len(first_bbox) == 4 and len(last_bbox) == 4:
            combined_bbox = [
                first_bbox[0],
                last_bbox[1],
                last_bbox[2],
                first_bbox[3],
            ]
        return OcrTextLine(
            text=combined_text,
            confidence=avg_conf,
            page=group_sorted[0].page,
            bbox=combined_bbox,
            source=group_sorted[0].source,
        )


ocr_engine = PaddleOcrEngine()
