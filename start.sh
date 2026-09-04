#!/bin/bash

# Script de inicio rápido para el Sistema de Cámaras Inteligente

echo "================================================="
echo "🎥 Sistema de Cámaras Inteligente (Auto-Acomodado)"
echo "================================================="

# Verificar que tuya-rtsp-bridge esté corriendo en Docker
if command -v docker &> /dev/null; then
    if ! docker ps | grep -E -q "tuya-rtsp-bridge|tuya-bridge"; then
        echo "⚠️  El contenedor Tuya Bridge no está activo."
        echo "Iniciando tuya-rtsp-bridge en Docker..."
        docker compose up -d tuya-bridge 2>/dev/null || docker start tuya-rtsp-bridge 2>/dev/null
        sleep 3
    else
        echo "✅ Bridge Tuya RTSP activo en Docker (:8554, :8787)"
        # Refrescar motor RTSP para asegurar que no haya sesiones huérfanas
        curl -s -m 2 -X POST http://127.0.0.1:8787/api/restart/rtsp > /dev/null 2>&1 || true
        sleep 2
    fi
fi

# Detectar IP local
LAN_IP=$(python3 -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); print(s.getsockname()[0]); s.close()" 2>/dev/null || echo "127.0.0.1")

echo ""
echo "🚀 Iniciando servidor de visión con IA (YOLOv8)..."
echo "💻 Acceso local:     http://localhost:5001"
echo "📱 Acceso WiFi/LAN:  http://${LAN_IP}:5001"
echo "================================================="
echo ""

# Ejecutar con el entorno virtual venv para aceleración GPU Apple Silicon (MPS)
if [ -f "./venv/bin/python" ]; then
    ./venv/bin/python app.py
else
    python3 app.py
fi
