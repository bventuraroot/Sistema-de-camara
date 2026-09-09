import os
import sys
import time
import socket
import re
import cv2
import numpy as np
import json
import threading
import shutil
from queue import Queue
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
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
        'max_recording_days': int(os.getenv('MAX_RECORDING_DAYS', 30)),
        'auto_purge_enabled': True,
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
                'rtsp_url': os.getenv('RTSP_URL_CAM2', 'rtsp://admin:admin@192.168.1.18:554/live/ch1'),
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
        'rtsp_url': os.getenv('RTSP_URL_CAM2', 'rtsp://admin:admin@192.168.1.18:554/live/ch1'),
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

def is_motion_capture_allowed(item_type='clip', camera_id='cam1'):
    """
    Determina si en este momento está permitido tomar capturas o generar clips/alertas
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
    
    # Verificar si el horario aplica al tipo específico de contenido
    apply_to_clips = sched.get('apply_to_clips', True)
    apply_to_snaps = sched.get('apply_to_snapshots', True)
    
    if item_type == 'clip' and not apply_to_clips:
        return True, "Clips 24/7 (Sin restricción)"
    if item_type in ('snapshot', 'photo', 'snap') and not apply_to_snaps:
        return True, "Fotos 24/7 (Sin restricción)"
    
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
            
            # 4. Grabación de videoclips por evento (si está activa para esta cámara y permitida por horario)
            rec = cam['recorder']
            active_label = 'movimiento'
            valid_dets = [d for d in detections if d['class'] in ALLOWED_TARGET_CLASSES]
            if valid_dets:
                active_label = valid_dets[0]['class']
            cam_event_rec_enabled = cam.get('event_recording', True)
            clip_allowed_by_sched, _ = is_motion_capture_allowed('clip', cid)
            if cam_event_rec_enabled and (motion_detected or valid_dets) and rec and clip_allowed_by_sched:
                rec.trigger_event_clip(label=active_label)
            
            # 5. Gestión de alertas y capturas fotográficas (fotos y clips se rigen por horario para no llenar el disco)
            now = time.time()
            can_alert = (now - cam['last_alert_time']) >= ALERT_COOLDOWN
            photo_allowed_by_sched, sched_msg = is_motion_capture_allowed('snapshot', cid)
            
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
                        # Solo guardar foto JPG o clip si está dentro del horario permitido
                        snap_name = rec.save_snapshot(frame, prefix=f"{cid}_{primary['class']}") if (rec and photo_allowed_by_sched) else None
                        clip_url = rec.trigger_event_clip(label=primary['class']) if (rec and clip_allowed_by_sched) else None
                        
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
                        clip_url = rec.trigger_event_clip(label='movimiento') if (rec and clip_allowed_by_sched) else None
                        
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
    """Alimenta la grabación continua 24/7 y buffer de eventos de cada cámara calibrado a 15 FPS."""
    cam = cameras[cid]
    logger.info(f"Hilo de grabación y eventos iniciado para {cam['name']}")
    last_fid = -1
    while ai_worker_running:
        try:
            stream = cam.get('stream')
            rec = cam.get('recorder')
            if not stream or not stream.is_connected() or not rec:
                time.sleep(0.25)
                continue
            
            is_cont = rec.is_continuous_active() and cam.get('continuous_recording', True)
            is_event = (rec.active_clip is not None)
            
            if is_cont or is_event:
                frame, frame_id = stream.read_with_count()
                if frame is not None and frame_id != last_fid:
                    last_fid = frame_id
                    rec.feed_frame(frame)
                time.sleep(0.06)  # ~15-16 FPS máximo, coincidiendo con la tasa del encoder (self.fps = 15.0)
            else:
                # Si no hay grabación continua ni evento, mantener el pre-buffer circular liviano (~4 FPS)
                frame = stream.read()
                if frame is not None:
                    with rec.pre_buffer_lock:
                        rec.pre_buffer.append(frame)
                time.sleep(0.25)
        except Exception as e:
            logger.error(f"Error en feeder ({cid}): {e}")
            time.sleep(0.5)

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
    max_days = int(settings.get('max_recording_days', os.getenv('MAX_RECORDING_DAYS', 30)))
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
    cam2_rtsp = saved_cams.get('cam2', {}).get('rtsp_url') or cameras.get('cam2', {}).get('rtsp_url') or ''
    ip_match = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', cam2_rtsp)
    cam2_ip = ip_match.group(1) if ip_match else '192.168.1.18'
    cam2_user = settings.get('cam2_ptz_user', 'admin')
    cam2_pwd = settings.get('cam2_ptz_password', 'admin')

    def get_cam2_live_ip():
        c_rtsp = cameras.get('cam2', {}).get('rtsp_url') or ''
        m = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', c_rtsp)
        return m.group(1) if m else '192.168.1.18'

    icam_ptz = ICam365PTZController(
        ip=cam2_ip,
        port=80,
        username=cam2_user,
        password=cam2_pwd,
        ip_getter=get_cam2_live_ip
    )
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
    Genera el flujo de cuadros MJPEG en tiempo real, ultra fluido y con latencia cercana a cero.
    """
    cam = cameras.get(camera_id, cameras['cam1'])
    stream = cam['stream']
    motion_det = cam['motion']
    
    # Configuración de resolución y compresión optimizada (Alta nitidez y fluidez)
    if quality_mode == 'mobile':
        target_size = (640, 360)
        jpeg_q = 55
    elif quality_mode == 'balanced':
        target_size = (1280, 720)
        jpeg_q = 72
    elif quality_mode == 'original':
        target_size = (1920, 1080)
        jpeg_q = 80
    else:  # 'efficient' (predeterminado para PC/Laptop: 960x540 nítido, ultra fluido y balanceado)
        target_size = (960, 540)
        jpeg_q = 68
    
    last_frame_id = -1
    
    try:
        while True:
            if stream is None or not stream.is_connected():
                # Enviar frame de reconexión elegante para que la conexión HTTP inicie de inmediato
                placeholder = np.zeros((360, 640, 3), dtype=np.uint8)
                placeholder[:] = (18, 24, 38)
                cv2.putText(placeholder, f"Conectando a {cam['name']}...", (140, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (148, 163, 184), 2, cv2.LINE_AA)
                ret, pbuf = cv2.imencode('.jpg', placeholder, [cv2.IMWRITE_JPEG_QUALITY, 60, cv2.IMWRITE_JPEG_OPTIMIZE, 0])
                if ret:
                    pbytes = pbuf.tobytes()
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n'
                           b'Content-Length: ' + str(len(pbytes)).encode() + b'\r\n\r\n' +
                           pbytes + b'\r\n')
                time.sleep(0.3)
                continue
            
            frame, frame_id = stream.read_with_count()
            if frame is None:
                time.sleep(0.01)
                continue
            
            # Solo enviar si la cámara ha producido un cuadro nuevo (evita desperdicio de red)
            if frame_id == last_frame_id:
                time.sleep(0.003)
                continue
            
            last_frame_id = frame_id
            
            # Reutilizar fotograma JPEG ya codificado si otro cliente o vista lo procesó
            cached_bytes = None
            dets = None
            mboxes = None
            with cam['lock']:
                if cam.get('_last_jpeg_fid') == frame_id and quality_mode in cam.get('_last_jpeg_cache', {}):
                    cached_bytes = cam['_last_jpeg_cache'][quality_mode]
                else:
                    dets = cam.get('cached_detections')
                    mboxes = cam.get('cached_motion_boxes')
            
            if cached_bytes is not None:
                frame_bytes = cached_bytes
            else:
                has_motion_draw = bool(motion_det and motion_det.is_active() and mboxes)
                has_ai_draw = bool(object_detector and object_detector.is_active() and dets)
                
                # Solo clonar la matriz en memoria si hay que pintar cajas de detección
                if has_motion_draw or has_ai_draw:
                    display_frame = frame.copy()
                    if has_motion_draw:
                        display_frame = motion_det.draw_motion_overlay(display_frame, mboxes)
                    if has_ai_draw:
                        display_frame = object_detector.draw_detections(display_frame, dets)
                else:
                    display_frame = frame
                
                # Reducción ultra-rápida (INTER_LINEAR: 2ms vs 12ms de INTER_AREA)
                if target_size:
                    cur_h, cur_w = display_frame.shape[:2]
                    if cur_w > target_size[0] or cur_h > target_size[1]:
                        display_frame = cv2.resize(display_frame, target_size, interpolation=cv2.INTER_LINEAR)
                
                ret, buffer = cv2.imencode('.jpg', display_frame, [cv2.IMWRITE_JPEG_QUALITY, jpeg_q, cv2.IMWRITE_JPEG_OPTIMIZE, 0])
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
                   b'X-Frame-ID: ' + str(frame_id).encode() + b'\r\n'
                   b'Content-Length: ' + str(len(frame_bytes)).encode() + b'\r\n\r\n' +
                   frame_bytes + b'\r\n')
            
            time.sleep(0.001)
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

    since_fid = request.args.get('since_fid', None)
    if since_fid is not None:
        try:
            if int(since_fid) == frame_id:
                return ('', 304)
        except ValueError:
            pass

    quality = request.args.get('quality', 'mobile').lower()
    if quality not in ('mobile', 'efficient', 'balanced', 'original'):
        quality = 'mobile'

    with cam['lock']:
        if cam.get('_last_jpeg_fid') == frame_id and quality in cam.get('_last_jpeg_cache', {}):
            frame_bytes = cam['_last_jpeg_cache'][quality]
        else:
            dets = list(cam.get('cached_detections', []))
            mboxes = list(cam.get('cached_motion_boxes', []))
            motion_det = cam.get('motion')
            
            has_motion_draw = bool(motion_det and motion_det.is_active() and mboxes)
            has_ai_draw = bool(object_detector and object_detector.is_active() and dets)
            
            if has_motion_draw or has_ai_draw:
                display_frame = frame.copy()
                if has_motion_draw:
                    display_frame = motion_det.draw_motion_overlay(display_frame, mboxes)
                if has_ai_draw:
                    display_frame = object_detector.draw_detections(display_frame, dets)
            else:
                display_frame = frame

            if quality == 'mobile':
                target_sz = (640, 360)
                q_val = 60
            elif quality == 'efficient':
                target_sz = (960, 540)
                q_val = 68
            elif quality == 'balanced':
                target_sz = (1280, 720)
                q_val = 72
            else:
                target_sz = None
                q_val = 80

            if target_sz:
                cur_h, cur_w = display_frame.shape[:2]
                if cur_w > target_sz[0] or cur_h > target_sz[1]:
                    display_frame = cv2.resize(display_frame, target_sz, interpolation=cv2.INTER_LINEAR)

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
            'X-Frame-ID': str(frame_id),
            'Access-Control-Expose-Headers': 'X-Frame-ID'
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
        data = request.json if request.is_json else {}
        custom_subnet = data.get('subnet') if data else request.args.get('subnet')
        res = scan_network_cameras(custom_subnet=custom_subnet)
        return jsonify(res)
    except Exception as e:
        logger.error(f"Error en scanner_discover: {e}", exc_info=True)
        return jsonify({'error': str(e), 'count': 0, 'devices': []}), 500

