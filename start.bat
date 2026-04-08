@echo off
echo ============================================
echo  Astro Analytics - Starting dev server...
echo ============================================
echo.

python --version >nul 2>&1
if %errorlevel% == 0 (
    start "" "http://localhost:8080"
    python serve.py
    goto end
)

python3 --version >nul 2>&1
if %errorlevel% == 0 (
    start "" "http://localhost:8080"
    python3 serve.py
    goto end
)

echo ERROR: Python not found. Please install Python 3.
echo Then run this script again.

:end
pause
