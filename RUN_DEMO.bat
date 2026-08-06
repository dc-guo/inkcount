@echo off
color 0b
title Handwriting Demo
echo =========================================================================
echo  Launching the Handwriting Word Counter Demo Engine!
echo =========================================================================
echo.

if not exist "venv\Scripts\activate.bat" (
    color 0c
    echo [ERROR] Could not find the Virtual Environment!
    echo Please run INSTALL_DEMO.bat first so it can download the dependencies!
    pause
    exit /b
)

call venv\Scripts\activate.bat

echo =========================================================================
echo [IMPORTANT] DO NOT CLOSE THIS WINDOW WHILE PRESENTING!
echo It keeps the internal AI math engine running natively.
echo =========================================================================
echo.
echo Launching Streamlit interface...
echo (If the browser acts up, simply open Chrome and type: http://localhost:8501)
echo.

start "" "http://localhost:8501"
streamlit run app.py
