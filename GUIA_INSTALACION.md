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
2. El script creará el entorno virtual de Python e instalará todas las librerías necesarias.
3. Para iniciar el sistema, haz doble clic en **`start.bat`**.

---

## 3. 🔍 Cómo Descubrir la IP de la Cámara en la Casa del Vecino

El sistema cuenta con un escáner automático de red integrado. 

1. Conecta la cámara Wi-Fi o Ethernet a la misma red de la casa.
2. Inicia el sistema y abre en el navegador:
   * **`http://localhost:5001`** (desde la misma máquina) o **`http://<IP_LOCAL>:5001`** (desde cualquier PC o celular en la casa).
3. El escáner ONVIF detectará automáticamente cualquier cámara presente en la red local enviando un sondeo multicast estándar (`239.255.255.250:3702`).
4. También puedes usar herramientas gratuitas para celular como **Fing** o **ONVIF Device Manager** (Windows) para ver la IP asignada (ej. `192.168.1.50`).

---

## 4. 📹 Protocolos y URLs RTSP para Diferentes Marcas de Cámaras

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

## 5. 💾 Cómo Configurar Dónde Guardar las Grabaciones

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

## 6. 📱 Visualización en Celulares con Cero Lag

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
