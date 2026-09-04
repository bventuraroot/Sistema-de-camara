import cv2
import numpy as np
import logging
import os
import torch
from ultralytics import YOLO
from threading import Lock

logger = logging.getLogger(__name__)

class ObjectDetector:
    def __init__(self, confidence=0.45, model_path=None):
        self.confidence = confidence
        self.active = True
        self.lock = Lock()
        
        # Selección de dispositivo acelerado (Apple Silicon MPS o CPU)
        if torch.backends.mps.is_available():
            self.device = 'mps'
            logger.info("Aceleración por hardware Apple Silicon (MPS) activada para YOLOv8")
        else:
            self.device = 'cpu'
            logger.info("Utilizando CPU optimizada para YOLOv8")
        
        # Cargar modelo YOLO
        actual_path = model_path if (model_path and os.path.exists(model_path)) else 'yolov8n.pt'
        if not os.path.isabs(actual_path):
            base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
            candidate = os.path.join(base_dir, actual_path)
            if os.path.exists(candidate):
                actual_path = candidate
        
        try:
            self.model = YOLO(actual_path)
            # Calentamiento inicial
            dummy = np.zeros((360, 640, 3), dtype=np.uint8)
            self.model(dummy, device=self.device, verbose=False)
            logger.info(f"Modelo YOLO cargado exitosamente desde: {actual_path}")
        except Exception as e:
            logger.warning(f"Error cargando en {self.device}, reintentando en cpu: {e}")
            self.device = 'cpu'
            self.model = YOLO('yolov8n.pt')
        
        # Traducción y categorización de clases
        self.class_mapping = {
            'person': 'Persona',
            'car': 'Vehículo',
            'truck': 'Camión',
            'bus': 'Autobús',
            'motorcycle': 'Motocicleta',
            'bicycle': 'Bicicleta',
            'dog': 'Perro',
            'cat': 'Gato',
            'bird': 'Ave',
            'backpack': 'Mochila',
            'handbag': 'Bolso',
            'suitcase': 'Maleta'
        }
        
        # Colores temáticos en BGR
        self.colors = {
            'person': (0, 255, 127),      # Verde esmeralda brillante
            'car': (255, 160, 0),         # Azul eléctrico
            'truck': (0, 100, 255),       # Naranja/Rojo
            'bus': (0, 165, 255),         # Naranja
            'motorcycle': (0, 220, 255),  # Amarillo
            'bicycle': (255, 255, 0),     # Cyan
            'dog': (255, 0, 200),         # Magenta
            'cat': (180, 0, 255),         # Púrpura
            'bird': (255, 200, 0),        # Cyan claro
        }
        self.default_color = (0, 200, 255)
    
    def detect(self, frame):
        """Ejecuta inferencia YOLOv8 en el frame y retorna la lista de detecciones."""
        if not self.active or frame is None:
            return []
        
        with self.lock:
            detections = []
            try:
                # Inferencia con tamaño 640 para máxima velocidad
                results = self.model(
                    frame,
                    conf=self.confidence,
                    device=self.device,
                    imgsz=640,
                    verbose=False
                )
                
                for result in results:
                    boxes = result.boxes
                    if boxes is None:
                        continue
                    
                    for box in boxes:
                        x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                        cls_idx = int(box.cls[0].tolist())
                        conf = float(box.conf[0].tolist())
                        raw_name = result.names[cls_idx]
                        
                        if raw_name in self.class_mapping:
                            detections.append({
                                'class': raw_name,
                                'label': self.class_mapping.get(raw_name, raw_name),
                                'confidence': conf,
                                'bbox': [x1, y1, x2, y2]
                            })
            except Exception as e:
                logger.error(f"Error en ObjectDetector.detect: {e}")
            
            return detections
    
    def draw_detections(self, frame, detections):
        """Dibuja elegantes cajas delimitadoras y etiquetas translúcidas sobre el frame."""
        if frame is None or not detections:
            return frame
        
        h_frame, w_frame = frame.shape[:2]
        
        for det in detections:
            x1, y1, x2, y2 = det['bbox']
            # Asegurar límites dentro del frame
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w_frame, x2), min(h_frame, y2)
            
            raw_cls = det['class']
            label = det['label']
            conf = det['confidence']
            color = self.colors.get(raw_cls, self.default_color)
            
            # Caja delimitadora principal
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            
            # Esquinas destacadas para estética moderna de vigilancia
            line_len = min(20, (x2 - x1) // 3, (y2 - y1) // 3)
            if line_len > 3:
                # Superior izquierda
                cv2.line(frame, (x1, y1), (x1 + line_len, y1), color, 4)
                cv2.line(frame, (x1, y1), (x1, y1 + line_len), color, 4)
                # Superior derecha
                cv2.line(frame, (x2, y1), (x2 - line_len, y1), color, 4)
                cv2.line(frame, (x2, y1), (x2, y1 + line_len), color, 4)
                # Inferior izquierda
                cv2.line(frame, (x1, y2), (x1 + line_len, y2), color, 4)
                cv2.line(frame, (x1, y2), (x1, y2 - line_len), color, 4)
                # Inferior derecha
                cv2.line(frame, (x2, y2), (x2 - line_len, y2), color, 4)
                cv2.line(frame, (x2, y2), (x2, y2 - line_len), color, 4)
            
            # Etiqueta con porcentaje
            tag = f"{label} {int(conf * 100)}%"
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 0.5
            thickness = 1
            (text_w, text_h), baseline = cv2.getTextSize(tag, font, font_scale, thickness)
            
            # Fondo de la etiqueta
            label_y1 = max(0, y1 - text_h - 10)
            label_y2 = y1
            cv2.rectangle(frame, (x1, label_y1), (x1 + text_w + 10, label_y2), color, -1)
            
            # Texto oscuro para alto contraste sobre color vivo
            cv2.putText(frame, tag, (x1 + 5, y1 - 5), font, font_scale, (0, 0, 0), thickness, cv2.LINE_AA)
        
        return frame
    
    def is_active(self):
        return self.active
    
    def toggle(self):
        self.active = not self.active
        logger.info(f"Detección de objetos IA: {'activada' if self.active else 'desactivada'}")
        return self.active
    
    def set_active(self, state: bool):
        self.active = state
        return self.active
    
    def set_confidence(self, confidence):
        with self.lock:
            self.confidence = max(0.1, min(0.95, confidence))
            logger.info(f"Confianza de detección configurada a: {self.confidence}")
    
    def get_model_info(self):
        return {
            'model': 'YOLOv8n',
            'device': self.device,
            'confidence': self.confidence,
            'active': self.active,
            'classes': list(self.class_mapping.values())
        }
