@echo off
chcp 65001 >nul
echo ======================================================
echo   🚀 Instalador Automático de Sistema CCTV Multi-IA   
echo ======================================================

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Error: Python no encontrado. Instala Python 3.10+ desde python.org y marca "Add Python to PATH".
    pause
    exit /b 1
)

echo ✅ Python detectado.
echo 📦 Creando entorno virtual de Python...
if not exist "venv" (
    python -m venv venv
)

echo 📥 Instalando librerías de Python...
call venv\Scripts\python.exe -m pip install --upgrade pip
call venv\Scripts\python.exe -m pip install -r requirements.txt

if not exist "config" mkdir config
if not exist "recordings" mkdir recordings

echo.
echo ======================================================
echo   🎉 ¡Instalación Completada en Windows!
echo   Para iniciar el sistema ejecuta: start.bat
echo ======================================================
pause
