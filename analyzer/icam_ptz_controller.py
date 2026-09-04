import logging
import threading
import time
import socket

logger = logging.getLogger(__name__)

class ICam365PTZController:
    """
    Controlador PTZ nativo para cámara iCam365 (chipset EYEPLUS / Ginatex)
    usando el protocolo estándar ONVIF Profile S (ContinuousMove y Stop).
    Incluye:
      - Control de giro manual y por pulsos
      - Auto-Tracking inteligente con zonas muertas
      - Fijación de Punto Central (Home Position)
      - Retorno automático al Punto Central tras perder el objetivo
    """
    DIR_SPEED = {
        'left': (-1.0, 0.0),
        'right': (1.0, 0.0),
        'up': (0.0, 0.9),
        'down': (0.0, -0.9),
        'upleft': (-0.8, 0.8),
        'upright': (0.8, 0.8),
        'downleft': (-0.8, -0.8),
        'downright': (0.8, -0.8)
    }

    def __init__(self, ip="192.168.1.26", port=80, profile_token="Profile_1"):
        self.ip = ip
        self.port = port
        self.profile_token = profile_token
        self.active = True
        self.lock = threading.Lock()
        self.is_moving = False
        self.last_move_time = 0.0
        self.last_direction = None
        self.pulse_duration = 0.22
        self.cooldown = 0.35  # Reducido de 1.2s a 350ms para respuesta ultra-rápida
        self.deadzone_x = (0.40, 0.60)  # Reacciona de inmediato fuera del 20% central
        self.deadzone_y = (0.35, 0.65)
        self.vertical_tracking = True
        self.manual_start_time = 0.0

        # Punto Central (Home Position) y Retorno Automático
        self.pan_offset = 0.0
        self.tilt_offset = 0.0
        self.last_target_time = time.time()
        self.returning_home = False
        self.home_return_delay = 5.5

        self._start_home_watcher()
        logger.info(f"ICam365PTZController ONVIF inicializado para {self.ip}:{self.port} con Punto Central y Auto-Retorno activo.")

    def _send_soap(self, body_content: str) -> bool:
        soap = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">'
            f'<s:Body>{body_content}</s:Body>'
            '</s:Envelope>'
        )
        req = (
            f'POST /onvif/PTZ HTTP/1.1\r\n'
            f'Host: {self.ip}:{self.port}\r\n'
            f'Content-Type: application/soap+xml; charset=utf-8\r\n'
            f'Content-Length: {len(soap)}\r\n'
            f'Connection: close\r\n\r\n'
            f'{soap}'
        )
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(2.5)
            s.connect((self.ip, self.port))
            s.sendall(req.encode('utf-8'))
            res = s.recv(1024)
            s.close()
            return b'200' in res or b'ContinuousMoveResponse' in res or b'StopResponse' in res
        except Exception as e:
            logger.error(f"Error enviando comando ONVIF PTZ a {self.ip}:{self.port}: {e}")
            return False

    def _send_direction(self, direction: str) -> bool:
        speeds = self.DIR_SPEED.get(direction)
        if not speeds:
            return False
        vx, vy = speeds
        move_body = (
            '<tptz:ContinuousMove>'
            f'<tptz:ProfileToken>{self.profile_token}</tptz:ProfileToken>'
            '<tptz:Velocity>'
            f'<tt:PanTilt x="{vx}" y="{vy}" xmlns:tt="http://www.onvif.org/ver10/schema"/>'
            '</tptz:Velocity>'
            '</tptz:ContinuousMove>'
        )
        return self._send_soap(move_body)

    def _send_stop(self) -> bool:
        stop_body = f'<tptz:Stop><tptz:ProfileToken>{self.profile_token}</tptz:ProfileToken></tptz:Stop>'
        return self._send_soap(stop_body)

    def manual_move(self, direction: str) -> bool:
        """Mueve la cámara mientras el usuario mantiene presionado el botón."""
        if direction == "stop":
            def do_stop():
                with self.lock:
                    self.is_moving = False
                    elapsed = max(0.2, min(3.0, time.time() - self.manual_start_time))
                    if self.last_direction == "right":
                        self.pan_offset += elapsed
                    elif self.last_direction == "left":
                        self.pan_offset -= elapsed
                    elif self.last_direction == "down":
                        self.tilt_offset += elapsed
                    elif self.last_direction == "up":
                        self.tilt_offset -= elapsed

                    self.last_direction = "stop"
                    self.last_target_time = time.time()
                    self.last_move_time = time.time()
                self._send_stop()
            threading.Thread(target=do_stop, daemon=True, name="icam-ptz-stop").start()
            return True

        speeds = self.DIR_SPEED.get(direction)
        if not speeds:
            return False

        def do_move():
            with self.lock:
                self.is_moving = True
                self.last_direction = direction
                self.manual_start_time = time.time()
                self.last_target_time = time.time()
                self.last_move_time = time.time()
            self._send_direction(direction)

        threading.Thread(target=do_move, daemon=True, name=f"icam-ptz-{direction}").start()
        return True

    def pulse_move(self, direction: str, duration: float = None):
        """Ejecuta un giro con duración fija registrando el desplazamiento para el Punto Central."""
        dur = duration or self.pulse_duration
        speeds = self.DIR_SPEED.get(direction)
        if not speeds:
            return False

        def execute_pulse():
            with self.lock:
                self.is_moving = True
                self.last_direction = direction
                if direction == "right":
                    self.pan_offset += dur
                elif direction == "left":
                    self.pan_offset -= dur
                elif direction == "down":
                    self.tilt_offset += dur
                elif direction == "up":
                    self.tilt_offset -= dur

            try:
                self._send_direction(direction)
                time.sleep(dur)
                self._send_stop()
            finally:
                with self.lock:
                    self.is_moving = False
                    self.last_move_time = time.time()

        threading.Thread(target=execute_pulse, daemon=True, name=f"icam-ptz-pulse-{direction}").start()
        return True

    def track_target(self, frame_shape, bbox, label="Objetivo"):
        """Auto-Tracking nativo ultrarrápido para Cámara 2 (iCam365 ONVIF)."""
        if not self.active or bbox is None:
            return False, None
        now = time.time()
        with self.lock:
            self.last_target_time = now
            if self.is_moving or (now - self.last_move_time) < self.cooldown:
                return False, None

        h, w = frame_shape[:2]
        if h <= 0 or w <= 0 or bbox is None:
            return False, None

        x1, y1, x2, y2 = bbox
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        norm_x = cx / float(w)
        norm_y = cy / float(h)
        err_x = abs(norm_x - 0.5)
        err_y = abs(norm_y - 0.5)

        target_dir = None
        # Prioridad 1: Centrado horizontal
        if norm_x < self.deadzone_x[0]:
            target_dir = "left"
        elif norm_x > self.deadzone_x[1]:
            target_dir = "right"
        # Prioridad 2: Centrado vertical (si horizontalmente ya está dentro de margen)
        elif self.vertical_tracking:
            if norm_y < self.deadzone_y[0]:
                target_dir = "up"
            elif norm_y > self.deadzone_y[1]:
                target_dir = "down"

        if target_dir:
            # Pulso proporcional dinámico según la desviación
            if target_dir in ("left", "right"):
                if err_x > 0.28:       # Lejos del centro (>78% o <22%)
                    pulse_dur = 0.32
                elif err_x > 0.16:     # Distancia media
                    pulse_dur = 0.22
                else:                  # Ajuste fino
                    pulse_dur = 0.16
            else:
                pulse_dur = 0.22 if err_y > 0.25 else 0.15

            logger.info(f"⚡ [Cam 2 ONVIF] Auto-Tracking rápido: {label} (X: {norm_x:.2f}, Y: {norm_y:.2f}) -> {target_dir} ({pulse_dur:.2f}s)")
            self.pulse_move(target_dir, duration=pulse_dur)
            return True, target_dir
        return False, "centered"

    def set_home_position(self) -> bool:
        """Fija la posición física actual como Punto Central (Home) para Cámara 2."""
        with self.lock:
            self.pan_offset = 0.0
            self.tilt_offset = 0.0
            self.last_target_time = time.time()
            self.returning_home = False
            logger.info("📍 [Cámara 2] Punto Central fijado con éxito en la orientación actual.")
            return True

    def return_to_home(self) -> bool:
        """Regresa la Cámara 2 al Punto Central fijado compensando los giros acumulados."""
        def do_return():
            with self.lock:
                if self.is_moving or self.returning_home:
                    return
                self.returning_home = True
                pan = self.pan_offset
                tilt = self.tilt_offset

            try:
                # 1. Retorno Horizontal
                if abs(pan) >= 0.10:
                    rev_dir = "left" if pan > 0 else "right"
                    dur = min(2.5, abs(pan))
                    logger.info(f"🔄 [Cámara 2] Retornando al centro: girando '{rev_dir}' durante {dur:.2f}s")
                    self._send_direction(rev_dir)
                    time.sleep(dur)
                    self._send_stop()
                    time.sleep(0.4)

                # 2. Retorno Vertical
                if abs(tilt) >= 0.10:
                    rev_dir = "up" if tilt > 0 else "down"
                    dur = min(1.5, abs(tilt))
                    logger.info(f"🔄 [Cámara 2] Retornando al centro vertical: girando '{rev_dir}' durante {dur:.2f}s")
                    self._send_direction(rev_dir)
                    time.sleep(dur)
                    self._send_stop()
                    time.sleep(0.4)

                with self.lock:
                    self.pan_offset = 0.0
                    self.tilt_offset = 0.0
                    logger.info("✅ [Cámara 2] Regreso al Punto Central completado exitosamente.")
            finally:
                with self.lock:
                    self.returning_home = False
                    self.last_move_time = time.time()

        threading.Thread(target=do_return, daemon=True, name="icam-return-home").start()
        return True

    def _start_home_watcher(self):
        """Monitorea periódicamente si el objetivo salió del cuadro para regresar al Punto Central."""
        def watcher():
            while True:
                time.sleep(0.5)
                now = time.time()
                with self.lock:
                    time_since_target = now - self.last_target_time
                    has_offset = (abs(self.pan_offset) >= 0.08 or abs(self.tilt_offset) >= 0.08)
                    should_return = (
                        has_offset and
                        not self.is_moving and
                        not self.returning_home and
                        time_since_target > self.home_return_delay
                    )

                if should_return:
                    logger.info(f"⏳ [Cámara 2] Sin actividad durante {time_since_target:.1f}s (espera configurada: {self.home_return_delay}s). Iniciando retorno automático al Punto Central...")
                    self.return_to_home()

        threading.Thread(target=watcher, daemon=True, name="icam-home-watcher").start()

    def set_home_delay(self, delay: float):
        """Permite configurar los segundos de espera antes del retorno automático al Punto Central."""
        self.home_return_delay = max(2.0, float(delay))
        logger.info(f"⏱️ [Cámara 2] Tiempo de retorno al Punto Central ajustado a {self.home_return_delay:.1f}s")

    def get_status(self) -> dict:
        now = time.time()
        elapsed = now - self.last_target_time
        has_offset = (abs(self.pan_offset) >= 0.08 or abs(self.tilt_offset) >= 0.08)
        time_left = max(0.0, round(self.home_return_delay - elapsed, 1)) if (has_offset and not self.returning_home and not self.is_moving) else 0.0
        return {
            'is_moving': self.is_moving,
            'returning_home': self.returning_home,
            'pan_offset': round(self.pan_offset, 2),
            'tilt_offset': round(self.tilt_offset, 2),
            'has_offset': has_offset,
            'is_at_home': not has_offset,
            'home_return_delay': self.home_return_delay,
            'time_until_return': time_left,
            'last_direction': self.last_direction,
            'active': self.active
        }

    def is_active(self) -> bool:
        return self.active

    def set_active(self, state: bool) -> bool:
        self.active = state
        logger.info(f"[Cámara 2] Auto-Tracking PTZ: {'ACTIVADO' if self.active else 'DESACTIVADO'}")
        return self.active

    def toggle(self) -> bool:
        self.active = not self.active
        logger.info(f"[Cámara 2] Auto-Tracking PTZ: {'ACTIVADO' if self.active else 'DESACTIVADO'}")
        return self.active

    def test_connection(self) -> dict:
        ok = self._send_stop()
        if ok:
            return {'success': True, 'status': 200, 'message': '¡Motor PTZ ONVIF de Cámara 2 conectado y operativo!'}
        return {'success': False, 'status': 500, 'message': 'No se pudo comunicar con el servicio ONVIF PTZ'}