@app.route('/api/scanner/test_stream', methods=['POST'])
def scanner_test_stream():
    """Prueba si una URL RTSP responde con video en vivo y retorna resolución y latencia."""
    data = request.get_json(force=True, silent=True) or {}
    rtsp_url = data.get('rtsp_url', '').strip()
    result = test_rtsp_connection(rtsp_url)
    return jsonify(result)

@app.route('/api/scanner/apply', methods=['POST'])
@app.route('/api/camera/<cid>/update_url', methods=['POST'])
def scanner_apply_camera(cid=None):
    """
    Aplica una nueva IP / URL RTSP a una cámara específica, actualiza la configuración
    persistente y reinicia el flujo de video en caliente.
    """
    data = request.get_json(force=True, silent=True) or {}
    target_cid = cid or data.get('camera_id') or 'cam1'
    new_rtsp = data.get('rtsp_url', '').strip()
    new_name = data.get('name', '').strip()

    if target_cid not in cameras:
        return jsonify({'success': False, 'error': f'Cámara {target_cid} no existe'}), 404
    
    if not new_rtsp:
        return jsonify({'success': False, 'error': 'La URL RTSP no puede estar vacía'}), 400

    cam = cameras[target_cid]
    settings = get_all_settings()
    sc = settings.get('cameras', {})
    if target_cid not in sc:
        sc[target_cid] = {}

    sc[target_cid]['rtsp_url'] = new_rtsp
    if new_name:
        sc[target_cid]['name'] = new_name
        cam['name'] = new_name
    cam['rtsp_url'] = new_rtsp

    # Extraer IP de la nueva URL
    ip_match = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', new_rtsp)
    extracted_ip = ip_match.group(1) if ip_match else 'desconocida'

    if target_cid == 'cam2' and icam_ptz and ip_match:
        try:
            icam_ptz.update_ip(extracted_ip)
            logger.info(f"IP de PTZ iCam365 actualizada a {extracted_ip}")
        except Exception as e:
            logger.warning(f"No se pudo actualizar IP en icam_ptz: {e}")

    save_setting('cameras', sc)

    # Reiniciar stream de video en caliente
    old_stream = cam.get('stream')
    if old_stream:
        try:
            old_stream.stop()
        except Exception as e:
            logger.warning(f"Error deteniendo stream previo de {target_cid}: {e}")

    time.sleep(0.4)
    try:
        cam['stream'] = VideoStream(new_rtsp, fallback_url=cam.get('fallback_url'))
        logger.info(f"✅ Cámara {target_cid} reconectada exitosamente con URL: {new_rtsp}")
        return jsonify({
            'success': True,
            'camera_id': target_cid,
            'name': cam['name'],
            'rtsp_url': new_rtsp,
            'ip': extracted_ip,
            'message': f"Cámara '{cam['name']}' conectada a {extracted_ip}"
        })
    except Exception as e:
        logger.error(f"Error reiniciando stream tras cambio de IP: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

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

@app.route('/api/settings/retention', methods=['GET', 'POST'])
def settings_retention():
    """Consulta o actualiza la política de retención automática por días."""
    if request.method == 'POST':
        data = request.json or {}
        max_days = data.get('max_recording_days')
        auto_purge = data.get('auto_purge_enabled', True)
        if max_days is None:
            return jsonify({'success': False, 'error': 'Falta el parámetro max_recording_days'}), 400
        try:
            days_int = max(1, int(max_days))
            save_setting('max_recording_days', days_int)
            save_setting('auto_purge_enabled', bool(auto_purge))
            # Actualizar instancias de grabadores en tiempo de ejecución
            for c in cameras.values():
                rec = c.get('recorder')
                if rec and hasattr(rec, 'set_max_days'):
                    rec.set_max_days(days_int)
            return jsonify({'success': True, 'max_recording_days': days_int, 'auto_purge_enabled': bool(auto_purge)})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 400
    else:
        settings = get_all_settings()
        return jsonify({
            'max_recording_days': settings.get('max_recording_days', 30),
            'auto_purge_enabled': settings.get('auto_purge_enabled', True)
        })

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
            'apply_to_clips': settings.get('motion_schedule', {}).get('apply_to_clips', True),
            'apply_to_snapshots': settings.get('motion_schedule', {}).get('apply_to_snapshots', True),
            'is_active_now': is_motion_capture_allowed('clip', 'cam1')[0],
            'status_message': is_motion_capture_allowed('clip', 'cam1')[1]
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
        if 'apply_to_clips' in data:
            sched['apply_to_clips'] = bool(data['apply_to_clips'])
        if 'apply_to_snapshots' in data:
            sched['apply_to_snapshots'] = bool(data['apply_to_snapshots'])
        
        save_setting('motion_schedule', sched)
        logger.info(f"Programación de horarios actualizada: {sched}")
    
    sched = settings.get('motion_schedule', {
        'enabled': False,
        'start_time': '22:00',
        'end_time': '06:00',
        'days': [0, 1, 2, 3, 4, 5, 6],
        'target_cameras': ['cam1', 'cam2'],
        'apply_to_clips': True,
        'apply_to_snapshots': True
    })
    sched_allowed, sched_reason = is_motion_capture_allowed('clip', 'cam1')
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

@app.route('/api/media/calendar-summary')
def media_calendar_summary():
    """Retorna un mapa consolidado de todas las fechas con grabaciones y estadísticas para el calendario."""
    filter_cam = request.args.get('camera_id', 'all')
    combined_days = {}

    for cid, c in cameras.items():
        if filter_cam != 'all' and filter_cam != cid:
            continue
        rec = c.get('recorder')
        if not rec:
            continue

        c_days = rec.get_recorded_days_summary()
        for d_str, stats in c_days.items():
            if d_str not in combined_days:
                combined_days[d_str] = {
                    'date': d_str,
                    'clips': 0,
                    'continuous': 0,
                    'snapshots': 0,
                    'total_files': 0,
                    'total_bytes': 0,
                    'total_mb': 0.0,
                    'total_gb': 0.0,
                    'has_clips': False,
                    'has_continuous': False,
                    'has_snapshots': False,
                    'cameras': []
                }
            cd = combined_days[d_str]
            cd['clips'] += stats.get('clips', 0)
            cd['continuous'] += stats.get('continuous', 0)
            cd['snapshots'] += stats.get('snapshots', 0)
            cd['total_files'] += stats.get('total_files', 0)
            cd['total_bytes'] += stats.get('total_bytes', 0)
            if stats.get('clips', 0) > 0: cd['has_clips'] = True
            if stats.get('continuous', 0) > 0: cd['has_continuous'] = True
            if stats.get('snapshots', 0) > 0: cd['has_snapshots'] = True
            if cid not in cd['cameras']: cd['cameras'].append(cid)

    for d_str, cd in combined_days.items():
        cd['total_mb'] = round(cd['total_bytes'] / (1024 * 1024), 2)
        cd['total_gb'] = round(cd['total_bytes'] / (1024**3), 3)

    sorted_days = sorted(combined_days.keys(), reverse=True)
    return jsonify({
        'success': True,
        'days_count': len(sorted_days),
        'days_list': sorted_days,
        'recorded_days': combined_days
    })

# Caché en memoria para /api/storage/estimate (evita recorrer cientos de archivos en cada petición)
_storage_estimate_cache = {'data': None, 'timestamp': 0}
_STORAGE_CACHE_TTL = 60  # segundos

def invalidate_storage_cache():
    """Invalida la caché en memoria de estimación de disco para refresco inmediato."""
    _storage_estimate_cache['data'] = None
    _storage_estimate_cache['timestamp'] = 0

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

    if deleted:
        invalidate_storage_cache()

    return jsonify({'success': deleted, 'filename': filename})

@app.route('/api/media/purge-preview', methods=['POST'])
def purge_preview_media():
    """Simula la purga de archivos por días o fecha específica sin borrar (dry-run)."""
    data = request.get_json(silent=True) or {}
    days_older_than = data.get('days_older_than')
    specific_date = data.get('specific_date')
    target_type = data.get('target_type', 'all')  # all | continuous | clip | snapshot
    camera_id = data.get('camera_id', 'all')      # all | cam1 | cam2

    total_count = 0
    total_freed_bytes = 0
    all_affected_days = set()
    breakdown = {
        'continuous_count': 0, 'continuous_bytes': 0,
        'clip_count': 0, 'clip_bytes': 0,
        'snapshot_count': 0, 'snapshot_bytes': 0
    }
    cams_data = {}

    for cid, c in cameras.items():
        if camera_id != 'all' and camera_id != cid:
            continue
        rec = c.get('recorder')
        if not rec:
            continue

        if specific_date:
            res = rec.purge_specific_date(specific_date, target_type=target_type, dry_run=True)
        elif days_older_than is not None:
            days = max(0, int(days_older_than))
            res = rec.purge_older_than(days, target_type=target_type, dry_run=True)
        else:
            return jsonify({'success': False, 'error': 'Debe especificar days_older_than o specific_date'}), 400

        cams_data[cid] = res
        total_count += res.get('deleted_count', 0)
        total_freed_bytes += res.get('freed_bytes', 0)
        for d in res.get('affected_days', []):
            all_affected_days.add(d)
        
        b = res.get('breakdown', {})
        for k in breakdown:
            breakdown[k] += b.get(k, 0)

    return jsonify({
        'success': True,
        'total_count': total_count,
        'freed_bytes': total_freed_bytes,
        'freed_mb': round(total_freed_bytes / (1024 * 1024), 2),
        'freed_gb': round(total_freed_bytes / (1024**3), 3),
        'affected_days': sorted(list(all_affected_days)),
        'breakdown': {
            'continuous_count': breakdown['continuous_count'],
            'continuous_mb': round(breakdown['continuous_bytes'] / (1024 * 1024), 2),
            'clip_count': breakdown['clip_count'],
            'clip_mb': round(breakdown['clip_bytes'] / (1024 * 1024), 2),
            'snapshot_count': breakdown['snapshot_count'],
            'snapshot_mb': round(breakdown['snapshot_bytes'] / (1024 * 1024), 2)
        },
        'target_type': target_type,
        'camera_id': camera_id,
        'days': days_older_than,
        'specific_date': specific_date
    })

@app.route('/api/media/bulk-delete', methods=['POST'])
def bulk_delete_media():
    """Elimina múltiples archivos o purga por días de antigüedad / fecha específica."""
    data = request.get_json(silent=True) or {}
    items = data.get('items', [])
    days_older_than = data.get('days_older_than')
    specific_date = data.get('specific_date')
    target_type = data.get('target_type', 'all')  # all | continuous | clip | snapshot
    camera_id = data.get('camera_id', 'all')      # all | cam1 | cam2

    # 1. Purga por fecha específica (un día completo)
    if specific_date:
        total_deleted = 0
        total_freed_bytes = 0
        all_affected_days = set()
        for cid, c in cameras.items():
            if camera_id != 'all' and camera_id != cid:
                continue
            rec = c.get('recorder')
            if rec:
                res = rec.purge_specific_date(specific_date, target_type=target_type, dry_run=False)
                total_deleted += res.get('deleted_count', 0)
                total_freed_bytes += res.get('freed_bytes', 0)
                for d in res.get('affected_days', []):
                    all_affected_days.add(d)

        invalidate_storage_cache()
        return jsonify({
            'success': True,
            'deleted_count': total_deleted,
            'freed_bytes': total_freed_bytes,
            'freed_mb': round(total_freed_bytes / (1024 * 1024), 2),
            'freed_gb': round(total_freed_bytes / (1024**3), 3),
            'affected_days': sorted(list(all_affected_days)),
            'mode': 'specific_date',
            'specific_date': specific_date,
            'target_type': target_type
        })

    # 2. Purga por días de antigüedad
    if days_older_than is not None:
        days = max(0, int(days_older_than))
        total_deleted = 0
        total_freed_bytes = 0
        all_affected_days = set()
        for cid, c in cameras.items():
            if camera_id != 'all' and camera_id != cid:
                continue
            rec = c.get('recorder')
            if rec:
                res = rec.purge_older_than(days, target_type=target_type, dry_run=False)
                total_deleted += res.get('deleted_count', 0)
                total_freed_bytes += res.get('freed_bytes', 0)
                for d in res.get('affected_days', []):
                    all_affected_days.add(d)

        invalidate_storage_cache()
        return jsonify({
            'success': True,
            'deleted_count': total_deleted,
            'freed_bytes': total_freed_bytes,
            'freed_mb': round(total_freed_bytes / (1024 * 1024), 2),
            'freed_gb': round(total_freed_bytes / (1024**3), 3),
            'affected_days': sorted(list(all_affected_days)),
            'mode': 'older_than',
            'days': days,
            'target_type': target_type
        })

    # 3. Borrado de elementos seleccionados por lista
    deleted_count = 0
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

    if deleted_count > 0:
        invalidate_storage_cache()

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
