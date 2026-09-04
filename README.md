# Sistema de Cámaras Inteligente (IA Core)

Sistema de monitoreo de video en tiempo real de alta velocidad con análisis inteligente de movimiento mediante Inteligencia Artificial (YOLOv8) y acceso en red local.

---

## Características Principales

- **Transmisión Fluida en Tiempo Real**: Arquitectura desacoplada sin latencia (< 200 ms) a 25-30 FPS nativos con decodificación TCP y `nobuffer`.
- **Análisis de Movimiento con IA**: Detección cruzada con YOLOv8 para identificar si el movimiento proviene de **personas, vehículos o mascotas**, filtrando falsas alarmas (hojas, viento, sombras).
- **Aceleración por Hardware**: Soporte nativo para Apple Silicon GPU (`MPS`) y CPU multi-núcleo.
- **Acceso Local / WiFi**: Compatible con cualquier navegador en teléfonos móviles (iPhone/Android), tablets y computadoras dentro de la misma red local.
- **Capturas y Grabación Local**: Guardado automático de fotos ante eventos y grabación de video en disco duro.
- **Panel Web Glassmorphism**: Interfaz moderna, oscura, responsiva, con estadísticas en vivo y modal de previsualización de capturas.

---

## Acceso Rápido

1. Asegúrate de que el contenedor de la cámara esté activo:
   ```bash
   docker compose up -d tuya-bridge
   ```
2. Inicia el sistema:
   ```bash
   ./start.sh
   ```
3. Abre tu navegador:
   - **En esta computadora:** [http://localhost:5001](http://localhost:5001)
   - **En tu celular u otro dispositivo en la red WiFi:** `http://<TU_IP_LOCAL>:5001` (por ejemplo: `http://192.168.1.5:5001`)

---

## 🛑 Cómo Apagar y Encender el Sistema (Día / Noche)

- **Para APAGAR todo por completo (cero consumo de CPU/Batería):**
  - **Opción 1:** En la terminal ejecuta:
    ```bash
    ./stop.sh
    ```
  - **Opción 2:** En la barra superior del panel web ([http://localhost:5001](http://localhost:5001) o desde tu celular), haz clic en el botón rojo **"🛑 Apagar"**.
- **Para VOLVER A ENCENDERLO (por las noches):**
  ```bash
  ./start.sh
  ```

---

## Controles del Panel Web

- **🎯 Modo Solo Eventos / 📼 24/7:** Alterna entre el **Modo Solo Eventos** (ahorro extremo de recursos: el disco no escribe nada mientras no haya actividad y solo graba clips cuando la IA detecta a alguien) y la **Grabación Continua 24/7**.
- **👁️ Movimiento:** Activa o desactiva la detección de movimiento en escena.
- **🧠 IA YOLOv8:** Enciende o apaga las cajas delimitadoras neuronales en tiempo real.
- **🎯 Filtro IA:** Cuando está activo, ignora sombras y movimiento ambiental; **solo genera alertas si detecta personas, vehículos o mascotas**.
- **📸 Captura:** Toma una foto en alta resolución de manera instantánea.
- **🔄 Auto-Tracking IA:** La cámara gira automáticamente (pan/tilt) para seguir a personas, vehículos o mascotas cuando la IA detecte una alerta de atención activa.
- **🕹️ Control Manual PTZ (Cruceta D-Pad):** Permite girar la cámara hacia arriba, abajo, izquierda y derecha manteniendo presionados los botones táctiles desde tu teléfono o computadora.
- **🔔 Sonido:** Emite un tono discreto en el navegador cuando se detecta una persona.
- **Pestañas de Registro:**
  - **`📋 Alertas`:** Registro en vivo de fotos y eventos detectados.
  - **`🎬 Videos de Eventos`:** Clips de video MP4 grabados durante cada detección con pre-buffer de 2s.
  - **`📼 24/7`:** Videos continuos grabados en bloques de 5 minutos.