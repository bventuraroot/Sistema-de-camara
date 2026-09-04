import os
import cv2
import numpy as np
import threading
import time
import logging
from collections import deque

logger = logging.getLogger(__name__)

# Configuración robusta para decodificación RTSP sobre TCP y soporte H.264/H.265
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|reorder_queue_size;100|analyzeduration;1000000|probesize;1000000|max_delay;500000"

class VideoStream:
    def __init__(self, rtsp_url):
        self.rtsp_url = rtsp_url
        self.frame = None
        self.connected = False
        self.lock = threading.Lock()
        self.cap = None
        self.width = 1920
        self.height = 1080
        self.fps = 0.0
        self.frame_count = 0
        self.last_frame_time = 0
        self._fps_timestamps = deque(maxlen=30)
        self.running = True
        self._start_stream()
    
    def _start_stream(self):
        def stream_worker():
            while self.running:
                try:
                    logger.info(f"Conectando a RTSP: {self.rtsp_url}")
                    
                    # Forzar opciones de red en OpenCV
                    self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                    self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    
                    if not self.cap.isOpened():
                        logger.warning(f"No se pudo conectar al stream RTSP ({self.rtsp_url}). Reintentando...")
                        self.connected = False
                        time.sleep(2)
                        continue
                    
                    logger.info("Conexión RTSP establecida exitosamente.")
                    self.connected = True
                    self.last_frame_time = time.time()
                    consecutive_failures = 0
                    
                    while self.running and self.connected and self.cap:
                        # Grab y retrieve para vaciar cualquier buffer interno y siempre tener el último frame
                        ret = self.cap.grab()
                        if not ret:
                            if time.time() - self.last_frame_time > 6.0:
                                logger.warning("Pérdida de señal RTSP (timeout de 6s), reconectando...")
                                break
                            time.sleep(0.02)
                            continue
                        
                        ret, frame = self.cap.retrieve()
                        if not ret or frame is None or getattr(frame, 'size', 0) == 0:
                            if time.time() - self.last_frame_time > 6.0:
                                logger.warning("Fallo al recuperar frame RTSP (timeout de 6s), reconectando...")
                                break
                            time.sleep(0.02)
                            continue
                        
                        consecutive_failures = 0
                        now = time.time()
                        self.last_frame_time = now
                        self.frame_count += 1
                        
                        # Cálculo de FPS en tiempo real
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
                        time.sleep(0.005)
                        
                except Exception as e:
                    logger.error(f"Error en stream_worker: {e}")
                
                finally:
                    with self.lock:
                        self.connected = False
                    if self.cap:
                        try:
                            self.cap.release()
                        except Exception:
                            pass
                        self.cap = None
                    time.sleep(1.5)
        
        thread = threading.Thread(target=stream_worker, daemon=True)
        thread.start()
    
    def read(self):
        """Retorna una copia del frame más reciente de manera instantánea y segura."""
        with self.lock:
            if self.frame is not None and (time.time() - self.last_frame_time < 6.0):
                return self.frame.copy()
            return None

    def read_with_count(self):
        """Retorna una copia del frame más reciente junto con su número de secuencia para evitar duplicados."""
        with self.lock:
            if self.frame is not None and (time.time() - self.last_frame_time < 6.0):
                return self.frame.copy(), self.frame_count
            return None, 0
    
    def is_connected(self):
        """Verifica si la cámara está activa y transmitiendo frames en tiempo real."""
        with self.lock:
            return self.connected and (time.time() - self.last_frame_time < 6.0)
    
    def get_resolution(self):
        """Retorna la resolución nativa actual del stream."""
        with self.lock:
            return {'width': self.width, 'height': self.height}
    
    def get_fps(self):
        """Retorna los FPS calculados del stream."""
        return self.fps
    
    def stop(self):
        self.running = False
        self.connected = False
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
