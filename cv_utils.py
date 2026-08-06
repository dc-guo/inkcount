import cv2
import numpy as np

def preprocess_image(image_path: str) -> np.ndarray:
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image successfully at: {image_path}")
        
    h, w = img.shape[:2]
    if w > 2000:
        ratio = 2000 / w
        img = cv2.resize(img, (2000, int(h * ratio)), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    
    gaussian_blur = cv2.GaussianBlur(enhanced, (9, 9), 10.0)
    sharpened = cv2.addWeighted(enhanced, 1.5, gaussian_blur, -0.5, 0)
    
    return sharpened

def extract_line_bounding_boxes(preprocessed_img: np.ndarray):
    debug_imgs = {}
    debug_stats = {}
    
    img_h, img_w = preprocessed_img.shape[:2]
    
    blur = cv2.GaussianBlur(preprocessed_img, (5, 5), 0)
    adaptive_thresh = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
        cv2.THRESH_BINARY_INV, 31, 15
    )
    chosen_thresh = adaptive_thresh
    debug_imgs["Thresholded (Adaptive Inv)"] = chosen_thresh.copy()
    
    # Kept raw contour engine strictly for red-box fragments visual debug only 
    kernel_width = max(10, int(img_w * 0.05)) 
    kernel_height = max(2, int(img_h * 0.002))
    rect_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_width, kernel_height))
    dilated = cv2.dilate(chosen_thresh, rect_kernel, iterations=2)
    debug_imgs["Dilated Matrix"] = dilated.copy()
    
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    debug_stats["Raw Contours Found"] = len(contours)
    
    raw_boxes = []
    min_h = max(3, int(img_h * 0.001))
    min_w = max(10, int(img_w * 0.005))
    
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w >= min_w and h >= min_h:
            raw_boxes.append((x, y, w, h))
            
    raw_boxes.sort(key=lambda box: box[1])

    # -------------------------------------------------------------
    # BRAND NEW: FULL-PAGE HORIZONTAL PROJECTION ALGORITHM NATIVELY
    # -------------------------------------------------------------
    
    # 1. Sum pixels across every exact row (Axis 1 natively explicitly cleanly strictly globally tracking cleanly directly)
    h_proj = np.sum(chosen_thresh, axis=1) 
    
    # 2. Smooth the projection natively tracking bounds avoiding false dots breaking rows directly explicitly safely
    smooth_kernel_size = max(5, int(img_h * 0.015))
    smoothed_proj = np.convolve(h_proj, np.ones(smooth_kernel_size)/smooth_kernel_size, mode='same')
    
    # 3. Peak/Valley mathematics natively isolating ink explicitly
    noise_thresh = max(np.max(smoothed_proj) * 0.05, 255 * 5) # 5 full pixel density limit mathematically locally efficiently
    
    is_in_peak = False
    peak_start = 0
    peaks = []
    
    for row_idx in range(img_h):
        if smoothed_proj[row_idx] > noise_thresh:
            if not is_in_peak:
                is_in_peak = True
                peak_start = row_idx
        else:
            if is_in_peak:
                is_in_peak = False
                peak_end = row_idx
                peaks.append((peak_start, peak_end))
                
    if is_in_peak:
        peaks.append((peak_start, img_h))
        
    merged_boxes = []
    original_bands = []
    
    # 4. Global Margins natively mapping securely independently identically exclusively 
    global_x_min = 5
    global_x_max = img_w - 5
    if len(raw_boxes) > 0:
        global_x_min = min(b[0] for b in raw_boxes)
        global_x_max = max(b[0] + b[2] for b in raw_boxes)
    global_w = global_x_max - global_x_min
    
    # 5. Build Final Arrays purely off Valley dropouts cleanly 
    for (p_start, p_end) in peaks:
        h = p_end - p_start
        if h < max(15, int(img_h * 0.005)): # Explicit tiny phantom row execution securely blocking natively directly organically
            continue
            
        original_bands.append((global_x_min, p_start, global_w, h))
        
        # Explicit small vertical pad retaining natively explicitly 
        pad_y = max(4, int(h * 0.15))
        y_final = max(0, p_start - pad_y)
        h_final = h + pad_y * 2
        
        merged_boxes.append((global_x_min, y_final, global_w, h_final))
        
    debug_stats["Merged Lines"] = len(merged_boxes)
    
    return merged_boxes, raw_boxes, debug_imgs, debug_stats, original_bands

