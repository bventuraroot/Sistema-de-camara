import os
import cv2
import numpy as np
import threading
import time
import logging
from collections import deque

logger = logging.getLogger(__name__)

# Configuración robusta para decodificación RTSP sobre TCP y soporte H.264/H.265
# stimeout: timeout de socket en microsegundos (3s) para evitar bloqueos indefinidos
# timeout: timeout de conexión/lectura en microsegundos (5s)
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
    "rtsp_transport;tcp|"
    "stimeout;3000000|"
    "timeout;5000000|"
    "reorder_queue_size;100|"
    "analyzeduration;1000000|"
    "probesize;1000000|"
    "max_delay;500000"
)

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
        self.width = 1920
        self.height = 1080
        self.fps = 0.0
        self.frame_count = 0
        self.last_frame_time = 0
        self._fps_timestamps = deque(maxlen=30)
        self.running = True
        # Contador de fallos consecutivos en la URL actual para decidir fallback
        self._consecutive_connect_failures = 0
        # Tiempo del último intento de recuperar la URL primaria
        self._last_primary_probe = 0
        # Intervalo entre sondeos de recuperación de la URL primaria (segundos)
        self._primary_probe_interval = 120
        self._start_stream()
    
    def _try_open_capture(self, url):
        """Intenta abrir una captura RTSP. Retorna True si el stream se abrió y entrega al menos 1 frame."""
        try:
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                try:
                    cap.release()
                except Exception:
                    pass
                return None
            
            # Verificar que realmente entrega frames (evitar streams fantasma con width=0)
            deadline = time.time() + 4.0
            while time.time() < deadline:
                ret = cap.grab()
                if ret:
                    ret2, test_frame = cap.retrieve()
                    if ret2 and test_frame is not None and getattr(test_frame, 'size', 0) > 0:
                        h, w = test_frame.shape[:2]
                        if w > 0 and h > 0:
                            return cap
                time.sleep(0.1)
            
            # No entregó frames válidos
            try:
                cap.release()
            except Exception:
                pass
            return None
        except Exception:
            return None

    def _start_stream(self):
        def stream_worker():
            while self.running:
                try:
                    current_url = self.rtsp_url
                    logger.info(f"Conectando a RTSP: {current_url}" +
                                (" [FALLBACK SD]" if self.using_fallback else ""))
                    
                    cap = self._try_open_capture(current_url)
                    
                    if cap is None:
                        self._consecutive_connect_failures += 1
                        logger.warning(
                            f"No se pudo conectar al stream RTSP ({current_url}). "
                            f"Fallo #{self._consecutive_connect_failures}. Reintentando..."
                        )
                        
                        # Si hay fallback y ya fallamos 2+ veces en la URL primaria, conmutar
                        if (self.fallback_url and
                                not self.using_fallback and
                                self._consecutive_connect_failures >= 2):
                            logger.warning(
                                f"⚠️ Conmutando a stream de respaldo (SD): {self.fallback_url}"
                            )
                            self.rtsp_url = self.fallback_url
                            self.using_fallback = True
                            self._consecutive_connect_failures = 0
                            self._last_primary_probe = time.time()
                        
                        with self.lock:
                            self.connected = False
                        time.sleep(2)
                        continue
                    
                    # Conexión exitosa
                    self.cap = cap
                    self._consecutive_connect_failures = 0
                    logger.info(
                        f"Conexión RTSP establecida exitosamente" +
                        (" [SD/Fallback]" if self.using_fallback else " [HD/Primaria]") + "."
                    )
                    self.connected = True
                    self.last_frame_time = time.time()
                    
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
                        
                        # Sondeo periódico: si estamos en fallback, intentar volver a primaria
                        if (self.using_fallback and
                                self.fallback_url and
                                now - self._last_primary_probe > self._primary_probe_interval):
                            self._last_primary_probe = now
                            self._probe_primary_in_background()
                        
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
                    
                    # Si se desconectó mientras usamos primaria, intentar fallback
                    if (self.fallback_url and
                            not self.using_fallback and
                            self._consecutive_connect_failures >= 1):
                        self._consecutive_connect_failures += 1
                        if self._consecutive_connect_failures >= 2:
                            logger.warning(
                                f"⚠️ Conmutando a stream de respaldo (SD) tras desconexión: {self.fallback_url}"
                            )
                            self.rtsp_url = self.fallback_url
                            self.using_fallback = True
                            self._consecutive_connect_failures = 0
                            self._last_primary_probe = time.time()
                    else:
                        self._consecutive_connect_failures += 1
                    
                    time.sleep(1.5)
        
        thread = threading.Thread(target=stream_worker, daemon=True)
        thread.start()
    
    def _probe_primary_in_background(self):
        """Sondea la URL primaria en un hilo separado sin interrumpir el stream actual."""
        def probe():
            try:
                logger.info(f"🔍 Sondeando URL primaria: {self.primary_url}")
                cap = self._try_open_capture(self.primary_url)
                if cap is not None:
                    try:
                        cap.release()
                    except Exception:
                        pass
                    logger.info(f"✅ URL primaria recuperada. Conmutando de vuelta a HD...")
                    self.rtsp_url = self.primary_url
                    self.using_fallback = False
                    self._consecutive_connect_failures = 0
                    # Forzar reconexión cerrando el stream actual
                    with self.lock:
                        self.connected = False
                    if self.cap:
                        try:
                            self.cap.release()
                        except Exception:
                            pass
                        self.cap = None
                else:
                    logger.info(f"⏳ URL primaria aún no disponible, continuando con SD.")
            except Exception as e:
                logger.debug(f"Error en sondeo de URL primaria: {e}")
        
        t = threading.Thread(target=probe, daemon=True, name="primary-probe")
        t.start()
    
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
    
    def is_using_fallback(self):
        """Retorna True si se está usando la URL de respaldo (SD)."""
        return self.using_fallback
    
    def stop(self):
        self.running = False
        self.connected = False
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
