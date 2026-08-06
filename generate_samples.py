import os
from PIL import Image, ImageDraw

os.makedirs('samples', exist_ok=True)

def create_demo_image(filename, text, bg_color, text_color):
    # We create a small image, draw the text using PIL's tiny default font, 
    # and scale the image up drastically to make it legible and easy for OCR.
    img = Image.new('RGB', (450, 150), color=bg_color)
    d = ImageDraw.Draw(img)
    d.text((10, 10), text, fill=text_color)
    
    # Scale up using Nearest Neighbor to keep edges sharp for Tesseract
    img_large = img.resize((1800, 600), Image.NEAREST)
    img_large.save(os.path.join('samples', filename))

text1 = "Meeting Notes\n- Discuss MVP features\n- Add editable OCR text block\n- Ensure demo reliability with sample images."
create_demo_image("demo_meeting_notes.jpg", text1, (255, 255, 255), (0, 0, 0))

text2 = "Psychology 101 Lecture:\nThe cognitive behavioral paradigm emphasizes how thoughts \ninfluence feelings and actions. Today we reviewed several \ncase studies observing this phenomena in academic settings."
create_demo_image("demo_lecture_notes.jpg", text2, (245, 245, 240), (20, 20, 100))

print("Demo Sample images generated successfully in samples/ directory!")
