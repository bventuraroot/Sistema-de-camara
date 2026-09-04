import os
import sys
import time
import socket
import cv2
import json
import threading
import shutil
from queue import Queue
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, Response, jsonify, request, send_from_directory, send_file
from dotenv import load_dotenv
import logging

from analyzer.video_stream import VideoStream
from analyzer.motion_detector import MotionDetector
from analyzer.object_detector import ObjectDetector
from analyzer.alert_system import AlertSystem
from analyzer.recorder import Recorder
from analyzer.ptz_controller import PTZController
from analyzer.icam_ptz_controller import ICam365PTZController
from analyzer.network_scanner import scan_network_cameras, test_rtsp_connection, CAMERA_PRESETS
from analyzer.system_profiler import SystemProfiler

load_dotenv()

logging.basicConfig(
    level=logging.DEBUG if os.getenv('DEBUG', 'false').lower() == 'true' else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
# Deshabilitar caché de archivos estáticos completamente (rompe 304 en Safari iOS)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
app.config['TEMPLATES_AUTO_RELOAD'] = True

# Calcular versión de archivos estáticos basada en mtime (cache-busting automático)
def _static_version():
    try:
        js_mtime = int(Path('static/app.js').stat().st_mtime)
        css_mtime = int(Path('static/style.css').stat().st_mtime)
        return str(js_mtime + css_mtime)[-8:]  # Últimos 8 dígitos del timestamp combinado
    except Exception:
        return str(int(time.time()))[-8:]

# Forzar recarga de archivos JS/CSS/HTML en cada request (rompe caché de Safari iOS)
# También convierte cualquier 304 Not Modified en 200 para evitar que Safari use caché viejo
@app.after_request
def add_no_cache_headers(response):
    ct = response.content_type or ''
    if any(t in ct for t in ('javascript', 'text/css', 'text/html')):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        # Eliminar ETag para que Safari no pueda devolver 304
        response.headers.pop('ETag', None)
        response.headers.pop('Last-Modified', None)
    return response

SETTINGS_FILE = Path('config/settings.json')
SETTINGS_LOCK = threading.Lock()

def deep_merge(target: dict, source: dict) -> dict:
    """Combina recursivamente dos diccionarios para preservar claves anidadas."""
    for k, v in source.items():
        if isinstance(v, dict) and k in target and isinstance(target[k], dict):
            deep_merge(target[k], v)
        else:
            target[k] = v
    return target

def get_all_settings():
    defaults = {
        'system_profile': 'auto',
        'storage_path': os.getenv('RECORDINGS_DIR', '/Volumes/ExternalData/Grabaciones_Camara'),
        'motion_threshold': int(os.getenv('MOTION_THRESHOLD', 4000)),
        'confidence_threshold': float(os.getenv('CONFIDENCE_THRESHOLD', 0.45)),
        'ai_motion_only': os.getenv('AI_MOTION_ONLY', 'true').lower() == 'true',
        'motion_detection': True,
        'object_detection': True,
        'continuous_recording': os.getenv('CONTINUOUS_RECORDING', 'false').lower() == 'true',
        'auto_tracking': True,
        'cameras': {
            'cam1': {
                'id': 'cam1',
                'name': 'Cámara 1 (Tuya PTZ)',
                'rtsp_url': os.getenv('RTSP_URL', 'rtsp://localhost:8554/Cámara_de_nubes/hd'),
                'ptz': True,
                'home_return_delay': 15.0
            },
            'cam2': {
                'id': 'cam2',
                'name': 'Cámara 2 (iCam365)',
                'rtsp_url': os.getenv('RTSP_URL_CAM2', 'rtsp://192.168.1.26:554/live/ch0'),
                'ptz': True,
                'home_return_delay': 8.0
            }
        }
    }
    with SETTINGS_LOCK:
        if SETTINGS_FILE.exists():
            try:
                with open(SETTINGS_FILE, 'r') as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        deep_merge(defaults, data)
            except Exception as e:
                logger.error(f"Error leyendo {SETTINGS_FILE}: {e}")
    return defaults

def get_storage_dir() -> Path:
    """Obtiene la ruta base para grabaciones y capturas de forma dinámica."""
    settings = get_all_settings()
    configured_path = settings.get('storage_path') or os.getenv('RECORDINGS_DIR', '/Volumes/ExternalData/Grabaciones_Camara')
    p = Path(configured_path)
    try:
        p.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        logger.warning(f"No se pudo acceder a la ruta configurada ({p}): {e}. Usando ./recordings")
        p = Path('./recordings')
        p.mkdir(parents=True, exist_ok=True)
    return p

def save_setting(key, value):
    """Guarda una clave en settings.json de manera thread-safe y atómica."""
    with SETTINGS_LOCK:
        # Cargar configuración existente directamente bajo el lock
        current_data = {}
        if SETTINGS_FILE.exists():
            try:
                with open(SETTINGS_FILE, 'r') as f:
                    current_data = json.load(f)
            except Exception as e:
                logger.error(f"Error cargando archivo previo en save_setting: {e}")
        
        # Si la clave es 'cameras', fusionar por cámara para no sobreescribir la otra cámara
        if key == 'cameras' and isinstance(value, dict):
            cams_dict = current_data.setdefault('cameras', {})
            for cid, cval in value.items():
                if isinstance(cval, dict):
                    if cid not in cams_dict:
                        cams_dict[cid] = {}
                    deep_merge(cams_dict[cid], cval)
                else:
                    cams_dict[cid] = cval
        else:
            current_data[key] = value

        # Escritura atómica a archivo temporal y reemplazo
        tmp_file = SETTINGS_FILE.with_suffix('.tmp')
        try:
            SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp_file, 'w') as f:
                json.dump(current_data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_file, SETTINGS_FILE)
        except Exception as e:
            logger.error(f"Error guardando atómicamente {SETTINGS_FILE}: {e}")
            if tmp_file.exists():
                try: tmp_file.unlink()
                except Exception: pass

# Diccionario de cámaras del sistema
cameras = {
    'cam1': {
        'id': 'cam1',
        'name': 'Cámara 1 (Tuya PTZ)',
        'rtsp_url': os.getenv('RTSP_URL', 'rtsp://localhost:8554/Cámara_de_nubes/hd'),
        'has_ptz': True,
        'stream': None,
        'motion': None,
        'recorder': None,
        'cached_detections': [],
        'cached_motion_boxes': [],
        'ai_fps': 0.0,
        'last_alert_time': 0,
        'lock': threading.Lock()
    },
    'cam2': {
        'id': 'cam2',
        'name': 'Cámara 2 (iCam365)',
        'rtsp_url': os.getenv('RTSP_URL_CAM2', 'rtsp://192.168.1.26:554/live/ch0'),
        'has_ptz': False,
        'stream': None,
        'motion': None,
        'recorder': None,
        'cached_detections': [],
        'cached_motion_boxes': [],
        'ai_fps': 0.0,
        'last_alert_time': 0,
        'lock': threading.Lock()
    }
}

# Componentes globales compartidos
object_detector = None
alert_system = None
ptz_controller = None
icam_ptz = None
system_profiler = None

ALERT_COOLDOWN = int(os.getenv('ALERT_COOLDOWN', 5))
event_queues = []
event_lock = threading.Lock()
ai_worker_running = True

