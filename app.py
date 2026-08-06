import streamlit as st
import os
import tempfile
import cv2
from PIL import Image

try:
    from cv_utils import preprocess_image
except ImportError:
    st.error("Missing cv_utils.py module.")
    preprocess_image = None

st.set_page_config(page_title="Notes Word Counter", page_icon="📝", layout="centered")

SAMPLE_DIR = "samples"

# -------------------------------------------------------------
# EXPLICIT SESSION STATE MANAGER
# -------------------------------------------------------------
if 'active_image_source' not in st.session_state:
    st.session_state.active_image_source = None
if 'active_image_path' not in st.session_state:
    st.session_state.active_image_path = None
if 'active_image_name' not in st.session_state:
    st.session_state.active_image_name = None
if 'uploader_key' not in st.session_state:
    st.session_state.uploader_key = 0

def reset_state():
    st.session_state.active_image_source = None
    st.session_state.active_image_path = None
    st.session_state.active_image_name = None
    st.session_state.uploader_key += 1
    if 'checkpoint2_passed' in st.session_state:
        del st.session_state.checkpoint2_passed

os.makedirs(SAMPLE_DIR, exist_ok=True)
samples = ["None"] + [f for f in os.listdir(SAMPLE_DIR) if f.endswith(('.png', '.jpg', '.jpeg'))]

if len(samples) == 1:
    from PIL import ImageDraw
    def create_demo_image(filename, text, bg_color, text_color):
        img = Image.new('RGB', (600, 200), color=bg_color)
        d = ImageDraw.Draw(img)
        d.text((20, 20), text, fill=text_color)
        img.resize((1800, 600), Image.NEAREST).save(os.path.join(SAMPLE_DIR, filename))
    
    create_demo_image("demo_meeting.jpg", "Meeting Notes\n- Execute Geometric Tracking Loop\n- Map OpenCV Gap Mathematics", (255, 255, 255), (0, 0, 0))
    create_demo_image("demo_lecture.jpg", "Psychology 101 Lecture:\nThe cognitive behavioral paradigm emphasizes how thoughts\ninfluence feelings and actions.", (245, 245, 240), (20, 20, 100))
    samples = ["None"] + [f for f in os.listdir(SAMPLE_DIR) if f.endswith(('.png', '.jpg', '.jpeg'))]

# -------------------------------------------------------------
# SIDEBAR
# -------------------------------------------------------------
with st.sidebar:
    st.header("⚙️ Configuration")
    target_words = st.number_input("Minimum Required Words", min_value=1, value=31, step=10)
    st.divider()
    if st.button("🔄 Reset / Clear Demo", use_container_width=True, type="secondary"):
        reset_state()
        st.rerun()

# -------------------------------------------------------------
# MAIN APP HEADER
# -------------------------------------------------------------
st.title("📝 HW Word Cluster Engine (OpenCV CV)")
st.warning("🚧 **Active Deployment:** True-Ink Bounding Optimization Engine")

# -------------------------------------------------------------
# STRICT INPUT EVENT HANDLERS
# -------------------------------------------------------------
def handle_upload():
    uploaded_file = st.session_state.get(f"uploader_{st.session_state.uploader_key}")
    if uploaded_file:
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp:
            tmp.write(uploaded_file.getvalue())
            st.session_state.active_image_path = tmp.name
        st.session_state.active_image_name = uploaded_file.name
        st.session_state.active_image_source = "Uploaded File"
        st.session_state.sample_selector = "None"
        if 'checkpoint2_passed' in st.session_state: del st.session_state.checkpoint2_passed
    else:
        if st.session_state.active_image_source == "Uploaded File":
            reset_state()

def handle_sample():
    choice = st.session_state.sample_selector
    if choice and choice != "None":
        st.session_state.active_image_path = os.path.join(SAMPLE_DIR, choice)
        st.session_state.active_image_name = choice
        st.session_state.active_image_source = "Built-in Sample"
        st.session_state.uploader_key += 1
        if 'checkpoint2_passed' in st.session_state: del st.session_state.checkpoint2_passed
    elif choice == "None" and st.session_state.active_image_source == "Built-in Sample":
        reset_state()

st.subheader("Image Input Selection")
col1, col2 = st.columns(2)
with col1:
    st.file_uploader(
        "Upload Note (JPG/PNG)", 
        type=["jpg", "jpeg", "png"], 
        key=f"uploader_{st.session_state.uploader_key}", 
        on_change=handle_upload
    )
with col2:
    st.selectbox("Or Try a Sample Note", samples, key="sample_selector", on_change=handle_sample)

st.divider()

# -------------------------------------------------------------
# VALIDATION RUNNER UI
# -------------------------------------------------------------
st.subheader("🔍 Automated Mathematical Core")

