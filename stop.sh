#!/bin/bash

# ==============================================================================
# Script para Apagar por Completo el Sistema de Cámaras
# ==============================================================================

echo "================================================="
echo "🛑 Apagando Sistema de Cámaras Inteligente..."
echo "================================================="

# 1. Detener el servidor de IA y grabación (Python app.py)
PIDS=$(pgrep -f "python.*app.py")
if [ -n "$PIDS" ]; then
    echo "🔻 Deteniendo proceso del servidor de IA (PID: $PIDS)..."
    pkill -f "python.*app.py"
    sleep 1
    # Forzar si alguno quedó colgado
    pkill -9 -f "python.*app.py" 2>/dev/null
    echo "✅ Servidor de video e Inteligencia Artificial detenido."
else
    echo "ℹ️  El servidor de video ya estaba apagado."
fi

# 2. Detener contenedor Docker del Bridge Tuya
if command -v docker &> /dev/null; then
    if docker ps | grep -E -q "tuya-bridge|tuya-rtsp-bridge"; then
        echo "🔻 Deteniendo contenedor Docker Tuya Bridge..."
        docker stop tuya-rtsp-bridge tuya-bridge > /dev/null 2>&1
        docker compose stop tuya-bridge > /dev/null 2>&1
        echo "✅ Contenedor Docker detenido."
    else
        echo "ℹ️  El contenedor Docker ya estaba detenido."
    fi
fi

echo ""
echo "================================================="
echo "🌙 ¡Sistema apagado por completo! Cero consumo."
echo "💡 Para volver a encenderlo por la noche, ejecuta:"
echo "   ./start.sh"
echo "================================================="
