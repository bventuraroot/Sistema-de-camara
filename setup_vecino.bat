@echo off
chcp 65001 >nul
echo ======================================================
echo   🚀 Instalador Inteligente - Sistema CCTV Multi-Cámara
echo   Auto-Acomodación y Diagnóstico de Hardware (Windows)
echo ======================================================

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Error: Python no encontrado. Instala Python 3.10+ desde python.org y marca "Add Python to PATH".
    pause
    exit /b 1
)

echo ✅ Python detectado en el sistema.
echo 📦 Creando o verificando entorno virtual 'venv'...
if not exist "venv" (
    python -m venv venv
)

echo.
echo 🔍 Analizando recursos de esta computadora...
for /f "tokens=2 delims==" %%i in ('wmic cpu get NumberOfCores /value 2^>nul') do set CORES=%%i
if "%CORES%"=="" set CORES=2
echo    • CPU: %CORES% núcleos detectados.

echo.
echo ------------------------------------------------------
echo Elige el modo de instalación para esta computadora:
echo   1) [Recomendado] Auto-Detectar según hardware
echo   2) Modo NVR Ligero (Solo Grabación y Visor - Rápido, ~50MB, sin PyTorch)
echo   3) Modo Completo con IA (YOLOv8 + PyTorch)
echo ------------------------------------------------------
set /p USER_CHOICE="Ingresa tu opción [1-3] (Por defecto 1): "
if "%USER_CHOICE%"=="" set USER_CHOICE=1

set SELECTED_PROFILE=auto
set INSTALL_AI=true

if "%USER_CHOICE%"=="2" (
    set SELECTED_PROFILE=light
    set INSTALL_AI=false
    echo ⚡ Has seleccionado: Modo NVR Ligero (Sin IA).
)
if "%USER_CHOICE%"=="3" (
    set SELECTED_PROFILE=performance
    set INSTALL_AI=true
    echo 🧠 Has seleccionado: Modo Completo con IA.
)

echo.
echo 📥 Actualizando pip...
call venv\Scripts\python.exe -m pip install --upgrade pip --quiet

echo 📥 Instalando paquetes base del sistema (Servidor, Video, OpenCV)...
call venv\Scripts\python.exe -m pip install -r requirements-base.txt

if "%INSTALL_AI%"=="true" (
    echo 📥 Instalando módulo de Inteligencia Artificial (Ultralytics YOLO)...
    call venv\Scripts\python.exe -m pip install ultralytics
    if errorlevel 1 (
        echo.
        echo ⚠️ No se pudo instalar PyTorch en este equipo Windows.
        echo ✅ El sistema se auto-acomodará en 'Modo NVR Ligero' para garantizar que grabe sin problemas.
        set SELECTED_PROFILE=light
    )
)

if not exist "config" mkdir config
if not exist "recordings" mkdir recordings

echo.
echo ======================================================
echo   🎉 ¡Instalación Completada en Windows!
echo   Perfil asignado: %SELECTED_PROFILE%
echo   Para iniciar el sistema haz doble clic en: start.bat
echo ======================================================
pause
