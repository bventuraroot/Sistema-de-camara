import logging
import time
import json
import os
from datetime import datetime, timedelta
from threading import Lock
from collections import deque

logger = logging.getLogger(__name__)

class AlertSystem:
    def __init__(self, cooldown=30, max_events=1000):
        self.cooldown = cooldown
        self.max_events = max_events
        self.last_alert_time = {}
        self.events = deque(maxlen=max_events)
        self.lock = Lock()
        self.callbacks = []
        
        # Configurar notificaciones
        self.notification_methods = []
        self._load_config()
    
    def _load_config(self):
        config_path = os.path.join(os.path.dirname(__file__), '..', 'config', 'alerts.json')
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                config = json.load(f)
                self.cooldown = config.get('cooldown', self.cooldown)
                logger.info("Configuración de alertas cargada")
    
    def trigger(self, event_type, message, data=None):
        current_time = time.time()
        
        with self.lock:
            # Verificar cooldown
            if event_type in self.last_alert_time:
                if current_time - self.last_alert_time[event_type] < self.cooldown:
                    return False
            
            # Crear evento
            event = {
                'type': event_type,
                'message': message,
                'timestamp': datetime.now().isoformat(),
                'data': data or {}
            }
            
            # Guardar evento
            self.events.append(event)
            self.last_alert_time[event_type] = current_time
            
            # Log
            logger.info(f"Alerta: {event_type} - {message}")
            
            # Ejecutar callbacks
            for callback in self.callbacks:
                try:
                    callback(event)
                except Exception as e:
                    logger.error(f"Error en callback: {e}")
            
            return True
    
    def add_callback(self, callback):
        self.callbacks.append(callback)
    
    def get_recent_events(self, minutes=60):
        cutoff = datetime.now() - timedelta(minutes=minutes)
        
        with self.lock:
            return [
                event for event in self.events
                if datetime.fromisoformat(event['timestamp']) > cutoff
            ]
    
    def get_events_by_type(self, event_type, hours=24):
        cutoff = datetime.now() - timedelta(hours=hours)
        
        with self.lock:
            return [
                event for event in self.events
                if event['type'] == event_type and
                datetime.fromisoformat(event['timestamp']) > cutoff
            ]
    
    def get_statistics(self, hours=24):
        cutoff = datetime.now() - timedelta(hours=hours)
        
        with self.lock:
            events_in_range = [
                event for event in self.events
                if datetime.fromisoformat(event['timestamp']) > cutoff
            ]
            
            stats = {
                'total': len(events_in_range),
                'by_type': {},
                'by_hour': {}
            }
            
            for event in events_in_range:
                # Por tipo
                event_type = event['type']
                stats['by_type'][event_type] = stats['by_type'].get(event_type, 0) + 1
                
                # Por hora
                hour = datetime.fromisoformat(event['timestamp']).hour
                stats['by_hour'][hour] = stats['by_hour'].get(hour, 0) + 1
            
            return stats
    
    def clear_old_events(self, days=7):
        cutoff = datetime.now() - timedelta(days=days)
        
        with self.lock:
            self.events = deque(
                [e for e in self.events if datetime.fromisoformat(e['timestamp']) > cutoff],
                maxlen=self.max_events
            )
    
    def export_events(self, filepath, format='json'):
        with self.lock:
            events_list = list(self.events)
        
        if format == 'json':
            with open(filepath, 'w') as f:
                json.dump(events_list, f, indent=2)
        elif format == 'csv':
            import csv
            with open(filepath, 'w', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=['type', 'message', 'timestamp'])
                writer.writeheader()
                writer.writerows(events_list)
        
        logger.info(f"Eventos exportados a: {filepath}")
