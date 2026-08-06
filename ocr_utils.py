import streamlit as st
import warnings
import string
import re

warnings.filterwarnings("ignore")
import logging
logging.getLogger("transformers").setLevel(logging.ERROR)

from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from PIL import Image

@st.cache_resource(show_spinner=False)
def load_trocr_model():
    """
    Downloads and caches the TrOCR-Small weights natively safely.
    """
    processor = TrOCRProcessor.from_pretrained("microsoft/trocr-small-handwritten")
    model = VisionEncoderDecoderModel.from_pretrained("microsoft/trocr-small-handwritten")
    return processor, model

def normalize_trocr_crop(image: Image.Image) -> Image.Image:
    """
    Normalizes the image aspect ratio natively by padding the background with white space vertically.
    Prevents the HuggingFace DeiT vision transformer from horizontally squishing extreme wide-lines explicitly.
    """
    if image.mode != "RGB":
        image = image.convert("RGB")
        
    width, height = image.size
    
    # Target an aspect ratio ceiling around 1:3 natively to prevent severe microscopic stretching
    target_height = max(height, int(width / 3.5)) 
    
    if target_height > height:
        # Expand canvas aggressively using standard document white backgrounds
        new_img = Image.new("RGB", (width, target_height), (255, 255, 255))
        offset = (0, (target_height - height) // 2)
        new_img.paste(image, offset)
        return new_img
        
    return image

def infer_text_from_image(image: Image.Image, processor, model) -> str:
    """ Executes DL inference seamlessly strictly against the properly aspect-normalized PIL frames. """
    pixel_values = processor(image, return_tensors="pt").pixel_values
    generated_ids = model.generate(pixel_values, max_new_tokens=60) 
    generated_text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
    return generated_text.strip()

def clean_and_count_line(raw_text: str):
    """
    Heuristic cleanup applying STRICT alphabetic token validation algorithms.
    Drops numeric noise ("0000") securely mapped against invalid TrOCR artifacts.
    Returns: cleaned_text, word_count, is_flagged_garbage
    """
    text = raw_text.lower()
    
    # Eliminate ONLY the extreme mathematical hallucinations safely dropping artifacts natively
    hallucinations = ["displaystyle", "\\displaystyle", "\\frac", "mathbf", "\\cdot", "\\sum", "\\int"]
    for h in hallucinations:
        text = text.replace(h, "")
        
    # Map standard punctuation into spaces splitting tokens properly natively
    translator = str.maketrans(string.punctuation, ' ' * len(string.punctuation))
    clean_str = text.translate(translator)
    
    raw_words = clean_str.split()
    processed_words = []
    
    for w in raw_words:
        # CRITICAL FILTER: Valid words MUST contain at least one alphabetical character [a-z] natively cleanly
        if not re.search(r'[a-z]', w):
            continue
            
        # Ignore strictly obvious identical character stutter bugs natively tracking DL loops
        if len(set(w)) == 1 and len(w) > 3:
            continue
            
        processed_words.append(w)
        
    cleaned_line = " ".join(processed_words)
    count = len(processed_words)
    
    flagged = False
    
    # Flag gracefully but DO NOT strip absolute lines explicitly mapping visual feedback UI limits
    if "displaystyle" in raw_text.lower() or (len(raw_words) > 5 and count < 2):
        flagged = True
        
    return cleaned_line, count, flagged
