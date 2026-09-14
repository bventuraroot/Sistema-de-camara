import os
import sys

# Configuración de alto rendimiento para RTSP sobre TCP (soporte óptimo H.264 y HEVC/H.265 sin latencia)
# Conexión instantánea (<1s) reduciendo analyzeduration y probesize de FFmpeg
CAPTURE_OPTIONS = (
    "rtsp_transport;tcp"
    "|analyzeduration;1000000"
    "|probesize;1048576"
    "|buffer_size;2097152"
    "|fflags;nobuffer"
    "|max_delay;500000"
    "|timeout;5000000"
    "|stimeout;5000000"
)
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = CAPTURE_OPTIONS
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "-8"
os.environ["OPENCV_LOG_LEVEL"] = "ERROR"

# En Windows, os.environ no actualiza getenv() en DLLs C Runtime (MSVCRT/UCRTBASE).
# Sincronizar explícitamente mediante _putenv en los C runtimes de Windows para que opencv_videoio_ffmpeg*.dll
# SIEMPRE fuerce TCP y nunca intente UDP ni espere el timeout de 30s.
if sys.platform == "win32":
    import ctypes
    for crt_name in ("msvcrt", "ucrtbase"):
        try:
            crt = getattr(ctypes.cdll, crt_name)
            crt._putenv(f"OPENCV_FFMPEG_CAPTURE_OPTIONS={CAPTURE_OPTIONS}".encode('ascii'))
            crt._putenv(b"OPENCV_FFMPEG_LOGLEVEL=-8")
            crt._putenv(b"OPENCV_LOG_LEVEL=ERROR")
        except Exception:
            pass

import cv2
try:
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except Exception:
    pass
import numpy as np
import threading
import time
import logging
from collections import deque

logger = logging.getLogger(__name__)


