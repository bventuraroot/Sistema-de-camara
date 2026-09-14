@echo off
chcp 65001 >nul
title Sistema CCTV Multi-Camara Inteligente
echo ==================================================
echo   🛡️  SISTEMA DE SEGURIDAD CCTV MULTI-CAMARA
echo ==================================================

:: Forzar protocolo RTSP sobre TCP en OpenCV y FFmpeg (evita perdida de paquetes y caidas en Windows)
set "OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp|analyzeduration;1000000|probesize;1048576|buffer_size;2097152|fflags;nobuffer|max_delay;500000|timeout;5000000|stimeout;5000000"
set "OPENCV_FFMPEG_LOGLEVEL=-8"
set "OPENCV_LOG_LEVEL=ERROR"

echo [1/2] Verificando entorno Python...
if exist venv\Scripts\python.exe (
    set "PY_BIN=venv\Scripts\python.exe"
) else if exist .venv\Scripts\python.exe (
    set "PY_BIN=.venv\Scripts\python.exe"
) else (
    set "PY_BIN=python"
)

echo [2/2] Iniciando servidor NVR y detector con: %PY_BIN%
echo.
%PY_BIN% app.py

pause