def get_lan_ip():
    """Detecta la IP local de red del equipo para acceso desde smartphones y PCs."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()

def broadcast_event(event_data):
    """Transmite eventos en tiempo real a todos los navegadores conectados vía SSE."""
    with event_lock:
        dead = []
        for q in event_queues:
            try:
                q.put_nowait(event_data)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in event_queues:
                event_queues.remove(q)

def is_motion_capture_allowed(camera_id='cam1'):
    """
    Determina si en este momento está permitido tomar capturas y generar clips/alertas
    por movimiento según la programación horaria configurada por el usuario.
    Retorna (allowed: bool, reason: str).
    """
    settings = get_all_settings()
    sched = settings.get('motion_schedule', {})
    
    # Si la programación no está activa, opera 24/7 (siempre permitido)
    if not sched.get('enabled', False):
        return True, "24/7 Activo"
    
    target_cams = sched.get('target_cameras', ['cam1', 'cam2'])
    if camera_id not in target_cams:
        return True, "Cámara no restringida"
    
    now = datetime.now()
    cur_time = now.strftime('%H:%M')
    cur_day = now.weekday()  # 0=Lunes, 6=Domingo
    
    allowed_days = sched.get('days', [0, 1, 2, 3, 4, 5, 6])
    day_names = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
    if cur_day not in allowed_days:
        return False, f"Día no programado ({day_names[cur_day]})"
    
    start_time = sched.get('start_time', '22:00')
    end_time = sched.get('end_time', '06:00')
    
    if start_time <= end_time:
        # Mismo día (ej: 08:00 a 18:00)
        is_in_window = (start_time <= cur_time <= end_time)
    else:
        # Cruza medianoche (ej: 22:00 a 06:00)
        is_in_window = (cur_time >= start_time or cur_time <= end_time)
        
    if is_in_window:
        return True, f"Horario activo ({start_time} - {end_time})"
    else:
        return False, f"En reposo hasta las {start_time}"

def camera_ai_worker(cid):
    """Hilo de procesamiento inteligente por cámara (Movimiento + YOLOv8 + Auto-Tracking)."""
    cam = cameras[cid]
    logger.info(f"Iniciando hilo de inferencia IA para {cam['name']} ({cid})")
    fps_timestamps = []
    
    while ai_worker_running:
        try:
            stream = cam['stream']
            if stream is None or not stream.is_connected():
                time.sleep(0.2)
                continue
            
            frame = stream.read()
            if frame is None:
                time.sleep(0.03)
                continue
            
            # Mantener pre-buffer de 2s y alimentar frames si hay un clip de evento activo
            rec = cam.get('recorder')
            if rec:
                rec.feed_frame(frame)
            
            # 1. Detección de movimiento
            motion_det = cam['motion']
            motion_detected, motion_boxes, motion_area = False, [], 0
            if motion_det and motion_det.is_active() and cam.get('motion_detection', True):
                motion_detected, motion_boxes, motion_area = motion_det.detect(frame)
            
            # 2. Detección de objetos IA (YOLOv8 acelerado con Apple Silicon MPS)
            detections = []
            frame_cnt = cam.get('_ai_cnt', 0) + 1
            cam['_ai_cnt'] = frame_cnt
            
            # Si se rastreó un objetivo recientemente (últimos 3.0s), mantener inferencia al 100% de cuadros para tracking continuo
            now_t = time.time()
            is_actively_tracking = (now_t - cam.get('_last_target_seen_time', 0.0)) < 3.0
            
            # Ejecutar IA si hay movimiento, si el filtro IA está apagado, si estamos rastreando activamente, o cada 2 cuadros
            should_detect = (
                (not motion_det or not motion_det.is_ai_filter_enabled()) or
                motion_detected or
                is_actively_tracking or
                (cam.get('auto_tracking', True) and (frame_cnt % 2 == 0))
            )
            if object_detector and object_detector.is_active() and should_detect:
                detections = object_detector.detect(frame)
            
            # 3. Auto-Tracking individual en Cámara 1 (Tuya) o Cámara 2 (iCam365 ONVIF)
            ALLOWED_TARGET_CLASSES = {'person', 'car', 'truck', 'bus', 'motorcycle'}
            active_ptz = ptz_controller if cid == 'cam1' else icam_ptz
            cam_tracking_enabled = cam.get('auto_tracking', True) and (active_ptz and getattr(active_ptz, 'is_active', lambda: True)())
            
            if cam_tracking_enabled and active_ptz:
                track_bbox = None
                track_label = None
                if detections:
                    # Prioridad 1: Personas
                    persons = [d for d in detections if d['class'] == 'person']
                    if persons:
                        track_bbox = persons[0]['bbox']
                        track_label = "Persona"
                    else:
                        # Prioridad 2: Vehículos
                        vehicles = [d for d in detections if d['class'] in ALLOWED_TARGET_CLASSES]
                        if vehicles:
                            track_bbox = vehicles[0]['bbox']
                            track_label = vehicles[0]['label']
                
                if track_bbox:
                    cam['_last_target_seen_time'] = now_t
                    active_ptz.track_target(frame.shape, track_bbox, label=track_label)
            
            # 4. Grabación de videoclips por evento (si está activa para esta cámara)
            rec = cam['recorder']
            active_label = 'movimiento'
            valid_dets = [d for d in detections if d['class'] in ALLOWED_TARGET_CLASSES]
            if valid_dets:
                active_label = valid_dets[0]['class']
            cam_event_rec_enabled = cam.get('event_recording', True)
            if cam_event_rec_enabled and (motion_detected or valid_dets) and rec:
                rec.trigger_event_clip(label=active_label)
            
            # 5. Gestión de alertas y capturas fotográficas (las fotos JPG se rigen por el horario para no llenar el disco)
            now = time.time()
            can_alert = (now - cam['last_alert_time']) >= ALERT_COOLDOWN
            photo_allowed_by_sched, sched_msg = is_motion_capture_allowed(cid)
            
            has_ai_target = bool(valid_dets)
            has_motion = bool(motion_detected and motion_det and motion_det.is_active())
            
            if can_alert and (has_ai_target or has_motion):
                ai_filter = motion_det.is_ai_filter_enabled() if motion_det else True
                
                if ai_filter and object_detector and object_detector.is_active():
                    # Filtro IA activo: disparar si se detecta un objetivo inteligente (persona, auto, etc.)
                    primary = None
                    if valid_dets:
                        primary = valid_dets[0]
                    elif has_motion and motion_boxes:
                        matched = motion_det.match_with_ai(motion_boxes, valid_dets)
                        matched = [m for m in matched if m['class'] in ALLOWED_TARGET_CLASSES]
                        if matched:
                            primary = matched[0]
                    
                    if primary:
                        cam['last_alert_time'] = now
                        # Solo guardar foto JPG si está dentro del horario de capturas permitido
                        snap_name = rec.save_snapshot(frame, prefix=f"{cid}_{primary['class']}") if (rec and photo_allowed_by_sched) else None
                        clip_url = rec.trigger_event_clip(label=primary['class']) if rec else None
                        
                        if snap_name:
                            logger.info(f"📸 Foto guardada [{cam['name']}]: {snap_name} ({primary['label']} - {int(primary['confidence'] * 100)}%)")
                        
                        event_payload = {
                            'camera_id': cid,
                            'camera_name': cam['name'],
                            'type': primary['class'],
                            'label': primary['label'],
                            'confidence': int(primary['confidence'] * 100),
                            'message': f"[{cam['name']}] ¡{primary['label']} detectado/a! ({int(primary['confidence'] * 100)}%)",
                            'timestamp': datetime.now().isoformat(),
                            'snapshot': snap_name,
                            'clip': clip_url,
                            'is_ai': True
                        }
                        broadcast_event(event_payload)
                        if alert_system:
                            alert_system.trigger(primary['class'], event_payload['message'], event_payload)
                
                elif not ai_filter and has_motion:
                    # Filtro IA apagado: cualquier movimiento genera alerta (a menos que sea animal)
                    has_animal = any(d['class'] in ('dog', 'cat', 'bird') for d in detections)
                    if not has_animal:
                        cam['last_alert_time'] = now
                        snap_name = rec.save_snapshot(frame, prefix=f"{cid}_movimiento") if (rec and photo_allowed_by_sched) else None
                        clip_url = rec.trigger_event_clip(label='movimiento') if rec else None
                        
                        if snap_name:
                            logger.info(f"📸 Foto guardada [{cam['name']}]: {snap_name} (Movimiento)")
                            
                        event_payload = {
                            'camera_id': cid,
                            'camera_name': cam['name'],
                            'type': 'motion',
                            'label': 'Movimiento',
                            'confidence': 100,
                            'message': f"[{cam['name']}] Movimiento detectado en zona",
                            'timestamp': datetime.now().isoformat(),
                            'snapshot': snap_name,
                            'clip': clip_url,
                            'is_ai': False
                        }
                        broadcast_event(event_payload)
                        if alert_system:
                            alert_system.trigger('motion', event_payload['message'], event_payload)
            
            # Guardar en memoria compartida de la cámara
            with cam['lock']:
                cam['cached_detections'] = detections
                cam['cached_motion_boxes'] = motion_boxes
            
            # Métricas FPS de IA
            fps_timestamps.append(time.time())
            if len(fps_timestamps) > 20:
                fps_timestamps.pop(0)
            if len(fps_timestamps) > 1:
                dur = fps_timestamps[-1] - fps_timestamps[0]
                if dur > 0:
                    cam['ai_fps'] = round((len(fps_timestamps) - 1) / dur, 1)
            
            sleep_time = 0.12 if (motion_detected or detections) else 0.25
            time.sleep(sleep_time)
            
        except Exception as e:
            logger.error(f"Error en camera_ai_worker ({cid}): {e}", exc_info=True)
            time.sleep(0.5)

def camera_recording_feeder(cid):
    """Alimenta la grabación continua 24/7 de cada cámara."""
    cam = cameras[cid]
    logger.info(f"Hilo de grabación continua 24/7 iniciado para {cam['name']}")
    while ai_worker_running:
        try:
            stream = cam['stream']
            rec = cam['recorder']
            if stream and stream.is_connected() and rec and rec.is_continuous_active() and cam.get('continuous_recording', True):
                frame = stream.read()
                if frame is not None:
                    rec.feed_frame(frame)
            time.sleep(0.06)
        except Exception as e:
            logger.error(f"Error en feeder ({cid}): {e}")
            time.sleep(1)

def init_components():
    global object_detector, alert_system, ptz_controller, icam_ptz, system_profiler
    
    settings = get_all_settings()
    
    # Diagnóstico automático de hardware y perfilado del sistema
    configured_profile = settings.get('system_profile', 'auto')
    system_profiler = SystemProfiler(settings_profile=configured_profile)
    system_profiler.print_startup_banner()
    effective_profile = system_profiler.active_profile
    
    # 1. Detector de objetos YOLOv8 compartido (con degradación elegante)
    conf_thresh = settings.get('confidence_threshold', 0.45)
    object_detector = ObjectDetector(confidence=conf_thresh)
    if effective_profile == 'light' or not object_detector.is_available() or not settings.get('object_detection', True):
        object_detector.active = False
        logger.info(f"Detector IA desactivado (Perfil: {effective_profile}, IA Disponible: {object_detector.is_available()})")
        
    alert_system = AlertSystem(cooldown=int(os.getenv('ALERT_COOLDOWN', 5)))
    
    # 2. Inicializar cámaras y grabadores
    base_rec_dir = str(get_storage_dir())
    seg_min = int(os.getenv('SEGMENT_MINUTES', 10))
    max_days = int(os.getenv('MAX_RECORDING_DAYS', 30))
    cont_rec = settings.get('continuous_recording', False)
    
    saved_cams = settings.get('cameras', {})
    for cid, cam in cameras.items():
        cam_conf = saved_cams.get(cid, {})
        if cid in saved_cams:
            cam['name'] = cam_conf.get('name', cam['name'])
            cam['rtsp_url'] = cam_conf.get('rtsp_url', cam['rtsp_url'])
        
        # Ajustes individuales por cámara (auto-acomodados al perfil)
        if effective_profile == 'light' or not object_detector.is_available():
            cam['ai_filter'] = False
            cam['auto_tracking'] = False
        else:
            cam['ai_filter'] = cam_conf.get('ai_filter', settings.get('ai_motion_only', True))
            cam['auto_tracking'] = cam_conf.get('auto_tracking', True)

        cam['event_recording'] = cam_conf.get('event_recording', True)
        cam['continuous_recording'] = cam_conf.get('continuous_recording', cont_rec)
        cam['motion_detection'] = cam_conf.get('motion_detection', settings.get('motion_detection', True))
        
        logger.info(f"Iniciando {cam['name']} -> {cam['rtsp_url']} (Tracking: {cam['auto_tracking']}, EventRec: {cam['event_recording']}, 24/7: {cam['continuous_recording']})")
        cam['stream'] = VideoStream(cam['rtsp_url'], fallback_url=cam_conf.get('fallback_url'))
        
        m_thresh = cam_conf.get('motion_threshold', settings.get('motion_threshold', 4000))
        m_det = MotionDetector(threshold=m_thresh)
        m_det.set_ai_filter(cam['ai_filter'])
        if not cam['motion_detection']:
            m_det.active = False
        cam['motion'] = m_det
        
        cam_dir = os.path.join(base_rec_dir, cid)
        cam_has_mic = (cid == 'cam1')  # Cámara 1 dispone de micrófono en su stream RTSP
        cam['recorder'] = Recorder(
            output_dir=cam_dir,
            rtsp_url=cam['rtsp_url'],
            segment_minutes=seg_min,
            max_days=max_days,
            continuous=cam['continuous_recording'],
            has_audio=cam_has_mic
        )
    
    # 3. Controlador PTZ para Cámara 1 (Tuya)
    bridge_url = os.getenv('TUYA_BRIDGE_URL', 'http://localhost:8787')
    device_id = os.getenv('TUYA_DEVICE_ID', 'bfd2e21c05dc99e44fkapz')
    auto_track = settings.get('auto_tracking', True)
    ptz_controller = PTZController(bridge_url=bridge_url, device_id=device_id, active=auto_track)
    
    # 4. Controlador PTZ para Cámara 2 (iCam365 ONVIF Profile S)
    icam_ptz = ICam365PTZController(ip='192.168.1.26', port=80)
    cameras['cam2']['has_ptz'] = True

    # Cargar demoras de retorno al Punto Central por cámara
    cam1_delay = saved_cams.get('cam1', {}).get('home_return_delay', 5)
    if ptz_controller: ptz_controller.set_home_delay(cam1_delay)
    cam2_delay = saved_cams.get('cam2', {}).get('home_return_delay', 5)
    if icam_ptz: icam_ptz.set_home_delay(cam2_delay)
    
    # 5. Lanzar hilos de trabajo independientes
    for cid in cameras:
        t_ai = threading.Thread(target=camera_ai_worker, args=(cid,), daemon=True, name=f"ai-{cid}")
        t_ai.start()
        
        t_rec = threading.Thread(target=camera_recording_feeder, args=(cid,), daemon=True, name=f"rec-{cid}")
        t_rec.start()
    
    logger.info("Sistema Multi-Cámara (Tuya + iCam365) completamente inicializado.")

# ----------------- RUTAS DE VIDEO MJPEG -----------------

def generate_frames(camera_id='cam1', quality_mode='efficient'):
    """
    Genera el flujo de cuadros MJPEG en tiempo real, fluido y con baja latencia.
    Elimina retrasos artificiales para que el video responda con la máxima fluidez de la cámara.
    """
    cam = cameras.get(camera_id, cameras['cam1'])
    stream = cam['stream']
    motion_det = cam['motion']
    
    # Configuración de resolución y compresión optimizada
    if quality_mode == 'mobile':
        target_size = (854, 480)
        jpeg_q = 75
    elif quality_mode == 'balanced':
        target_size = (1600, 900)
        jpeg_q = 85
    elif quality_mode == 'original':
        target_size = None
        jpeg_q = 88
    else:  # 'efficient' (predeterminado para PC, laptop y red local)
        target_size = (1280, 720)
        jpeg_q = 80
    
    last_frame_id = -1
    
    try:
        while True:
            if stream is None or not stream.is_connected():
                time.sleep(0.05)
                continue
            
            frame, frame_id = stream.read_with_count()
            if frame is None:
                time.sleep(0.01)
                continue
            
            # Solo enviar si la cámara ha producido un cuadro nuevo (evita desperdicio de red)
            if frame_id == last_frame_id:
                time.sleep(0.005)
                continue
            
            last_frame_id = frame_id
            
            # Reutilizar fotograma JPEG ya codificado si otro cliente o vista lo procesó
            cached_bytes = None
            with cam['lock']:
                if cam.get('_last_jpeg_fid') == frame_id and quality_mode in cam.get('_last_jpeg_cache', {}):
                    cached_bytes = cam['_last_jpeg_cache'][quality_mode]
            
            if cached_bytes is not None:
                frame_bytes = cached_bytes
            else:
                display_frame = frame
                with cam['lock']:
                    dets = list(cam['cached_detections'])
                    mboxes = list(cam['cached_motion_boxes'])
                
                if motion_det and motion_det.is_active() and mboxes:
                    display_frame = motion_det.draw_motion_overlay(display_frame, mboxes)
                
                if object_detector and object_detector.is_active() and dets:
                    display_frame = object_detector.draw_detections(display_frame, dets)
                
                # Reducción inteligente: SOLO reducir si el fotograma nativo excede target_size.
                # NUNCA escalar hacia arriba para evitar distorsión, borrosidad y pixelado ("se ve feo").
                if target_size:
                    cur_h, cur_w = display_frame.shape[:2]
                    if cur_w > target_size[0] or cur_h > target_size[1]:
                        display_frame = cv2.resize(display_frame, target_size, interpolation=cv2.INTER_AREA)
                
                ret, buffer = cv2.imencode('.jpg', display_frame, [cv2.IMWRITE_JPEG_QUALITY, jpeg_q])
                if not ret:
                    continue
                
                frame_bytes = buffer.tobytes()
                with cam['lock']:
                    if cam.get('_last_jpeg_fid') != frame_id:
                        cam['_last_jpeg_fid'] = frame_id
                        cam['_last_jpeg_cache'] = {}
                    cam['_last_jpeg_cache'][quality_mode] = frame_bytes
            
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n'
                   b'Content-Length: ' + str(len(frame_bytes)).encode() + b'\r\n\r\n' +
                   frame_bytes + b'\r\n')
            
            time.sleep(0.002)
    except GeneratorExit:
        pass
    except Exception as e:
        logger.error(f"Error en generate_frames ({camera_id}): {e}")

@app.route('/video_feed/<camera_id>')
def video_feed_cam(camera_id):
    if camera_id not in cameras:
        camera_id = 'cam1'
    quality_mode = request.args.get('quality', '').lower()
    if not quality_mode or quality_mode not in ('mobile', 'efficient', 'balanced', 'original'):
        quality_mode = 'efficient'
    
    return Response(
        generate_frames(camera_id, quality_mode=quality_mode),
        mimetype='multipart/x-mixed-replace; boundary=frame',
        headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate, pre-check=0, post-check=0, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Accel-Buffering': 'no'
        }
    )

@app.route('/video_feed')
def video_feed():
    return video_feed_cam('cam1')

@app.route('/api/camera/<camera_id>/live_frame')
def camera_live_frame(camera_id):
    """
    Entrega el fotograma individual más reciente en memoria.
    Diseñado para clientes móviles con bucle Canvas (latencia estricta de 30-50ms sin acumulación de búfer).
    """
    if camera_id not in cameras:
        camera_id = 'cam1'
    cam = cameras[camera_id]
    stream = cam.get('stream')
    if stream is None or not stream.is_connected():
        return ('', 204)

    frame, frame_id = stream.read_with_count()
    if frame is None or frame.size == 0:
        return ('', 204)

    quality = request.args.get('quality', 'mobile').lower()
    if quality not in ('mobile', 'efficient', 'balanced', 'original'):
        quality = 'mobile'

    with cam['lock']:
        if cam.get('_last_jpeg_fid') == frame_id and quality in cam.get('_last_jpeg_cache', {}):
            frame_bytes = cam['_last_jpeg_cache'][quality]
        else:
            display_frame = frame
            dets = list(cam.get('cached_detections', []))
            mboxes = list(cam.get('cached_motion_boxes', []))
            motion_det = cam.get('motion')
            if motion_det and motion_det.is_active() and mboxes:
                display_frame = motion_det.draw_motion_overlay(display_frame, mboxes)
            if object_detector and object_detector.is_active() and dets:
                display_frame = object_detector.draw_detections(display_frame, dets)

            target_sz = (854, 480) if quality == 'mobile' else ((1280, 720) if quality == 'efficient' else None)
            if target_sz:
                cur_h, cur_w = display_frame.shape[:2]
                if cur_w > target_sz[0] or cur_h > target_sz[1]:
                    display_frame = cv2.resize(display_frame, target_sz, interpolation=cv2.INTER_AREA)

            q_val = 75 if quality == 'mobile' else (80 if quality == 'efficient' else 85)
            ret, buf = cv2.imencode('.jpg', display_frame, [cv2.IMWRITE_JPEG_QUALITY, q_val, cv2.IMWRITE_JPEG_OPTIMIZE, 0])
            if not ret:
                return ('', 500)
            frame_bytes = buf.tobytes()
            if cam.get('_last_jpeg_fid') != frame_id:
                cam['_last_jpeg_fid'] = frame_id
                cam['_last_jpeg_cache'] = {}
            cam['_last_jpeg_cache'][quality] = frame_bytes

    return Response(
        frame_bytes,
        mimetype='image/jpeg',
        headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Frame-ID': str(frame_id)
        }
    )

@app.route('/m')
@app.route('/mobile')
def mobile_view():
    """Apartado exclusivo para celulares con reproductor Canvas de latencia cero."""
    lan_ip = get_lan_ip()
    port = int(os.getenv('WEB_PORT', 5001))
    sv = _static_version()
    settings = get_all_settings()
    prof_data = system_profiler.get_summary() if system_profiler else SystemProfiler().get_summary()
    return render_template(
        'mobile.html',
        lan_ip=lan_ip,
        port=port,
        static_version=sv,
        cameras=settings.get('cameras', {}),
        system_profile=prof_data
    )

@app.route('/api/system/capabilities', methods=['GET'])
def system_capabilities():
    """Retorna el diagnóstico completo de hardware, perfil activo y funciones soportadas."""
    if system_profiler:
        return jsonify(system_profiler.get_summary())
    temp_p = SystemProfiler()
    return jsonify(temp_p.get_summary())

@app.route('/api/system/profile', methods=['POST'])
def update_system_profile():
    """Cambia el perfil de rendimiento ('auto', 'light', 'balanced', 'performance') en caliente."""
    global object_detector, system_profiler
    data = request.json or {}
    new_profile = data.get('profile', 'auto')
    if new_profile not in ('auto', 'light', 'balanced', 'performance'):
        return jsonify({'success': False, 'error': f"Perfil '{new_profile}' no es válido."}), 400

    save_setting('system_profile', new_profile)
    if not system_profiler:
        system_profiler = SystemProfiler(settings_profile=new_profile)
    else:
        system_profiler.set_profile(new_profile)

    effective_prof = system_profiler.active_profile
    ai_available = system_profiler.ai_info.get('is_available', False)

    # Auto-acomodación en tiempo real de detectores y cámaras
    if effective_prof == 'light' or not ai_available:
        if object_detector:
            object_detector.active = False
        for cid, cam in cameras.items():
            cam['ai_filter'] = False
            cam['auto_tracking'] = False
            if cam.get('motion'):
                cam['motion'].set_ai_filter(False)
        logger.info(f"Sistema reconfigurado en caliente a Modo NVR Ligero ({effective_prof})")
    elif effective_prof in ('balanced', 'performance'):
        if object_detector and ai_available:
            object_detector.active = True
        for cid, cam in cameras.items():
            cam['ai_filter'] = True
            cam['auto_tracking'] = True
            if cam.get('motion'):
                cam['motion'].set_ai_filter(True)
        logger.info(f"Sistema reconfigurado en caliente a Modo IA ({effective_prof})")

    return jsonify({'success': True, 'summary': system_profiler.get_summary()})

@app.route('/api/scanner/presets')
def scanner_presets():
    """Retorna plantillas de conexión para marcas de cámaras chinas y comerciales."""
    return jsonify(CAMERA_PRESETS)

@app.route('/api/scanner/discover', methods=['GET', 'POST'])
def scanner_discover():
    """Escanea la red local y retorna las cámaras descubiertas (ONVIF + puertos RTSP)."""
    try:
        res = scan_network_cameras()
        return jsonify(res)
    except Exception as e:
        logger.error(f"Error en scanner_discover: {e}")
        return jsonify({'error': str(e), 'count': 0, 'devices': []}), 500

@app.route('/api/scanner/test_stream', methods=['POST'])
def scanner_test_stream():
    """Prueba si una URL RTSP responde con video."""
    data = request.json or {}
    rtsp_url = data.get('rtsp_url', '').strip()
    result = test_rtsp_connection(rtsp_url)
    return jsonify(result)

@app.route('/api/settings/storage', methods=['GET', 'POST'])
def settings_storage():
    """Consulta o actualiza la ruta de almacenamiento de grabaciones."""
    if request.method == 'POST':
        data = request.json or {}
        new_path = data.get('storage_path', '').strip()
        if not new_path:
            return jsonify({'success': False, 'error': 'Ruta vacía'}), 400
        p = Path(new_path)
        try:
            p.mkdir(parents=True, exist_ok=True)
            save_setting('storage_path', str(p.resolve()))
            return jsonify({'success': True, 'storage_path': str(p.resolve())})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 400
    else:
        return jsonify({'storage_path': str(get_storage_dir())})

# ----------------- RUTAS DE LA API Y WEB -----------------

@app.route('/')
def index():
    lan_ip = get_lan_ip()
    port = int(os.getenv('WEB_PORT', 5001))
    settings = get_all_settings()
    sens_val = settings.get('motion_threshold', 4000)
    conf_val = int(settings.get('confidence_threshold', 0.45) * 100)
    sv = _static_version()
    prof_data = system_profiler.get_summary() if system_profiler else SystemProfiler().get_summary()
    return render_template(
        'index.html',
        lan_ip=lan_ip,
        port=port,
        sens_val=sens_val,
        conf_val=conf_val,
        static_version=sv,
        system_profile=prof_data
    )

@app.route('/api/status')
def status():
    lan_ip = get_lan_ip()
    port = int(os.getenv('WEB_PORT', 5001))
    settings = get_all_settings()
    
    cams_status = {}
    total_online = False
    for cid, c in cameras.items():
        st = c['stream']
        online = st.is_connected() if st else False
        if online:
            total_online = True
        # Obtener demora de retorno configurada
        cam_home_delay = 5.0
        if cid == 'cam1' and ptz_controller:
            cam_home_delay = getattr(ptz_controller, 'home_return_delay', 5.0)
        elif cid == 'cam2' and icam_ptz:
            cam_home_delay = getattr(icam_ptz, 'home_return_delay', 5.0)

        cams_status[cid] = {
            'id': cid,
            'name': c['name'],
            'online': online,
            'stream_fps': round(st.get_fps(), 1) if st else 0.0,
            'ai_fps': round(c['ai_fps'], 1),
            'resolution': st.get_resolution() if st else {'width': 0, 'height': 0},
            'has_ptz': c['has_ptz'],
            'continuous_recording': c.get('continuous_recording', False) and (c['recorder'].is_continuous_active() if c['recorder'] else False),
            'motion_detection': c.get('motion_detection', True) and (c['motion'].is_active() if c['motion'] else False),
            'event_recording': c.get('event_recording', True),
            'auto_tracking': c.get('auto_tracking', True),
            'ai_filter': c['motion'].is_ai_filter_enabled() if c['motion'] else True,
            'motion_threshold': c['motion'].threshold if c['motion'] else 4000,
            'home_return_delay': cam_home_delay,
            'stream_fallback': st.is_using_fallback() if st and hasattr(st, 'is_using_fallback') else False
        }
    
    # Almacenamiento combinado
    storage = cameras['cam1']['recorder'].get_storage_info() if cameras['cam1']['recorder'] else {}
    
    return jsonify({
        'camera': total_online,
        'cameras': cams_status,
        'lan_ip': lan_ip,
        'local_url': f"http://{lan_ip}:{port}",
        'port': port,
        'motion_detection': any(c['motion'].is_active() for c in cameras.values() if c['motion']),
        'object_detection': object_detector.is_active() if object_detector else False,
        'ai_motion_only': any(c['motion'].is_ai_filter_enabled() for c in cameras.values() if c['motion']),
        'continuous_recording': any(c['recorder'].is_continuous_active() for c in cameras.values() if c['recorder']),
        'auto_tracking': ptz_controller.is_active() if ptz_controller else False,
        'ptz_status': ptz_controller.get_status() if ptz_controller else {},
        'icam_ptz_status': icam_ptz.get_status() if icam_ptz else {},
        'motion_schedule': {
            'enabled': settings.get('motion_schedule', {}).get('enabled', False),
            'start_time': settings.get('motion_schedule', {}).get('start_time', '22:00'),
            'end_time': settings.get('motion_schedule', {}).get('end_time', '06:00'),
            'days': settings.get('motion_schedule', {}).get('days', [0, 1, 2, 3, 4, 5, 6]),
            'target_cameras': settings.get('motion_schedule', {}).get('target_cameras', ['cam1', 'cam2']),
            'is_active_now': is_motion_capture_allowed('cam1')[0],
            'status_message': is_motion_capture_allowed('cam1')[1]
        },
        'storage': storage,
        'system_profile': system_profiler.get_summary() if system_profiler else SystemProfiler().get_summary(),
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/schedule', methods=['GET', 'POST'])
def schedule_route():
    settings = get_all_settings()
    if request.method == 'POST':
        data = request.get_json(force=True, silent=True) or {}
        sched = settings.get('motion_schedule', {})
        if 'enabled' in data:
            sched['enabled'] = bool(data['enabled'])
        if 'start_time' in data:
            sched['start_time'] = str(data['start_time'])
        if 'end_time' in data:
            sched['end_time'] = str(data['end_time'])
        if 'days' in data:
            sched['days'] = list(data['days'])
        if 'target_cameras' in data:
            sched['target_cameras'] = list(data['target_cameras'])
        
        save_setting('motion_schedule', sched)
        logger.info(f"Programación de horarios actualizada: {sched}")
    
    sched = settings.get('motion_schedule', {
        'enabled': False,
        'start_time': '22:00',
        'end_time': '06:00',
        'days': [0, 1, 2, 3, 4, 5, 6],
        'target_cameras': ['cam1', 'cam2']
    })
    sched_allowed, sched_reason = is_motion_capture_allowed('cam1')
    return jsonify({
        'success': True,
        'schedule': sched,
        'is_active_now': sched_allowed,
        'status_message': sched_reason
    })

@app.route('/api/toggle-motion', methods=['POST'])
def toggle_motion():
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get('camera_id')
    if cid and cid in cameras:
        cam = cameras[cid]
        active = not cam.get('motion_detection', True)
        cam['motion_detection'] = active
        if cam['motion']:
            cam['motion'].active = active
        settings = get_all_settings()
        sc = settings.get('cameras', {})
        if cid not in sc: sc[cid] = {}
        sc[cid]['motion_detection'] = active
        save_setting('cameras', sc)
        return jsonify({'camera_id': cid, 'active': active})

    active = False
    for c in cameras.values():
        if c['motion']:
            active = c['motion'].toggle()
            c['motion_detection'] = active
    save_setting('motion_detection', active)
    return jsonify({'active': active})

@app.route('/api/toggle-objects', methods=['POST'])
def toggle_objects():
    if object_detector:
        active = object_detector.toggle()
        save_setting('object_detection', active)
        return jsonify({'active': active})
    return jsonify({'error': 'Detector IA no disponible'}), 500

@app.route('/api/toggle-ai-motion-only', methods=['POST'])
def toggle_ai_motion_only():
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get('camera_id')
    if cid and cid in cameras:
        cam = cameras[cid]
        if cam['motion']:
            enabled = cam['motion'].toggle_ai_filter()
            cam['ai_filter'] = enabled
            settings = get_all_settings()
            sc = settings.get('cameras', {})
            if cid not in sc: sc[cid] = {}
            sc[cid]['ai_filter'] = enabled
            save_setting('cameras', sc)
            return jsonify({'camera_id': cid, 'ai_motion_only': enabled})

    enabled = True
    for c in cameras.values():
        if c['motion']:
            enabled = c['motion'].toggle_ai_filter()
            c['ai_filter'] = enabled
    save_setting('ai_motion_only', enabled)
    return jsonify({'ai_motion_only': enabled})

@app.route('/api/toggle-continuous', methods=['POST'])
def toggle_continuous():
    data = request.get_json(silent=True) or {}
    cam_id = data.get('camera_id')
    
    if cam_id and cam_id in cameras:
        cam = cameras[cam_id]
        rec = cam['recorder']
        active = rec.toggle_continuous() if rec else False
        cam['continuous_recording'] = active
        settings = get_all_settings()
        sc = settings.get('cameras', {})
        if cam_id not in sc: sc[cam_id] = {}
        sc[cam_id]['continuous_recording'] = active
        save_setting('cameras', sc)
        return jsonify({'camera_id': cam_id, 'continuous_active': active})
    
    # Toggle para todas las cámaras
    active = False
    for c in cameras.values():
        if c['recorder']:
            active = c['recorder'].toggle_continuous()
            c['continuous_recording'] = active
    save_setting('continuous_recording', active)
    return jsonify({'continuous_active': active})

@app.route('/api/toggle-tracking', methods=['POST'])
def toggle_tracking():
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get('camera_id')
    if cid and cid in cameras:
        current = cameras[cid].get('auto_tracking', True)
        new_val = not current
        cameras[cid]['auto_tracking'] = new_val
        settings = get_all_settings()
        sc = settings.get('cameras', {})
        if cid not in sc: sc[cid] = {}
        sc[cid]['auto_tracking'] = new_val
        save_setting('cameras', sc)
        return jsonify({'camera_id': cid, 'auto_tracking': new_val, 'active': new_val})

    if ptz_controller:
        active = ptz_controller.toggle()
        save_setting('auto_tracking', active)
        return jsonify({'auto_tracking': active, 'active': active})
    return jsonify({'error': 'Controlador PTZ no disponible'}), 500

@app.route('/api/toggle-event-recording', methods=['POST'])
def toggle_event_recording():
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get('camera_id')
    settings = get_all_settings()
    sc = settings.get('cameras', {})
    if cid and cid in cameras:
        current = cameras[cid].get('event_recording', True)
        new_val = not current
        cameras[cid]['event_recording'] = new_val
        if cid not in sc: sc[cid] = {}
        sc[cid]['event_recording'] = new_val
        save_setting('cameras', sc)
        return jsonify({'camera_id': cid, 'event_recording': new_val, 'active': new_val})
    
    any_active = any(c.get('event_recording', True) for c in cameras.values())
    new_val = not any_active
    for c in cameras.values():
        c['event_recording'] = new_val
    for cid in cameras:
        if cid not in sc: sc[cid] = {}
        sc[cid]['event_recording'] = new_val
    save_setting('cameras', sc)
    return jsonify({'event_recording': new_val, 'active': new_val})

@app.route('/api/camera/<cid>/settings', methods=['GET', 'POST'])
@app.route('/api/cameras/<cid>/config', methods=['GET', 'POST'])
def camera_settings_route(cid):
    if cid not in cameras:
        return jsonify({'success': False, 'error': f'Cámara {cid} no encontrada'}), 404
    
    cam = cameras[cid]
    settings = get_all_settings()
    sc = settings.get('cameras', {})
    if cid not in sc: sc[cid] = {}
    
    if request.method == 'POST':
        data = request.get_json(force=True, silent=True) or {}
        if 'motion_detection' in data:
            val = bool(data['motion_detection'])
            cam['motion_detection'] = val
            if cam['motion']: cam['motion'].active = val
            sc[cid]['motion_detection'] = val
            
        if 'event_recording' in data:
            val = bool(data['event_recording'])
            cam['event_recording'] = val
            sc[cid]['event_recording'] = val
            
        if 'auto_tracking' in data:
            val = bool(data['auto_tracking'])
            cam['auto_tracking'] = val
            sc[cid]['auto_tracking'] = val
            if cid == 'cam2' and icam_ptz:
                icam_ptz.set_active(val)
            elif cid == 'cam1' and ptz_controller:
                ptz_controller.set_active(val)
            
        if 'continuous_recording' in data:
            val = bool(data['continuous_recording'])
            cam['continuous_recording'] = val
            if cam['recorder']:
                cam['recorder'].set_continuous(val)
            sc[cid]['continuous_recording'] = val
            
        if 'ai_filter' in data:
            val = bool(data['ai_filter'])
            cam['ai_filter'] = val
            if cam['motion']: cam['motion'].set_ai_filter(val)
            sc[cid]['ai_filter'] = val
            
        if 'motion_threshold' in data:
            val = int(data['motion_threshold'])
            if cam['motion']: cam['motion'].threshold = val
            sc[cid]['motion_threshold'] = val

        if 'home_return_delay' in data:
            try:
                h_delay = max(2.0, float(data['home_return_delay']))
                sc[cid]['home_return_delay'] = h_delay
                if cid == 'cam2' and icam_ptz:
                    icam_ptz.set_home_delay(h_delay)
                elif cid == 'cam1' and ptz_controller:
                    ptz_controller.set_home_delay(h_delay)
            except Exception: pass
            
        save_setting('cameras', sc)
        logger.info(f"Configuración guardada para {cam['name']}: {sc[cid]}")
    
    h_delay = 5.0
    if cid == 'cam1' and ptz_controller:
        h_delay = getattr(ptz_controller, 'home_return_delay', 5.0)
    elif cid == 'cam2' and icam_ptz:
        h_delay = getattr(icam_ptz, 'home_return_delay', 5.0)

    return jsonify({
        'success': True,
        'camera_id': cid,
        'name': cam['name'],
        'settings': {
            'motion_detection': cam.get('motion_detection', True),
            'event_recording': cam.get('event_recording', True),
            'auto_tracking': cam.get('auto_tracking', True),
            'continuous_recording': cam.get('continuous_recording', False),
            'ai_filter': cam['motion'].is_ai_filter_enabled() if cam['motion'] else True,
            'motion_threshold': cam['motion'].threshold if cam['motion'] else 4000,
            'home_return_delay': h_delay
        }
    })

@app.route('/api/camera/<cid>/restart', methods=['POST'])
def restart_camera_route(cid):
    if cid not in cameras:
        return jsonify({'success': False, 'error': f'Cámara {cid} no encontrada'}), 404
    
    cam = cameras[cid]
    logger.info(f"Solicitud de reinicio manual para {cid} ({cam['name']})")
    
    # Si es cam1 (Tuya) o usa el bridge en el puerto 8554, notificar también al bridge Tuya
    if cid == 'cam1' or '8554' in str(cam.get('rtsp_url', '')):
        try:
            import urllib.request
            req = urllib.request.Request("http://127.0.0.1:8787/api/restart/rtsp", data=b'{}', headers={'Content-Type': 'application/json'}, method='POST')
            urllib.request.urlopen(req, timeout=4)
            time.sleep(1.0)
        except Exception as e:
            logger.warning(f"No se pudo contactar tuya-rtsp-bridge (:8787): {e}")

    stream = cam.get('stream')
    if stream:
        try:
            stream.stop()
        except Exception as e:
            logger.warning(f"Error al detener stream {cid}: {e}")
    
    time.sleep(0.5)
    cam['stream'] = VideoStream(cam['rtsp_url'], fallback_url=cam.get('fallback_url'))
    return jsonify({'success': True, 'message': f'Cámara {cid} reiniciada correctamente'})

@app.route('/api/ptz/move', methods=['POST'])
def ptz_move():
    data = request.get_json(force=True, silent=True) or {}
    direction = data.get('direction', 'stop')
    cid = data.get('camera_id') or data.get('camera') or 'cam1'
    dur = data.get('duration')
    
    if cid == 'cam2':
        if icam_ptz:
            if direction != 'stop' and dur and float(dur) > 0:
                success = icam_ptz.pulse_move(direction, duration=float(dur))
            else:
                success = icam_ptz.manual_move(direction)
            return jsonify({'success': success, 'direction': direction, 'camera_id': 'cam2'})
        return jsonify({'error': 'Controlador PTZ iCam365 no disponible'}), 500
    else:
        if ptz_controller:
            if direction != 'stop' and dur and float(dur) > 0:
                success = ptz_controller.pulse_move(direction, duration=float(dur))
            else:
                success = ptz_controller.manual_move(direction)
            return jsonify({'success': success, 'direction': direction, 'camera_id': 'cam1'})
        return jsonify({'error': 'Controlador PTZ no disponible'}), 500

@app.route('/api/ptz/cam2/config', methods=['POST'])
def ptz_cam2_config():
    data = request.get_json(force=True, silent=True) or {}
    pwd = data.get('password', '')
    user = data.get('username', 'admin')
    save_setting('cam2_ptz_password', pwd)
    save_setting('cam2_ptz_user', user)
    if icam_ptz:
        icam_ptz.set_credentials(user, pwd)
        test_res = icam_ptz.test_connection()
        return jsonify({'success': True, 'test': test_res})
    return jsonify({'success': False, 'error': 'Controlador no inicializado'}), 500

@app.route('/api/ptz/home/set', methods=['POST'])
def ptz_set_home():
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get('camera_id') or data.get('camera') or 'cam1'
    if cid == 'cam2':
        if icam_ptz:
            success = icam_ptz.set_home_position()
            return jsonify({'success': success, 'camera_id': 'cam2', 'message': 'Punto Central fijado para Cámara 2'})
        return jsonify({'success': False, 'error': 'Controlador PTZ Cámara 2 no disponible'}), 500
    else:
        if ptz_controller:
            success = ptz_controller.set_home_position()
            return jsonify({'success': success, 'camera_id': 'cam1', 'message': 'Punto Central fijado para Cámara 1'})
        return jsonify({'success': False, 'error': 'Controlador PTZ Cámara 1 no disponible'}), 500

@app.route('/api/ptz/home', methods=['POST'])
@app.route('/api/ptz/home/go', methods=['POST'])
def ptz_go_home():
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get('camera_id') or data.get('camera') or 'cam1'
    if cid == 'cam2':
        if icam_ptz:
            success = icam_ptz.return_to_home()
            return jsonify({'success': success, 'camera_id': 'cam2', 'message': 'Retornando al Punto Central en Cámara 2'})
        return jsonify({'success': False, 'error': 'Controlador PTZ Cámara 2 no disponible'}), 500
    else:
        if ptz_controller:
            success = ptz_controller.return_to_home()
            return jsonify({'success': success, 'camera_id': 'cam1', 'message': 'Retornando al Punto Central en Cámara 1'})
        return jsonify({'success': False, 'error': 'Controlador PTZ Cámara 1 no disponible'}), 500

@app.route('/api/ptz/home/delay', methods=['POST'])
def set_home_delay_route():
    data = request.get_json(force=True, silent=True) or {}
    delay = max(2.0, float(data.get('delay', 5)))
    cid = data.get('camera_id') or data.get('camera') or 'cam1'
    if cid == 'cam2' and icam_ptz:
        icam_ptz.set_home_delay(delay)
    elif cid == 'cam1' and ptz_controller:
        ptz_controller.set_home_delay(delay)
    
    settings = get_all_settings()
    sc = settings.get('cameras', {})
    if cid not in sc: sc[cid] = {}
    sc[cid]['home_return_delay'] = delay
    save_setting('cameras', sc)
    return jsonify({'success': True, 'camera_id': cid, 'home_return_delay': delay})


@app.route('/api/snapshot', defaults={'camera_id': None}, methods=['POST'])
@app.route('/api/snapshot/<camera_id>', methods=['POST'])
def take_snapshot(camera_id):
    cid = camera_id or 'cam1'
    cam = cameras.get(cid, cameras['cam1'])
    stream = cam['stream']
    rec = cam['recorder']
    
    frame = None
    if stream:
        frame = stream.read()
    if frame is None:
        with cam['lock']:
            if cam.get('frame') is not None:
                frame = cam['frame'].copy()
    
    if frame is not None:
        filename = None
        if rec:
            filename = rec.save_snapshot(frame, prefix=f"manual_{cid}")
        if not filename:
            snap_dir = get_storage_dir() / 'snapshots'
            snap_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]
            filename = f"manual_{cid}_{timestamp}.jpg"
            cv2.imwrite(str(snap_dir / filename), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        
        return jsonify({
            'success': True,
            'camera_id': cid,
            'camera_name': cam['name'],
            'filename': filename,
            'url': f"/snapshots/{filename}"
        })
    return jsonify({'error': 'No se pudo capturar snapshot'}), 500

@app.route('/api/storage')
def storage_info():
    if cameras['cam1']['recorder']:
        return jsonify(cameras['cam1']['recorder'].get_storage_info())
    return jsonify({'error': 'No disponible'}), 500

@app.route('/api/sensitivity', methods=['POST'])
def set_sensitivity():
    data = request.get_json(silent=True) or {}
    threshold = data.get('threshold')
    cid = data.get('camera_id')
    if threshold is not None:
        val = int(threshold)
        if cid and cid in cameras:
            if cameras[cid]['motion']:
                cameras[cid]['motion'].set_threshold(val)
            settings = get_all_settings()
            sc = settings.get('cameras', {})
            if cid not in sc: sc[cid] = {}
            sc[cid]['motion_threshold'] = val
            save_setting('cameras', sc)
            return jsonify({'camera_id': cid, 'threshold': val})

        for c in cameras.values():
            if c['motion']:
                c['motion'].set_threshold(val)
        save_setting('motion_threshold', val)
        return jsonify({'threshold': val})
    return jsonify({'error': 'Petición inválida'}), 400

@app.route('/api/confidence', methods=['POST'])
def set_confidence():
    data = request.get_json(silent=True) or {}
    confidence = data.get('confidence')
    if object_detector and confidence is not None:
        val = float(confidence)
        object_detector.set_confidence(val)
        save_setting('confidence_threshold', val)
        return jsonify({'confidence': val})
    return jsonify({'error': 'Petición inválida'}), 400

@app.route('/api/events')
def events():
    if alert_system:
        return jsonify(alert_system.get_recent_events())
    return jsonify([])

@app.route('/api/events/clear', methods=['POST'])
def clear_events():
    if alert_system:
        alert_system.clear_old_events(days=0)
        return jsonify({'success': True})
    return jsonify({'error': 'No disponible'}), 500

@app.route('/api/snapshots')
def get_snapshots():
    all_snaps = []
    for cid, c in cameras.items():
        rec = c['recorder']
        if rec:
            for s in rec.list_snapshots():
                s['camera_id'] = cid
                s['camera_name'] = c['name']
                all_snaps.append(s)
    all_snaps.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    return jsonify(all_snaps)

@app.route('/api/clips')
def get_clips():
    all_clips = []
    for cid, c in cameras.items():
        rec = c['recorder']
        if rec:
            for cl in rec.list_clips():
                cl['camera_id'] = cid
                cl['camera_name'] = c['name']
                all_clips.append(cl)
    all_clips.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    return jsonify(all_clips)

@app.route('/api/recordings/continuous')
def list_continuous_videos():
    all_segs = []
    for cid, c in cameras.items():
        rec = c['recorder']
        if rec:
            for seg in rec.list_continuous_segments():
                seg['camera_id'] = cid
                seg['camera_name'] = c['name']
                all_segs.append(seg)
    all_segs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    return jsonify(all_segs)

@app.route('/snapshots/<filename>')
def serve_snapshot(filename):
    for c in cameras.values():
        rec = c.get('recorder')
        if rec and (rec.snapshots_dir / filename).exists():
            return send_from_directory(str(rec.snapshots_dir), filename)
    # Compatibilidad con archivos antiguos en carpeta raíz
    legacy = get_storage_dir() / 'snapshots'
    if (legacy / filename).exists():
        return send_from_directory(str(legacy), filename)
    return 'No encontrado', 404

def _send_video_file(file_path):
    """
    Envía un archivo de video con soporte completo HTTP 206 (Range Requests),
    permitiendo adelantar/retroceder (seek) de forma instantánea sin bloquear
    los hilos de trabajo de Flask ni saturar la transmisión en vivo de las cámaras.
    """
    p = Path(file_path)
    if not p.exists():
        return 'No encontrado', 404
    return send_file(str(p), mimetype='video/mp4', conditional=True)

@app.route('/clips/<date>/<filename>')
def serve_clip(date, filename):
    for c in cameras.values():
        rec = c.get('recorder')
        if rec and (rec.clips_dir / date / filename).exists():
            return _send_video_file(rec.clips_dir / date / filename)
    legacy = get_storage_dir() / 'clips' / date
    if (legacy / filename).exists():
        return _send_video_file(legacy / filename)
    return 'No encontrado', 404

@app.route('/recordings/continuous/<date>/<filename>')
def serve_continuous_segment(date, filename):
    for c in cameras.values():
        rec = c.get('recorder')
        if rec and (rec.continuous_dir / date / filename).exists():
            return _send_video_file(rec.continuous_dir / date / filename)
    legacy = get_storage_dir() / 'continuous' / date
    if (legacy / filename).exists():
        return _send_video_file(legacy / filename)
    return 'No encontrado', 404
@app.route('/recordings')
def recordings_page():
    lan_ip = get_lan_ip()
    port = int(os.getenv('WEB_PORT', 5001))
    return render_template(
        'recordings.html',
        lan_ip=lan_ip,
        port=port
    )

def parse_media_time(filename, timestamp_iso):
    """Extrae hour (0-23) y time_str (HH:MM:SS) del nombre de archivo o timestamp."""
    try:
        import re
        m = re.search(r'(\d{8})_(\d{2})(\d{2})(\d{2})', filename)
        if m:
            h, mi, s = m.group(2), m.group(3), m.group(4)
            return int(h), f"{h}:{mi}:{s}"
    except Exception:
        pass
    try:
        if timestamp_iso:
            dt = datetime.fromisoformat(timestamp_iso)
            return dt.hour, dt.strftime("%H:%M:%S")
    except Exception:
        pass
    return 0, "00:00:00"

@app.route('/api/media')
def get_all_media():
    """Retorna lista unificada de todos los archivos multimedia con filtros."""
    filter_type = request.args.get('type', 'all')  # all | clip | continuous | snapshot
    filter_cam = request.args.get('camera_id', 'all') # all | cam1 | cam2
    filter_date = request.args.get('date', '') # YYYY-MM-DD
    filter_hour = request.args.get('hour', '') # 0..23
    
    media_list = []
    target_hour = int(filter_hour) if filter_hour.isdigit() else None
    
    for cid, c in cameras.items():
        if filter_cam != 'all' and filter_cam != cid:
            continue
        rec = c.get('recorder')
        if not rec:
            continue
        
        # 1. Clips de eventos
        if filter_type in ('all', 'clip'):
            for cl in rec.list_clips(limit=500):
                if filter_date and cl.get('day') != filter_date:
                    continue
                h, t_str = parse_media_time(cl['filename'], cl.get('timestamp'))
                if target_hour is not None and h != target_hour:
                    continue
                media_list.append({
                    'id': f"clip_{cid}_{cl['day']}_{cl['filename']}",
                    'camera_id': cid,
                    'camera_name': c['name'],
                    'type': 'clip',
                    'category': 'Evento IA/Movimiento',
                    'filename': cl['filename'],
                    'day': cl['day'],
                    'hour': h,
                    'time_str': t_str,
                    'size_mb': cl['size_mb'],
                    'timestamp': cl['timestamp'],
                    'url': cl['url']
                })
        
        # 2. Grabaciones continuas
        if filter_type in ('all', 'continuous'):
            for seg in rec.list_continuous_segments(limit=500):
                if filter_date and seg.get('day') != filter_date:
                    continue
                h, t_str = parse_media_time(seg['filename'], seg.get('timestamp'))
                if target_hour is not None and h != target_hour:
                    continue
                media_list.append({
                    'id': f"cont_{cid}_{seg['day']}_{seg['filename']}",
                    'camera_id': cid,
                    'camera_name': c['name'],
                    'type': 'continuous',
                    'category': 'Grabación 24/7',
                    'filename': seg['filename'],
                    'day': seg['day'],
                    'hour': h,
                    'time_str': t_str,
                    'size_mb': seg['size_mb'],
                    'timestamp': seg['timestamp'],
                    'url': seg['url']
                })
        
        # 3. Snapshots / Fotos
        if filter_type in ('all', 'snapshot'):
            for sn in rec.list_snapshots(limit=500):
                ts = sn.get('timestamp', '')
                sn_day = ts[:10] if ts else ''
                if filter_date and sn_day != filter_date:
                    continue
                h, t_str = parse_media_time(sn['filename'], ts)
                if target_hour is not None and h != target_hour:
                    continue
                size_mb = round(sn['size'] / (1024 * 1024), 2)
                media_list.append({
                    'id': f"snap_{cid}_{sn['filename']}",
                    'camera_id': cid,
                    'camera_name': c['name'],
                    'type': 'snapshot',
                    'category': 'Captura Fotográfica',
                    'filename': sn['filename'],
                    'day': sn_day,
                    'hour': h,
                    'time_str': t_str,
                    'size_mb': size_mb,
                    'timestamp': sn['timestamp'],
                    'url': f"/snapshots/{sn['filename']}"
                })
    
    # Ordenar por fecha y hora descendente
    media_list.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    return jsonify(media_list)

# Caché en memoria para /api/storage/estimate (evita recorrer cientos de archivos en cada petición)
_storage_estimate_cache = {'data': None, 'timestamp': 0}
_STORAGE_CACHE_TTL = 60  # segundos

@app.route('/api/storage/estimate')
def storage_estimate():
    """Retorna desglose del disco y cálculo de días restantes (con caché de 60s)."""
    now = time.time()
    if _storage_estimate_cache['data'] and (now - _storage_estimate_cache['timestamp'] < _STORAGE_CACHE_TTL):
        return jsonify(_storage_estimate_cache['data'])
    
    base_dir = get_storage_dir()
    try:
        total, used, free = shutil.disk_usage(str(base_dir))
        total_gb = round(total / (1024**3), 1)
        used_gb = round(used / (1024**3), 1)
        free_gb = round(free / (1024**3), 1)
        percent = int((used / total) * 100) if total > 0 else 0
    except Exception:
        total_gb, used_gb, free_gb, percent = 111.2, 0.5, 110.7, 1

    # Analizar desglose de cada cámara
    cams_breakdown = {}
    total_clips_mb = 0.0
    total_cont_mb = 0.0
    total_snaps_mb = 0.0
    any_continuous = False

    for cid, c in cameras.items():
        rec = c.get('recorder')
        if rec:
            metrics = rec.get_detailed_storage_metrics()
            cams_breakdown[cid] = metrics
            total_clips_mb += metrics.get('clips_mb', 0.0)
            total_cont_mb += metrics.get('continuous_mb', 0.0)
            total_snaps_mb += metrics.get('snapshots_mb', 0.0)
            if metrics.get('continuous_active'):
                any_continuous = True

    # Estimación de días restantes:
    # Modo solo eventos: ~2.5 GB al día para ambas cámaras
    # Modo continuo 24/7: ~48.0 GB al día para ambas cámaras a 1080p
    daily_rate = 48.0 if any_continuous else 2.5
    days_left = round(free_gb / daily_rate, 1) if daily_rate > 0 else 999.0

    result = {
        'base_path': str(base_dir),
        'total_gb': total_gb,
        'used_gb': used_gb,
        'free_gb': free_gb,
        'percent_used': percent,
        'mode': '24/7 Continuo' if any_continuous else 'Solo Eventos',
        'any_continuous': any_continuous,
        'daily_burn_gb': daily_rate,
        'days_remaining': days_left,
        'total_clips_mb': round(total_clips_mb, 1),
        'total_continuous_mb': round(total_cont_mb, 1),
        'total_snapshots_mb': round(total_snaps_mb, 1),
        'cameras': cams_breakdown
    }
    _storage_estimate_cache['data'] = result
    _storage_estimate_cache['timestamp'] = now
    return jsonify(result)

@app.route('/api/media/delete', methods=['POST'])
def delete_single_media():
    """Elimina un archivo específico del disco externo."""
    data = request.get_json(silent=True) or {}
    cid = data.get('camera_id')
    file_type = data.get('file_type') # clip | continuous | snapshot
    filename = data.get('filename')
    day = data.get('day')

    if not filename or not file_type:
        return jsonify({'success': False, 'error': 'Faltan parámetros requeridos'}), 400

    recorders_to_check = []
    if cid and cid in cameras and cameras[cid].get('recorder'):
        recorders_to_check.append(cameras[cid]['recorder'])
    else:
        recorders_to_check = [c['recorder'] for c in cameras.values() if c.get('recorder')]

    deleted = False
    for rec in recorders_to_check:
        if rec.delete_file(file_type, filename, day=day):
            deleted = True
            break

    return jsonify({'success': deleted, 'filename': filename})

@app.route('/api/media/bulk-delete', methods=['POST'])
def bulk_delete_media():
    """Elimina múltiples archivos o purga por días de antigüedad."""
    data = request.get_json(silent=True) or {}
    items = data.get('items', [])
    days_older_than = data.get('days_older_than')

    deleted_count = 0

    if days_older_than is not None:
        days = int(days_older_than)
        for c in cameras.values():
            rec = c.get('recorder')
            if rec:
                deleted_count += rec.bulk_delete_older_than(days)
        return jsonify({'success': True, 'deleted_count': deleted_count, 'mode': 'older_than', 'days': days})

    for it in items:
        cid = it.get('camera_id')
        file_type = it.get('file_type')
        filename = it.get('filename')
        day = it.get('day')
        if not filename or not file_type:
            continue
        rec = cameras.get(cid, {}).get('recorder') if cid else None
        if not rec:
            for c in cameras.values():
                if c.get('recorder') and c['recorder'].delete_file(file_type, filename, day=day):
                    deleted_count += 1
                    break
        else:
            if rec.delete_file(file_type, filename, day=day):
                deleted_count += 1

    return jsonify({'success': True, 'deleted_count': deleted_count})

@app.route('/events/stream')
def events_stream():
    """Stream de eventos Server-Sent Events (SSE) para el frontend."""
    q = Queue(maxsize=50)
    with event_lock:
        event_queues.append(q)
    
    def generate():
        try:
            while True:
                try:
                    event = q.get(timeout=25)
                    yield f"data: {json.dumps(event)}\n\n"
                except Exception:
                    yield ": keepalive\n\n"
        except GeneratorExit:
            with event_lock:
                if q in event_queues:
                    event_queues.remove(q)
    
    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        }
    )

@app.route('/api/shutdown', methods=['POST'])
def shutdown_system():
    logger.info("Solicitud de apagado del sistema recibida.")
    def do_shutdown():
        time.sleep(0.8)
        os.system("/bin/bash stop.sh &")
    threading.Thread(target=do_shutdown, daemon=True).start()
    return jsonify({'success': True, 'message': 'Sistema apagándose correctamente.'})

import atexit
import signal
import subprocess

def cleanup_on_exit(*args):
    logger.info("Cerrando aplicación y finalizando subprocesos...")
    for c in list(cameras.values()):
        rec = c.get('recorder')
        if rec:
            try:
                rec.stop()
            except Exception:
                pass
    try:
        subprocess.run(["pkill", "-9", "-f", "ffmpeg"], timeout=2)
    except Exception:
        pass

atexit.register(cleanup_on_exit)
try:
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))
    signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))
except Exception:
    pass

if __name__ == '__main__':
    init_components()
    port = int(os.getenv('WEB_PORT', 5001))
    lan_ip = get_lan_ip()
    storage = cameras['cam1']['recorder'].get_storage_info() if cameras['cam1']['recorder'] else {}
    
    print("\n" + "=" * 65)
    print("🚀 SISTEMA DE SEGURIDAD MULTI-CÁMARA IA INICIADO")
    print(f"📡 Acceso Local (Esta Mac):  http://localhost:{port}")
    print(f"📱 Acceso Móvil / Red LAN:   http://{lan_ip}:{port}")
    print(f"📹 Cámara 1 (Tuya PTZ):      {cameras['cam1']['rtsp_url']}")
    print(f"📹 Cámara 2 (iCam365):       {cameras['cam2']['rtsp_url']}")
    print(f"💾 Grabación Dual en:        {get_storage_dir()}")
    print("=" * 65 + "\n")
    
    app.run(host='0.0.0.0', port=port, threaded=True)