class VideoStream:
    def __init__(self, rtsp_url, fallback_url=None):
        self.primary_url = rtsp_url
        self.fallback_url = fallback_url
        self.rtsp_url = rtsp_url
        self.using_fallback = False
        self.frame = None
        self.connected = False
        self.lock = threading.Lock()
        self.cap = None
        self.width = 1280
        self.height = 720
        self.fps = 0.0
        self.frame_count = 0
        self.last_frame_time = 0
        self._fps_timestamps = deque(maxlen=30)
        self.running = True
        self.failed_primary_attempts = 0
        self.last_fallback_probe_time = 0
        self._worker_thread = None
        self._start_stream()

    def _start_stream(self):
        def stream_worker():
            # Parámetros nativos de timeout de OpenCV para evitar cuelgues de 30s en Windows
            # 10s da suficiente margen para handshake RTSP y esperar el primer I-frame sobre WiFi
            open_params = []
            if hasattr(cv2, 'CAP_PROP_OPEN_TIMEOUT_MSEC'):
                open_params.extend([cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000])
            if hasattr(cv2, 'CAP_PROP_READ_TIMEOUT_MSEC'):
                open_params.extend([cv2.CAP_PROP_READ_TIMEOUT_MSEC, 10000])

            while self.running:
                try:
                    # Si la URL primaria falló 2 veces y tenemos fallback, activar stream de respaldo
                    if self.failed_primary_attempts >= 2 and self.fallback_url and not self.using_fallback:
                        logger.warning(f"⚠️ Activando stream de respaldo (fallback) tras fallos en primario: {self.fallback_url}")
                        self.rtsp_url = self.fallback_url
                        self.using_fallback = True
                        self.last_fallback_probe_time = time.time()
                    # Si estamos en fallback, reintentar volver al stream primario (1080p) cada 300s (5 min)
                    # Esto evita el molesto ciclo de congelamiento cada 60s cuando la red de subida está saturada
                    elif self.using_fallback and (time.time() - self.last_fallback_probe_time > 300.0):
                        logger.info(f"🔄 Reintentando reconectar a stream primario (1080p): {self.primary_url}")
                        self.rtsp_url = self.primary_url
                        self.using_fallback = False
                        self.last_fallback_probe_time = time.time()

                    logger.info(f"Conectando a RTSP: {self.rtsp_url} (fallback={self.using_fallback})")
                    t0 = time.time()
                    if open_params:
                        try:
                            self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG, open_params)
                        except Exception:
                            self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                    else:
                        self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                    
                    if self.cap:
                        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                    if not self.cap or not self.cap.isOpened():
                        elapsed = round(time.time() - t0, 2)
                        logger.warning(f"No se pudo conectar al stream RTSP ({self.rtsp_url}, {elapsed}s). Reintentando...")
                        if not self.using_fallback:
                            self.failed_primary_attempts += 1
                        with self.lock:
                            self.connected = False
                            self.fps = 0.0
                        time.sleep(1.0)
                        continue

                    elapsed = round(time.time() - t0, 2)
                    logger.info(f"✅ Conexión RTSP establecida en {elapsed}s: {self.rtsp_url} (fallback={self.using_fallback})")

                    with self.lock:
                        self.connected = True
                    self.last_frame_time = time.time()
                    connect_time = time.time()
                    steady_frames = 0

                    # Bucle continuo con lectura atómica directa (evita desincronización de slices HEVC / H.265)
                    while self.running and self.cap:
                        ret, frame = self.cap.read()
                        if not ret or frame is None or getattr(frame, 'size', 0) == 0:
                            # Antes del primer frame, permitir hasta 15s para que la cámara emita su fotograma clave (I-frame / IDR)
                            timeout_limit = 6.0 if steady_frames > 0 else 15.0
                            if time.time() - self.last_frame_time > timeout_limit:
                                logger.warning(f"Pérdida de señal RTSP (timeout de {timeout_limit}s sin fotogramas): {self.rtsp_url}")
                                if not self.using_fallback and steady_frames < 30:
                                    self.failed_primary_attempts += 1
                                    logger.warning(f"⚠️ Fallo temprano en stream primario (intentos: {self.failed_primary_attempts}/2)")
                                break
                            time.sleep(0.015)
                            continue

                        now = time.time()
                        self.last_frame_time = now
                        self.frame_count += 1
                        steady_frames += 1

                        # Resetear contador de fallos tan pronto como el stream envíe frames estables
                        if not self.using_fallback and self.failed_primary_attempts > 0 and steady_frames >= 15:
                            self.failed_primary_attempts = 0

                        self._fps_timestamps.append(now)
                        if len(self._fps_timestamps) > 1:
                            duration = self._fps_timestamps[-1] - self._fps_timestamps[0]
                            if duration > 0:
                                self.fps = round((len(self._fps_timestamps) - 1) / duration, 1)

                        h, w = frame.shape[:2]
                        if h > 0 and w > 0:
                            with self.lock:
                                self.width = w
                                self.height = h
                                self.frame = frame
                                self.connected = True

                except Exception as e:
                    logger.error(f"Error en stream_worker ({self.rtsp_url}): {e}")
                    if not self.using_fallback:
                        self.failed_primary_attempts += 1

                finally:
                    with self.lock:
                        self.connected = False
                        self.fps = 0.0
                    if self.cap:
                        try:
                            self.cap.release()
                        except Exception:
                            pass
                        self.cap = None
                    time.sleep(1.0)

        self._worker_thread = threading.Thread(target=stream_worker, daemon=True, name=f"stream-{self.primary_url[:20]}")
        self._worker_thread.start()

    def read(self):
        """Retorna el frame más reciente de manera instantánea y segura."""
        with self.lock:
            if self.frame is not None and (time.time() - self.last_frame_time < 6.0):
                return self.frame
            return None

    def read_with_count(self):
        """Retorna el frame más reciente junto con su número de secuencia."""
        with self.lock:
            if self.frame is not None and (time.time() - self.last_frame_time < 6.0):
                return self.frame, self.frame_count
            return None, 0

    def is_connected(self):
        """Verifica si la cámara está activa y transmitiendo frames en tiempo real."""
        with self.lock:
            grace = 6.0 if self.frame_count > 0 else 15.0
            return self.connected and (time.time() - self.last_frame_time < grace)

    def get_resolution(self):
        """Retorna la resolución nativa actual del stream."""
        with self.lock:
            return {'width': self.width, 'height': self.height}

    def get_fps(self):
        """Retorna los FPS calculados del stream."""
        with self.lock:
            if not self.connected or (time.time() - self.last_frame_time > 4.0):
                return 0.0
            return self.fps

    def is_using_fallback(self):
        return self.using_fallback

    def stop(self):
        self.running = False
        with self.lock:
            self.connected = False
            self.fps = 0.0
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None

