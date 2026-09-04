#!/usr/bin/env bash
set -e

echo "======================================================"
echo "  🚀 Instalador Automático de Sistema CCTV Multi-IA   "
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

# 4. Instalar Dependencias
echo "📥 Instalando dependencias de Python..."
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# 5. Crear carpetas de configuración y grabaciones locales por defecto
mkdir -p config
mkdir -p recordings

if [ ! -f "config/settings.json" ]; then
    echo "⚙️ Creando archivo de configuración inicial..."
    cat << 'EOF' > config/settings.json
{
  "storage_path": "./recordings",
  "motion_threshold": 10500,
  "confidence_threshold": 0.65,
  "ai_motion_only": false,
  "motion_detection": true,
  "object_detection": true,
  "continuous_recording": true,
  "auto_tracking": true,
  "cameras": {
    "cam1": {
      "id": "cam1",
      "name": "Cámara 1",
      "rtsp_url": "rtsp://admin:admin@192.168.1.50:554/live/ch0",
      "ptz": true,
      "motion_detection": true,
      "event_recording": true,
      "auto_tracking": true,
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
echo "  Para iniciar el sistema ejecuta:                    "
echo "  ./venv/bin/python app.py                            "
echo "======================================================"
