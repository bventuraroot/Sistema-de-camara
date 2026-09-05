# 📘 Guía de Instalación y Despliegue Portable (CCTV Multi-Cámara con IA)

Esta guía explica cómo instalar y levantar este sistema de seguridad en la computadora de un vecino, familiar o cliente (compatible con **macOS**, **Windows** y **Linux**).

---

## 1. 🖥️ Requisitos del Sistema

### Hardware Recomendado
| Componente | Mínimo | Recomendado |
| :--- | :--- | :--- |
| **Procesador (CPU)** | 4 núcleos (Intel Core i5 / AMD Ryzen 5 / Apple Silicon M1) | 6+ núcleos (Intel i7, Ryzen 7, Apple M2/M3/M4) |
| **Memoria RAM** | 4 GB | 8 GB o más |
| **Almacenamiento** | 20 GB libres en disco | Disco Duro Externo o SSD de 250 GB+ dedicado a grabaciones |
| **Red** | Wi-Fi 2.4/5 GHz de buena cobertura | Cable de red Ethernet al router para la computadora servidora |

### Software Necesario (Pre-requisitos)
1. **Python:** Versión **3.10**, **3.11** o **3.12** ([python.org](https://www.python.org/downloads/)).
   * *En Windows:* Asegurarse de marcar la casilla **"Add Python to PATH"** al instalar.
2. **FFmpeg:** Necesario para el guardado de clips MP4 y multiplexación de audio.
   * *En Mac:* `brew install ffmpeg`
   * *En Ubuntu/Debian:* `sudo apt update && sudo apt install -y ffmpeg`
   * *En Windows:* Descargar desde [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) o con `winget install Gyan.FFmpeg`.
3. **Git:** Opcional (para descargar o clonar el código).

---

## 2. ⚡ Instalación Rápida con Un Clic

### En macOS o Linux:
1. Abre una Terminal en la carpeta del proyecto.
2. Ejecuta el script de instalación automática:
   ```bash
   chmod +x setup_vecino.sh
   ./setup_vecino.sh
   ```
3. Para iniciar el sistema:
   ```bash
   ./start.sh
   ```

### En Windows:
1. Haz doble clic en el archivo **`setup_vecino.bat`**.
2. El script detectará los núcleos de tu procesador y te ofrecerá elegir entre:
   * **Modo Auto / Recomendado**
   * **Modo NVR Ligero** (Solo Grabador y Visor, descarga rápida ~50MB sin PyTorch)
   * **Modo Completo con IA** (YOLOv8 + PyTorch)
3. Para iniciar el sistema, haz doble clic en **`start.bat`**.

---

## 3. 🧠 Auto-Acomodación de Hardware y Modos del Sistema

El sistema incorpora un **motor de auto-diagnóstico** (`SystemProfiler`) que analiza la CPU, RAM, GPU y dependencias instaladas en el equipo para protegerlo de saturaciones y garantizar que grabe sin interrupciones.

| Perfil de Operación | Hardware Típico | Funciones Habilitadas | Consumo de CPU |
| :--- | :--- | :--- | :--- |
| **⚡ Modo NVR Ligero** | PCs antiguas, 2 núcleos, <4 GB RAM, o sin PyTorch | 📼 Grabación 24/7, 🎬 Grabación por Movimiento (OpenCV), 📱 Visor Web y Celular | Mínimo (~1% a 3%) |
| **⚖️ Modo Equilibrado** | 4 a 6 núcleos, 4-8 GB RAM (CPU pura) | Todo lo anterior + 🎯 Filtro IA bajo demanda (solo analiza al haber movimiento) | Moderado (~10% a 20%) |
| **🚀 Alto Rendimiento** | Apple Silicon (MPS), GPU NVIDIA (CUDA) o 8+ núcleos | Todo lo anterior + 🧠 Inferencia neuronal continua (YOLOv8) + 🔄 Auto-Tracking PTZ | Óptimo con acelerador |

### ¿Cómo saber qué funciones tienes disponibles en tu equipo?
1. En la parte superior de la pantalla principal verás el botón **`[PERFIL]`** con el modo activo (ej. `⚡ NVR Ligero` o `🚀 IA Acelerada`).
2. Haz clic en el botón o en la barra lateral en **"⚙️ Ajustar Modo"**:
   * Verás el diagnóstico exacto de tu hardware (núcleos de procesador, RAM libre, gráfica).
   * Verás la lista de funciones soportadas y habilitadas con su explicación técnica.
   * Puedes alternar entre **Automático, Ligero, Equilibrado o Alto Rendimiento** en caliente con un solo clic.

---

## 4. 🔍 Analizador de Red y Detección Automática de IPs de Cámaras

Si la cámara **cambió de IP por DHCP**, se reinició el Router, o no sabes qué IP tiene:

### Opción A: Desde el Panel Web (1 Clic)
1. Abre el panel en tu navegador: **`http://localhost:5001`** (o desde tu celular `http://<IP_LOCAL>:5001`).
2. En la barra superior, haz clic en el botón **`[RED 🔍 Analizar IPs]`**.
3. Haz clic en **"⚡ Escanear Red Ahora"**:
   - El sistema enviará sondas ONVIF UDP y escaneará los puertos de video (`554`, `8899`, `80`, `5000`, etc.) en toda tu red local en ~2 segundos.
   - Mostrará las cámaras encontradas, su IP exacta, marca (iCam365, iCSee, Yoosee, Dahua, etc.) y latencia.
   - Puedes hacer clic en **"🧪 Probar Video"** para verificar que responde.
   - Haz clic en **"📌 Asignar a Cámara 1"** o **"📌 Asignar a Cámara 2"** para reconectarla **al instante sin reiniciar el sistema**.

### Opción B: Desde la Terminal o Script Rápido
- **En macOS / Linux:**
  ```bash
  ./escanear_ips.sh
  ```
- **En Windows:**
  Haz doble clic en **`escanear_ips.bat`** (o ejecuta `python escanear_ips.py`).

---

## 5. 📹 Protocolos y URLs RTSP para Diferentes Marcas de Cámaras

Copia y pega la plantilla correspondiente en el archivo `config/settings.json` o configúrala en el panel:

### A. Cámaras iCam365 / EyePlus / Ginatex
* **URL RTSP:** `rtsp://admin:admin@<IP_CAMARA>:554/live/ch0`
* **Sub-stream ligero:** `rtsp://admin:admin@<IP_CAMARA>:554/live/ch1`
* **Puerto ONVIF PTZ:** `80` (Usuario: `admin`, Clave: `admin`)

### B. Cámaras Chinas Baratas (Xiongmai / iCSee / XMeye / XM)
* Son las cámaras genéricas más vendidas en MercadoLibre y AliExpress.
* **URL RTSP:** `rtsp://admin:<CLAVE>@<IP_CAMARA>:554/stream0`
* **Puerto ONVIF:** `8899`
* *Nota:* En la app iCSee, verifica en *Configuración -> Red* si RTSP viene activo.

### C. Cámaras Yoosee / CooCam / Bombillo Inteligente
* **URL RTSP:** `rtsp://admin:<CLAVE_RTSP>@<IP_CAMARA>:554/onvif1`
* **Puerto ONVIF:** `5000`
* *Nota:* En la app Yoosee, ve a *Configuración -> Conexiones de terceros / RTSP*, actívalo y define una clave (por ejemplo `123456`).

### D. Cámaras CamHi / HiSilicon
* **URL RTSP:** `rtsp://admin:admin@<IP_CAMARA>:554/11`
* **Puerto ONVIF:** `8080` o `80`

### E. Cámaras Dahua / Imou
* **URL RTSP:** `rtsp://admin:<CLAVE_DEVICE>@<IP_CAMARA>:554/cam/realmonitor?channel=1&subtype=0`

### F. Cámaras Hikvision / Ezviz
* **URL RTSP:** `rtsp://admin:<CODIGO_VERIFICACION>@<IP_CAMARA>:554/Streaming/Channels/101`

### G. Cualquier Cámara ONVIF Genérica
* **URL RTSP:** `rtsp://usuario:clave@<IP_CAMARA>:554/` (o según documentación del fabricante).

---

## 6. 💾 Cómo Configurar Dónde Guardar las Grabaciones

El sistema es **100% portable**. Para que el vecino guarde sus videos en su propio disco, edita el archivo `config/settings.json`:

```json
{
  "storage_path": "C:/Mis_Grabaciones_CCTV",
  "motion_threshold": 10500,
  "confidence_threshold": 0.65,
  ...
}
```

### Ejemplos de rutas según el Sistema Operativo:
* **En Windows:** `"C:/CCTV_Grabaciones"` o `"D:/Seguridad"`
* **En Mac:** `"/Users/nombre_usuario/Grabaciones"` o `"/Volumes/MiDiscoExterno/Grabaciones"`
* **En Linux:** `"/home/usuario/recordings"` o `"/mnt/disco_seguridad"`
* **Ruta relativa dentro de la misma carpeta:** `"./recordings"`

Si la carpeta no existe, el sistema la creará automáticamente al iniciar.

---

## 7. 📱 Visualización en Celulares con Cero Lag

Para ver las cámaras desde cualquier teléfono dentro de la casa sin retraso de video:
1. Conecta el teléfono al Wi-Fi de la casa.
2. Abre en el navegador del teléfono:
   ```
   http://<IP_DE_LA_MAQUINA>:5001/m
   ```
3. Se abrirá la **Interfaz Móvil Dedicada (`/m`)**:
   * Video en vivo acelerado por GPU Canvas (30 a 50 milisegundos de latencia).
   * Control de giro táctil (D-Pad).
   * Cambio de cámara instantáneo.
   * Acceso rápido a capturas y grabaciones.
