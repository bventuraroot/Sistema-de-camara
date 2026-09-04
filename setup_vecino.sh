#!/usr/bin/env bash
set -e

echo "======================================================"
echo "  🚀 Instalador Inteligente - Sistema CCTV Multi-Cámara"
echo "  Auto-Acomodación y Diagnóstico de Hardware del PC   "
echo "======================================================"

# 1. Verificar Python 3
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYTHON_CMD="python"
else
    echo "❌ Error: Python no está instalado. Instala Python 3.10 o superior."
    exit 1
fi

PY_VERSION=$($PYTHON_CMD -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "✅ Python detectado: Versión $PY_VERSION"

# 2. Verificar FFmpeg
if command -v ffmpeg &>/dev/null; then
    echo "✅ FFmpeg detectado correctamente."
else
    echo "⚠️ Advertencia: FFmpeg no está en el PATH."
    echo "   En Mac: brew install ffmpeg"
    echo "   En Ubuntu/Debian: sudo apt install ffmpeg"
fi

# 3. Crear Entorno Virtual
if [ ! -d "venv" ]; then
    echo "📦 Creando entorno virtual 'venv'..."
    $PYTHON_CMD -m venv venv
fi

# 4. Diagnóstico Rápido de Hardware
echo ""
echo "🔍 Analizando recursos de esta computadora..."
HW_INFO=$(./venv/bin/python -c "
import os, platform
cores = os.cpu_count() or 1
os_name = platform.system()
is_apple = (os_name == 'Darwin' and platform.machine() == 'arm64')
print(f'{cores}|{is_apple}')
" 2>/dev/null || echo "2|False")

CORES=$(echo "$HW_INFO" | cut -d'|' -f1)
IS_APPLE=$(echo "$HW_INFO" | cut -d'|' -f2)

echo "   • CPU: $CORES núcleos detectados"
if [ "$IS_APPLE" = "True" ]; then
    echo "   • Aceleración Gráfica: Apple Silicon (Metal Performance Shaders / GPU)"
fi

SUGGESTED_MODE="1"
if [ "$CORES" -lt 4 ]; then
    echo "   ⚠️ Aviso: Esta PC tiene menos de 4 núcleos. Se recomienda el Modo NVR Ligero para evitar lentitud."
    SUGGESTED_MODE="2"
fi

echo ""
echo "------------------------------------------------------"
echo "Elige el modo de instalación para esta computadora:"
echo "  1) [Recomendado] Auto-Detectar según el hardware del PC"
echo "  2) Modo NVR Ligero (Solo Grabación y Visor - Rápido, ~50MB, sin PyTorch)"
echo "  3) Modo Completo con IA (YOLOv8 + PyTorch + Auto-Tracking)"
echo "------------------------------------------------------"

# Si se ejecuta sin tty interactiva o con parámetro, usar modo automático
if [ -t 0 ]; then
    read -p "Ingresa tu opción [1-3] (Por defecto 1): " USER_CHOICE
    USER_CHOICE=${USER_CHOICE:-1}
else
    USER_CHOICE="1"
fi

SELECTED_PROFILE="auto"
INSTALL_AI="true"

if [ "$USER_CHOICE" = "2" ]; then
    SELECTED_PROFILE="light"
    INSTALL_AI="false"
    echo "⚡ Has seleccionado: Modo NVR Ligero (Instalación ultrarrápida sin IA)."
elif [ "$USER_CHOICE" = "3" ]; then
    SELECTED_PROFILE="performance"
    INSTALL_AI="true"
    echo "🧠 Has seleccionado: Modo Completo con Inteligencia Artificial."
else
    if [ "$SUGGESTED_MODE" = "2" ]; then
        SELECTED_PROFILE="light"
        INSTALL_AI="false"
        echo "⚡ Hardware modesto detectado: Configurando en Modo NVR Ligero."
    else
        SELECTED_PROFILE="auto"
        INSTALL_AI="true"
        echo "🚀 Hardware suficiente: Configurando instalación automática con IA."
    fi
fi

# 5. Instalar dependencias
echo ""
echo "📥 Actualizando pip..."
./venv/bin/pip install --upgrade pip --quiet

echo "📥 Instalando paquetes base del sistema (Servidor, Video, OpenCV)..."
./venv/bin/pip install -r requirements-base.txt

if [ "$INSTALL_AI" = "true" ]; then
    echo "📥 Instalando módulo de Inteligencia Artificial (Ultralytics YOLO)..."
    if ./venv/bin/pip install ultralytics; then
        echo "✅ Módulo IA instalado exitosamente."
    else
        echo ""
        echo "⚠️ No se pudo instalar PyTorch/Ultralytics en este equipo (posible escasez de memoria o red)."
        echo "✅ ¡No te preocupes! El sistema se auto-acomodará en 'Modo NVR Ligero'."
        echo "   La grabación continua 24/7 y la detección de movimiento OpenCV funcionarán al 100%."
        SELECTED_PROFILE="light"
    fi
fi

# 6. Crear carpetas y configuración inicial
mkdir -p config
mkdir -p recordings

if [ ! -f "config/settings.json" ]; then
    echo "⚙️ Generando archivo de configuración con perfil '$SELECTED_PROFILE'..."
    cat << EOF > config/settings.json
{
  "system_profile": "$SELECTED_PROFILE",
  "storage_path": "./recordings",
  "motion_threshold": 10500,
  "confidence_threshold": 0.65,
  "ai_motion_only": false,
  "motion_detection": true,
  "object_detection": $([ "$SELECTED_PROFILE" = "light" ] && echo "false" || echo "true"),
  "continuous_recording": true,
  "auto_tracking": $([ "$SELECTED_PROFILE" = "light" ] && echo "false" || echo "true"),
  "cameras": {
    "cam1": {
      "id": "cam1",
      "name": "Cámara 1",
      "rtsp_url": "rtsp://admin:admin@192.168.1.50:554/live/ch0",
      "ptz": true,
      "motion_detection": true,
      "event_recording": true,
      "auto_tracking": $([ "$SELECTED_PROFILE" = "light" ] && echo "false" || echo "true"),
      "continuous_recording": true,
      "ai_filter": false,
      "motion_threshold": 10000,
      "home_return_delay": 15.0
    }
  }
}
EOF
fi

echo ""
echo "======================================================"
echo "  🎉 ¡Instalación Completada con Éxito!               "
echo "  Perfil asignado: $SELECTED_PROFILE                  "
echo "  Para iniciar el sistema ejecuta:                    "
echo "  ./start.sh   o   ./venv/bin/python app.py           "
echo "======================================================"