def extract_word_clusters(line_bgr_img: np.ndarray):
    """
    Takes a single row crop explicitly and executes fine-tuned secondary morphology targeting distinct geometric word breaks natively.
    Returns: Word cluster boxes, painted visual array, raw threshold, and dilation masks.
    """
    if line_bgr_img.size == 0:
        return [], line_bgr_img, line_bgr_img, line_bgr_img
        
    gray = cv2.cvtColor(line_bgr_img, cv2.COLOR_BGR2GRAY)
    
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    thresh = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
        cv2.THRESH_BINARY_INV, 21, 10
    )
    
    h, w = line_bgr_img.shape[:2]
    
    kernel_w = max(6, int(w * 0.008)) 
    kernel_h = max(2, int(h * 0.06))
    
    rect_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, kernel_h))
    dilated = cv2.dilate(thresh, rect_kernel, iterations=1)
    
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    word_boxes = []
    min_w = max(4, int(h * 0.1)) 
    min_h = max(4, int(h * 0.15))
    
    for c in contours:
        x_c, y_c, w_c, h_c = cv2.boundingRect(c)
        if w_c >= min_w and h_c >= min_h:
            
            if w_c > w * 0.25:
                roi_thresh = thresh[y_c:y_c+h_c, x_c:x_c+w_c]
                v_proj = np.sum(roi_thresh, axis=0) 
                
                splits = []
                in_gap = False
                gap_start = 0
                for col_idx in range(w_c):
                    if v_proj[col_idx] == 0: 
                        if not in_gap:
                            in_gap = True
                            gap_start = col_idx
                    else:
                        if in_gap:
                            in_gap = False
                            gap_width = col_idx - gap_start
                            if gap_width >= max(3, int(w * 0.003)):
                                split_x = gap_start + gap_width // 2
                                splits.append(split_x)
                                
                if splits:
                    current_x = 0
                    for split in splits:
                        sub_w = split - current_x
                        if sub_w >= min_w:
                            word_boxes.append((x_c + current_x, y_c, sub_w, h_c))
                        current_x = split
                        
                    sub_w = w_c - current_x
                    if sub_w >= min_w:
                        word_boxes.append((x_c + current_x, y_c, sub_w, h_c))
                    continue 
                    
            word_boxes.append((x_c, y_c, w_c, h_c))
            
    word_boxes.sort(key=lambda b: b[0])
    
    preview = line_bgr_img.copy()
    thickness = max(1, int(h * 0.03))
    
    for (box_x, box_y, box_w, box_h) in word_boxes:
        cv2.rectangle(preview, (box_x, box_y), (box_x + box_w, box_y + box_h), (0, 0, 255), thickness)
        
    return word_boxes, preview, thresh, dilated

def draw_segmentation_preview(original_img: np.ndarray, raw_boxes: list, merged_boxes: list, original_bands: list) -> np.ndarray:
    preview = original_img.copy()
    overlay = preview.copy()
    thickness = max(2, int(preview.shape[0]*0.003))
    
    for (x, y, w, h) in original_bands:
        cv2.rectangle(overlay, (0, y), (preview.shape[1], y + h), (0, 150, 255), -1)
    cv2.addWeighted(overlay, 0.2, preview, 0.8, 0, preview)
    
    for (x, y, w, h) in raw_boxes:
        cv2.rectangle(preview, (x, y), (x + w, y + h), (255, 0, 0), max(1, thickness//2))
        
    for idx, (x, y, w, h) in enumerate(merged_boxes):
        cv2.rectangle(preview, (x, y), (x + w, y + h), (0, 255, 0), thickness * 2)
        cv2.putText(
            preview, f"Line {idx+1} ({w}px x {h}px)", (x, max(15, y - max(5, thickness*2))), 
            cv2.FONT_HERSHEY_SIMPLEX, max(0.6, thickness * 0.5), 
            (0, 255, 0), thickness
        )
    return preview
