import os
import cv2
import numpy as np
import threading
import time
import logging
from collections import deque

logger = logging.getLogger(__name__)

# Configuración nativa y limpia para RTSP sobre TCP (soporte óptimo H.264 y HEVC/H.265 sin pantalla gris)
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"


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
        self._worker_thread = None
        self._start_stream()

    def _start_stream(self):
        def stream_worker():
            while self.running:
                try:
                    logger.info(f"Conectando a RTSP: {self.rtsp_url}")
                    
                    self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                    self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                    if not self.cap.isOpened():
                        logger.warning(f"No se pudo conectar al stream RTSP ({self.rtsp_url}). Reintentando en 2s...")
                        with self.lock:
                            self.connected = False
                            self.fps = 0.0
                        time.sleep(2)
                        continue

                    logger.info(f"✅ Conexión RTSP establecida exitosamente: {self.rtsp_url}")
                    with self.lock:
                        self.connected = True
                    self.last_frame_time = time.time()

                    while self.running and self.connected and self.cap:
                        ret = self.cap.grab()
                        if not ret:
                            if time.time() - self.last_frame_time > 15.0:
                                logger.warning(f"Pérdida de señal RTSP (timeout de 15s en grab): {self.rtsp_url}")
                                break
                            time.sleep(0.01)
                            continue

                        ret, frame = self.cap.retrieve()
                        if not ret or frame is None or getattr(frame, 'size', 0) == 0:
                            if time.time() - self.last_frame_time > 15.0:
                                logger.warning(f"Fallo al recuperar frame RTSP (timeout de 15s en retrieve): {self.rtsp_url}")
                                break
                            time.sleep(0.01)
                            continue

                        now = time.time()
                        self.last_frame_time = now
                        self.frame_count += 1

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

                        time.sleep(0.003)

                except Exception as e:
                    logger.error(f"Error en stream_worker ({self.rtsp_url}): {e}")

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
                    time.sleep(2.0)

        self._worker_thread = threading.Thread(target=stream_worker, daemon=True, name=f"stream-{self.rtsp_url[:20]}")
        self._worker_thread.start()

    def read(self):
        """Retorna el frame más reciente de manera instantánea y segura."""
        with self.lock:
            if self.frame is not None and (time.time() - self.last_frame_time < 12.0):
                return self.frame
            return None

    def read_with_count(self):
        """Retorna el frame más reciente junto con su número de secuencia."""
        with self.lock:
            if self.frame is not None and (time.time() - self.last_frame_time < 12.0):
                return self.frame, self.frame_count
            return None, 0

    def is_connected(self):
        """Verifica si la cámara está activa y transmitiendo frames en tiempo real."""
        with self.lock:
            return self.connected and (time.time() - self.last_frame_time < 12.0)

    def get_resolution(self):
        """Retorna la resolución nativa actual del stream."""
        with self.lock:
            return {'width': self.width, 'height': self.height}

    def get_fps(self):
        """Retorna los FPS calculados del stream."""
        with self.lock:
            if not self.connected or (time.time() - self.last_frame_time > 8.0):
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
