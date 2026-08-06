@echo off
color 0a
title Installing Demo Dependencies
echo =========================================================================
echo  Preparing the Handwriting Word Counter Demo...
echo =========================================================================
echo.

python --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0c
    echo [ERROR] Python is not installed or not in the system PATH!
    echo Please install Python 3.10+ from python.org and check "Add to PATH".
    pause
    exit /b
)

echo [1/3] Python detected. Creating isolated Virtual Environment...
if not exist "venv" (
    python -m venv venv
)

echo [2/3] Activating environment...
call venv\Scripts\activate.bat

echo [3/3] Installing dependencies. This will take just a few minutes...
pip install -r requirements.txt

echo.
echo =========================================================================
echo  SUCCESS! Initialization Complete!
echo  You may now close this window and double-click "RUN_DEMO.bat"
echo =========================================================================
pause
