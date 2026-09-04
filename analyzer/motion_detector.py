import cv2
import numpy as np
import logging
import time
from threading import Lock

logger = logging.getLogger(__name__)

class MotionDetector:
    def __init__(self, threshold=4000, min_area=600):
        self.threshold = threshold
        self.min_area = min_area
        self.active = True
        self.ai_filter_enabled = True  # Solo disparar eventos si la IA confirma persona/vehículo/mascota
        self.background_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=300,
            varThreshold=32,
            detectShadows=True
        )
        self.last_detection_time = 0
        self.cooldown = 2.0
        self.lock = Lock()
        self.last_motion_boxes = []
        self.motion_level = 0
    
    def detect(self, frame):
        """
        Analiza el frame en busca de cambios y movimiento.
        Retorna (motion_detected: bool, motion_boxes: list, total_area: int)
        """
        if not self.active or frame is None:
            return False, [], 0
        
        with self.lock:
            # Reducir frame para análisis de movimiento ultra-rápido
            h, w = frame.shape[:2]
            scale = 0.5 if w > 800 else 1.0
            small_frame = cv2.resize(frame, (0, 0), fx=scale, fy=scale) if scale != 1.0 else frame
            
            # Aplicar filtro gaussiano para eliminar ruido de alta frecuencia
            blurred = cv2.GaussianBlur(small_frame, (7, 7), 0)
            
            # Substracción de fondo
            fgmask = self.background_subtractor.apply(blurred)
            
            # Eliminar sombras (mantener solo píxeles blancos 255)
            _, thresh = cv2.threshold(fgmask, 240, 255, cv2.THRESH_BINARY)
            
            # Operaciones morfológicas para consolidar regiones
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
            dilated = cv2.dilate(thresh, kernel, iterations=2)
            
            # Encontrar contornos
            contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            motion_detected = False
            total_motion_area = 0
            motion_boxes = []
            
            # Normalizar umbral y área mínima en proporción a la resolución del frame (base estándar 1080p)
            res_factor = (w * h) / (1920.0 * 1080.0)
            min_area_scaled = max(80, int(self.min_area * res_factor * (scale * scale)))
            threshold_scaled = max(300, int(self.threshold * res_factor * (scale * scale)))
            
            for contour in contours:
                area = cv2.contourArea(contour)
                if area < min_area_scaled:
                    continue
                
                total_motion_area += area
                
                if area > threshold_scaled:
                    motion_detected = True
                    x, y, bw, bh = cv2.boundingRect(contour)
                    
                    # Escalar de regreso al tamaño original
                    if scale != 1.0:
                        x = int(x / scale)
                        y = int(y / scale)
                        bw = int(bw / scale)
                        bh = int(bh / scale)
                    
                    motion_boxes.append([x, y, x + bw, y + bh])
            
            self.last_motion_boxes = motion_boxes
            self.motion_level = min(100, int((total_motion_area / max(1, w * h * 0.2)) * 100))
            
            return motion_detected, motion_boxes, total_motion_area
    
    def match_with_ai(self, motion_boxes, ai_detections):
        """
        Compara las cajas de movimiento con las detecciones de la IA para determinar
        si el movimiento corresponde a un objeto inteligente (persona, vehículo, mascota).
        """
        if not motion_boxes or not ai_detections:
            return []
        
        matched_events = []
        
        for ai_det in ai_detections:
            ax1, ay1, ax2, ay2 = ai_det['bbox']
            ai_cls = ai_det['class']
            ai_label = ai_det['label']
            
            # Verificar intersección con cualquier caja de movimiento
            for mx1, my1, mx2, my2 in motion_boxes:
                # Intersección
                ix1 = max(ax1, mx1)
                iy1 = max(ay1, my1)
                ix2 = min(ax2, mx2)
                iy2 = min(ay2, my2)
                
                if ix1 < ix2 and iy1 < iy2:
                    matched_events.append({
                        'class': ai_cls,
                        'label': ai_label,
                        'confidence': ai_det['confidence'],
                        'bbox': ai_det['bbox'],
                        'message': f"{ai_label} en movimiento detectado/a"
                    })
                    break
        
        return matched_events
    
    def draw_motion_overlay(self, frame, motion_boxes):
        """Dibuja un marco visible en las zonas con movimiento detectado (adaptado a 1080p)."""
        if frame is None or not self.active or not motion_boxes:
            return frame
        
        h_frame, w_frame = frame.shape[:2]
        thick = max(2, int(w_frame / 640 * 1.8))
        
        for box in motion_boxes:
            x1, y1, x2, y2 = box
            # Rectángulo en color cyan brillante con esquinas destacadas
            cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 210, 0), thick)
            # Indicador de texto discreto
            tag_y = max(18, y1 - 6)
            cv2.putText(frame, "Movimiento", (x1, tag_y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 210, 0), 1, cv2.LINE_AA)
        
        return frame
    
    def is_active(self):
        return self.active
    
    def toggle(self):
        self.active = not self.active
        logger.info(f"Detección de movimiento: {'activada' if self.active else 'desactivada'}")
        return self.active
    
    def set_active(self, state: bool):
        self.active = state
        return self.active
    
    def toggle_ai_filter(self):
        self.ai_filter_enabled = not self.ai_filter_enabled
        logger.info(f"Filtro inteligente IA: {'activado' if self.ai_filter_enabled else 'desactivado'}")
        return self.ai_filter_enabled
    
    def is_ai_filter_enabled(self):
        return self.ai_filter_enabled
    
    def set_ai_filter(self, state: bool):
        self.ai_filter_enabled = state
        return self.ai_filter_enabled
    
    def set_threshold(self, threshold):
        with self.lock:
            self.threshold = max(500, min(50000, threshold))
            logger.info(f"Umbral de movimiento configurado a: {self.threshold}")
