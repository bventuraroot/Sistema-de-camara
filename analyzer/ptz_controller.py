import json
import logging
import os
import threading
import time
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

class PTZController:
    """
    Controlador de movimiento PTZ (Pan-Tilt-Zoom) y Auto-Tracking inteligente.
    Se comunica de forma asíncrona con tuya-rtsp-bridge (:8787/api/ptz/move)
    para recentrar la cámara cuando la IA detecte una alerta que requiera atención.
    """
    def __init__(self, bridge_url=None, device_id=None, active=True):
        self.bridge_url = (bridge_url or os.getenv('TUYA_BRIDGE_URL', 'http://localhost:8787')).rstrip('/')
        self.device_id = device_id or os.getenv('TUYA_DEVICE_ID', 'bfd2e21c05dc99e44fkapz')
        self.active = active
        self.lock = threading.Lock()
        
        # Parámetros de seguimiento ultrarrápido y reactivo
        self.pulse_duration = float(os.getenv('PTZ_PULSE_DURATION', 0.22))  # Pulso ágil por defecto
        self.cooldown = float(os.getenv('PTZ_COOLDOWN', 0.40))               # Cooldown reducido de 1.4s a 400ms para correcciones en tiempo real
        self.last_move_time = 0.0
        self.manual_start_time = 0.0
        self.min_manual_duration = 0.30  # Mínimo tiempo de giro para toques cortos
        self.is_moving = False
        
        # Zona muerta (Deadzone) más ajustada para no dejar escapar objetivos en movimiento
        self.deadzone_x = (0.40, 0.60)  # Reacciona inmediatamente al salir del 20% central
        self.deadzone_y = (0.35, 0.65)
        self.vertical_tracking = True
        
        # Punto Central (Home Position) y Retorno Automático
        self.pan_offset = 0.0      # Desplazamiento horizontal acumulado (>0 derecha, <0 izquierda)
        self.tilt_offset = 0.0     # Desplazamiento vertical acumulado (>0 abajo, <0 arriba)
        self.last_target_time = time.time()
        self.home_return_delay = 5.5  # Segundos sin objetivo antes de retornar a casa
        self.returning_home = False
        self.auto_return_enabled = True
        
        # Métricas de estado
        self.last_direction = None
        self.tracking_target_label = None
        self.move_count = 0
        
        logger.info(f"PTZController inicializado para deviceId={self.device_id} en {self.bridge_url} (Auto-Tracking: {'ACTIVO' if self.active else 'INACTIVO'})")
        self._start_home_watcher()

    def _post_command(self, direction: str) -> bool:
        """Envía una orden HTTP POST a la API PTZ del bridge Tuya."""
        url = f"{self.bridge_url}/api/ptz/move"
        payload = json.dumps({
            "deviceId": self.device_id,
            "direction": direction
        }).encode('utf-8')
        
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        
        try:
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                if resp.status == 200:
                    logger.debug(f"PTZ comando '{direction}' enviado con éxito a {self.device_id}")
                    return True
                logger.warning(f"PTZ API retornó código HTTP {resp.status} al enviar '{direction}'")
                return False
        except urllib.error.URLError as e:
            logger.error(f"Error de conexión con la API PTZ ({url}): {e}")
            return False
        except Exception as e:
            logger.error(f"Excepción al enviar comando PTZ '{direction}': {e}")
            return False

    def manual_move(self, direction: str) -> bool:
        """
        Inicia o detiene movimiento continuo Tuya.
        Bloquea nuevas órdenes si la cámara está en proceso de volver al centro.
        """
        with self.lock:
            if self.returning_home:
                return False
        
        def run_manual():
            if direction == "stop":
                now = time.time()
                if self.manual_start_time <= 0:
                    elapsed = self.min_manual_duration
                else:
                    elapsed = now - self.manual_start_time
                
                # Garantizar pulso mínimo visible
                if elapsed < self.min_manual_duration:
                    time.sleep(self.min_manual_duration - elapsed)
                    elapsed = self.min_manual_duration
                
                # Limitar a 3s máximo para no acumular offsets desproporcionados
                elapsed = min(elapsed, 3.0)

                # Enviar stop ANTES de adquirir el lock (HTTP puede tomar hasta 1s)
                self._post_command("stop")

                with self.lock:
                    prev_dir = self.last_direction
                    # Registrar desplazamiento acumulado respecto al Punto Central
                    if prev_dir == "right": self.pan_offset += elapsed
                    elif prev_dir == "left": self.pan_offset -= elapsed
                    elif prev_dir == "down": self.tilt_offset += elapsed
                    elif prev_dir == "up": self.tilt_offset -= elapsed
                    
                    # Acotar límites físicos acumulados
                    self.pan_offset = max(-6.5, min(6.5, self.pan_offset))
                    self.tilt_offset = max(-2.5, min(2.5, self.tilt_offset))

                    self.last_direction = "stop"
                    self.last_target_time = time.time()
                    self.last_move_time = time.time()
                    self.is_moving = False
                    self.manual_start_time = 0.0  # Resetear para la próxima vez
                    logger.info(f"Freno manual PTZ (Tuya). Desplazamiento acumulado: pan={self.pan_offset:.2f}s, tilt={self.tilt_offset:.2f}s")
            else:
                with self.lock:
                    self.manual_start_time = time.time()
                    self.last_direction = direction
                    self.last_target_time = time.time()
                    self.is_moving = True
                self._post_command(direction)
        
        threading.Thread(target=run_manual, daemon=True, name=f"ptz-manual-{direction}").start()
        return True

    def pulse_move(self, direction: str, duration: float = None):
        """
        Ejecuta un pulso de movimiento: inicia el giro, espera la duración y luego envía 'stop'.
        Esto garantiza que la cámara no siga girando continuamente.
        """
        dur = duration or self.pulse_duration
        
        def execute_pulse():
            with self.lock:
                if self.is_moving or self.returning_home:
                    return  # Ya en movimiento o retornando a casa, no apilar pulsos
                self.is_moving = True
                self.last_direction = direction
                self.move_count += 1
                # Registrar desplazamiento acumulado respecto al Punto Central
                if direction == "right":
                    self.pan_offset += dur
                elif direction == "left":
                    self.pan_offset -= dur
                elif direction == "down":
                    self.tilt_offset += dur
                elif direction == "up":
                    self.tilt_offset -= dur
                
                # Acotar límites físicos
                self.pan_offset = max(-6.5, min(6.5, self.pan_offset))
                self.tilt_offset = max(-2.5, min(2.5, self.tilt_offset))
            
            try:
                # 1. Iniciar movimiento (fuera del lock)
                self._post_command(direction)
                # 2. Mantener durante el pulso
                time.sleep(dur)
                # 3. Frenar (fuera del lock)
                self._post_command("stop")
            finally:
                with self.lock:
                    self.is_moving = False
                    self.last_move_time = time.time()
        
        threading.Thread(target=execute_pulse, daemon=True, name=f"ptz-pulse-{direction}").start()

    def set_home_position(self) -> bool:
        """Fija la posición física actual como Punto Central (Home)."""
        with self.lock:
            self.pan_offset = 0.0
            self.tilt_offset = 0.0
            self.last_target_time = time.time()
            self.returning_home = False
            self.is_moving = False
            logger.info("📍 [Cam 1 Tuya] Punto Central fijado con éxito en la orientación actual.")
            return True

    def return_to_home(self) -> bool:
        """
        Regresa la cámara al Punto Central fijado compensando los giros acumulados
        en pasos progresivos y sin truncamiento brusco.
        """
        def do_return():
            # Esperar si hay un movimiento en curso para no colisionar
            wait_start = time.time()
            pan = 0.0
            tilt = 0.0
            while time.time() - wait_start < 1.5:
                with self.lock:
                    if self.returning_home:
                        return  # Ya hay otro hilo retornando
                    if not self.is_moving:
                        self.returning_home = True
                        pan = self.pan_offset
                        tilt = self.tilt_offset
                        break
                time.sleep(0.1)
            else:
                with self.lock:
                    if self.returning_home:
                        return
                    self.returning_home = True
                    self.is_moving = False
                    pan = self.pan_offset
                    tilt = self.tilt_offset

            try:
                # 1. Retorno Horizontal Multi-Paso sin truncar offset
                while abs(pan) >= 0.10:
                    rev_dir = "left" if pan > 0 else "right"
                    step_dur = min(2.0, abs(pan))
                    logger.info(f"🔄 [Cam 1 Tuya] Retornando al centro: girando '{rev_dir}' durante {step_dur:.2f}s (restante: {abs(pan):.2f}s)")
                    self._post_command(rev_dir)
                    time.sleep(step_dur)
                    self._post_command("stop")

                    if pan > 0:
                        pan = max(0.0, pan - step_dur)
                    else:
                        pan = min(0.0, pan + step_dur)

                    with self.lock:
                        self.pan_offset = pan

                    if abs(pan) >= 0.10:
                        time.sleep(0.25)

                # 2. Retorno Vertical Multi-Paso
                while abs(tilt) >= 0.10:
                    rev_dir = "up" if tilt > 0 else "down"
                    step_dur = min(1.2, abs(tilt))
                    logger.info(f"🔄 [Cam 1 Tuya] Retornando al centro vertical: '{rev_dir}' durante {step_dur:.2f}s (restante: {abs(tilt):.2f}s)")
                    self._post_command(rev_dir)
                    time.sleep(step_dur)
                    self._post_command("stop")

                    if tilt > 0:
                        tilt = max(0.0, tilt - step_dur)
                    else:
                        tilt = min(0.0, tilt + step_dur)

                    with self.lock:
                        self.tilt_offset = tilt

                    if abs(tilt) >= 0.10:
                        time.sleep(0.25)

                with self.lock:
                    self.pan_offset = 0.0
                    self.tilt_offset = 0.0
                    self.last_direction = "home"
                    self.last_target_time = time.time()
                    logger.info("🎯 [Cam 1 Tuya] Cámara de vuelta con éxito en el Punto Central.")
            except Exception as e:
                logger.error(f"Error en return_to_home (Cam 1 Tuya): {e}")
            finally:
                with self.lock:
                    self.returning_home = False
                    self.is_moving = False
                    self.last_move_time = time.time()

        threading.Thread(target=do_return, daemon=True, name="ptz-return-home").start()
        return True

    def _start_home_watcher(self):
        """Monitorea si el objetivo ha salido del cuadro o si la cámara fue desplazada para regresar al Punto Central."""
        def watcher():
            while True:
                time.sleep(0.5)
                if not self.auto_return_enabled:
                    continue
                with self.lock:
                    is_moving = self.is_moving
                    is_returning = self.returning_home
                    elapsed = time.time() - self.last_target_time
                    has_offset = abs(self.pan_offset) >= 0.08 or abs(self.tilt_offset) >= 0.08

                if not is_moving and not is_returning and has_offset and elapsed >= self.home_return_delay:
                    logger.info(f"⏳ Sin actividad durante {elapsed:.1f}s (espera configurada: {self.home_return_delay}s). Retornando automáticamente al Punto Central...")
                    self.return_to_home()
        t = threading.Thread(target=watcher, daemon=True, name="ptz-home-watcher")
        t.start()

    def track_target(self, frame_shape, bbox, label="Objetivo"):
        """
        Evalúa la posición del objetivo detectado y realiza un ajuste si sale de la zona muerta.
        """
        if not self.active or bbox is None:
            return False, None
        
        now = time.time()
        with self.lock:
            self.last_target_time = now
            if self.returning_home or self.is_moving or (now - self.last_move_time) < self.cooldown:
                return False, None
        
        h, w = frame_shape[:2]
        if h <= 0 or w <= 0:
            return False, None
        
        x1, y1, x2, y2 = bbox
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        
        norm_x = cx / float(w)
        norm_y = cy / float(h)
        err_x = abs(norm_x - 0.5)
        err_y = abs(norm_y - 0.5)
        
        target_dir = None
        
        if norm_x < self.deadzone_x[0]:
            target_dir = "left"
        elif norm_x > self.deadzone_x[1]:
            target_dir = "right"
        elif self.vertical_tracking:
            if norm_y < self.deadzone_y[0]:
                target_dir = "up"
            elif norm_y > self.deadzone_y[1]:
                target_dir = "down"
        
        if target_dir:
            # Pulso proporcional: más enérgico cuanto más lejos esté el objetivo del centro
            if target_dir in ("left", "right"):
                if err_x > 0.28:       # Lejos del centro (>78% o <22%)
                    pulse_dur = 0.35   # Pulso rápido para no perder al objetivo
                elif err_x > 0.16:     # Distancia intermedia
                    pulse_dur = 0.24
                else:                  # Ajuste fino cerca del centro
                    pulse_dur = 0.16
            else:
                pulse_dur = 0.22 if err_y > 0.25 else 0.15

            self.tracking_target_label = label
            logger.info(f"⚡ [Cam 1 Tuya] Auto-Tracking rápido: {label} (X: {norm_x:.2f}, err: {err_x:.2f}) -> {target_dir} ({pulse_dur:.2f}s)")
            self.pulse_move(target_dir, duration=pulse_dur)
            return True, target_dir
        else:
            self.tracking_target_label = None
            return False, "centered"

    def is_active(self) -> bool:
        return self.active

    def toggle(self) -> bool:
        self.active = not self.active
        logger.info(f"Auto-Tracking PTZ: {'ACTIVADO' if self.active else 'DESACTIVADO'}")
        return self.active

    def set_active(self, state: bool) -> bool:
        self.active = state
        return self.active

    def set_home_delay(self, delay: float):
        """Permite configurar los segundos de espera antes del retorno automático al Punto Central."""
        self.home_return_delay = max(2.0, float(delay))
        logger.info(f"⏱️ Tiempo de retorno al Punto Central ajustado a {self.home_return_delay:.1f}s")

    def get_status(self) -> dict:
        now = time.time()
        elapsed = now - self.last_target_time
        has_offset = abs(self.pan_offset) >= 0.08 or abs(self.tilt_offset) >= 0.08
        time_left = max(0.0, round(self.home_return_delay - elapsed, 1)) if (has_offset and not self.returning_home and not self.is_moving) else 0.0
        return {
            'active': self.active,
            'is_moving': self.is_moving,
            'returning_home': self.returning_home,
            'pan_offset': round(self.pan_offset, 2),
            'tilt_offset': round(self.tilt_offset, 2),
            'has_offset': has_offset,
            'is_at_home': not has_offset,
            'home_return_delay': self.home_return_delay,
            'time_until_return': time_left,
            'last_direction': self.last_direction,
            'tracking_target': self.tracking_target_label,
            'device_id': self.device_id,
            'bridge_url': self.bridge_url
        }