if st.session_state.active_image_path and os.path.exists(st.session_state.active_image_path):
    orig_img = Image.open(st.session_state.active_image_path)
    width, height = orig_img.size
    
    st.markdown(f"**Loaded Signature:** `{st.session_state.active_image_source}` | `{st.session_state.active_image_name}` | `{width} x {height} px`")
    
    if preprocess_image:
        if st.button("➡️ Step 1: Execute Document Line Segmentation", type="primary"):
            with st.spinner("Locking Mathematical Thresholds, Dilations, and Row Contours..."):
                try:
                    processed_mat = preprocess_image(st.session_state.active_image_path)
                    from cv_utils import extract_line_bounding_boxes, draw_segmentation_preview
                    merged_boxes, raw_boxes, debug_images, debug_stats, original_bands = extract_line_bounding_boxes(processed_mat)
                    
                    cv_orig = cv2.imread(st.session_state.active_image_path)
                    h, w = cv_orig.shape[:2]
                    if w > 2000:
                        ratio = 2000 / w
                        cv_orig = cv2.resize(cv_orig, (2000, int(h * ratio)), interpolation=cv2.INTER_AREA)

                    cv_orig_rgb = cv2.cvtColor(cv_orig, cv2.COLOR_BGR2RGB)
                    preview_mat = draw_segmentation_preview(cv_orig_rgb, raw_boxes, merged_boxes, original_bands)
                    
                    st.session_state.checkpoint2_passed = True
                    st.session_state.merged_boxes = merged_boxes
                    st.session_state.cv_orig_rgb = cv_orig_rgb
                    st.session_state.preview_mat = preview_mat
                    st.session_state.debug_images = debug_images
                    st.session_state.debug_stats = debug_stats
                    
                    st.rerun()
                except Exception as e:
                    st.error(f"OpenCV Segmentation Error: {e}")
        
        # -------------------------------------------------------------
        # CLUSTER ARCHITECTURE DEPLOYMENT
        # -------------------------------------------------------------
        if st.session_state.get('checkpoint2_passed'):
            debug_stats = st.session_state.debug_stats
            debug_images = st.session_state.debug_images
            preview_mat = st.session_state.preview_mat
            merged_boxes = st.session_state.merged_boxes
            cv_orig_rgb = st.session_state.cv_orig_rgb
            
            with st.expander("🛠️ View Global Row-Level Mathematics", expanded=False):
                st.info("🟠 Orange overlay represents the initial flawed spatial bounds natively. 🟢 Green limits confirm the explicit TRUE INK physical bounds explicitly re-centered seamlessly natively.")
                st.image(preview_mat, use_container_width=True, channels="RGB")

            if len(merged_boxes) > 0:
                
                st.divider()
                st.subheader("🧮 Secondary Core: OpenCV Geometric Space Tracker")
                
                if st.button("➡️ Step 2: Read Full Page & Evaluate Physical Word Count", type="primary"):
                    
                    from cv_utils import extract_word_clusters
                    import time
                    
                    status_text = st.empty()
                    progress_bar = st.progress(0)
                    
                    try:
                        master_lines_data = [] 
                        total_word_count = 0
                        h_img, w_img = cv_orig_rgb.shape[:2]
                        
                        start_time = time.time()
                        
                        for idx, box in enumerate(merged_boxes):
                            status_text.text(f"Executing Spatial Geometric Analysis: Line {idx+1} of {len(merged_boxes)}...")
                            x, y, w, h = box
                            
                            # Safely explicitly lock identical natively avoiding redundant app padding dropping crops exclusively securely natively locally mapping cleanly
                            y1, y2 = max(0, y), min(h_img, y + h)
                            x1, x2 = max(0, x), min(w_img, x + w)

                            line_crop_mat = cv_orig_rgb[y1:y2, x1:x2]
                            c_img_h, c_img_w = line_crop_mat.shape[:2]
                            
                            word_boxes, preview_crop_mat, thresh_mat, dilated_mat = extract_word_clusters(line_crop_mat)
                            row_count = len(word_boxes)
                            total_word_count += row_count
                            
                            master_lines_data.append({
                                'crop_preview': Image.fromarray(preview_crop_mat),
                                'thresh': Image.fromarray(thresh_mat),
                                'dilated': Image.fromarray(dilated_mat),
                                'row_count': row_count,
                                'width': c_img_w,
                                'height': c_img_h
                            })
                            progress_bar.progress((idx + 1) / len(merged_boxes))
                            
                        end_time = time.time()
                        status_text.text(f"Geometric Processing Complete! Elapsed time: {round(end_time - start_time, 2)} seconds.")
                        
                        st.divider()
                        
                        # Full Fast Tracking Results Output Layer
                        col1, col2 = st.columns(2)
                        is_pass = total_word_count >= target_words
                        
                        if is_pass:
                            col1.success(f"### 🎉 PASS\nTarget: **{target_words} words.** Tracked **{total_word_count} distinct clusters.**")
                        else:
                            col1.error(f"### ❌ FAIL\nTarget: **{target_words} words.** Tracked **{total_word_count} distinct clusters.**")
                            
                        col2.metric("Total Counted Objects", total_word_count, "Bypass Neural Inference Engine Active")
                        
                        # Visual Cluster Telemetry Diagnostics Map natively breaking down spatial thresholds dynamically
                        with st.expander("🔍 View Explicit Image Spatial Geometry Validation", expanded=True):
                            st.info("🔴 Thin Red Boxes cleanly expose the exact boundary points the algorithm evaluated mathematically across space constraints natively.")
                            for idx, line_data in enumerate(master_lines_data):
                                st.markdown(f"**Line {idx+1} Yield:** `{line_data['row_count']} distinct physical clusters mapped` (Dimensions: `{line_data['width']}w x {line_data['height']}h px`)")
                                
                                c1, c2, c3 = st.columns(3)
                                with c1:
                                    st.image(line_data['thresh'], use_container_width=True, caption="1. Pure Threshold")
                                with c2:
                                    st.image(line_data['dilated'], use_container_width=True, caption="2. Math Dilation Mask")
                                with c3:
                                    st.image(line_data['crop_preview'], use_container_width=True, caption="3. Final Geometric Output")
                                st.divider()
                                
                    except Exception as e:
                        st.error(f"Runtime Spatial Mathematics Crash: {e}")
            else:
                st.error("📉 FAILURE: 0 Master Rows mapped physically on this sheet!")
else:
    st.info("Upload an image actively above to securely view pipeline diagnostics.")
