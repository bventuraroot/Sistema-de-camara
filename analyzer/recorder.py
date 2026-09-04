import cv2
import os
import logging
import time
import shutil
import threading
import subprocess
from collections import deque
from queue import Queue, Empty
from datetime import datetime
from pathlib import Path
import json

logger = logging.getLogger(__name__)

class Recorder:
    def __init__(self, output_dir=None, rtsp_url='rtsp://localhost:8554/Cámara_de_nubes/hd', max_days=30, segment_minutes=5, continuous=False, has_audio=True):
        if output_dir:
            self.output_dir = Path(output_dir)
        else:
            self.output_dir = Path(os.getenv('RECORDINGS_DIR', './recordings'))

        try:
            self.output_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            logger.warning(f"No se pudo crear {self.output_dir}: {e}. Usando ./recordings como alternativa.")
            self.output_dir = Path('./recordings')
            self.output_dir.mkdir(parents=True, exist_ok=True)

        self.rtsp_url = rtsp_url
        self.has_audio = has_audio
        
        self.continuous_dir = self.output_dir / 'continuous'
        self.continuous_dir.mkdir(parents=True, exist_ok=True)
        
        self.snapshots_dir = self.output_dir / 'snapshots'
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        
        self.clips_dir = self.output_dir / 'clips'
        self.clips_dir.mkdir(parents=True, exist_ok=True)
        
        self.max_days = max_days
        self.segment_seconds = segment_minutes * 60
        self.continuous_enabled = continuous
        
        # Buffer circular en memoria para capturar los 2 segundos PREVIOS a la detección
        self.pre_buffer = deque(maxlen=30)
        self.pre_buffer_lock = threading.Lock()
        
        # Proceso FFmpeg para grabación continua 24/7 (apagado en Modo Solo Eventos para 0% uso de disco y CPU)
        self.ffmpeg_proc = None
        self.ffmpeg_lock = threading.Lock()
        self.ffmpeg_supervisor_running = False
        self.running = True
        if self.continuous_enabled:
            self._start_continuous_ffmpeg()
        
        # Grabación de Clips de Video por Evento (Movimiento / IA)
        self.clip_queue = Queue(maxsize=200)
        self.active_clip = None
        self.clip_lock = threading.Lock()
        self.fps = 15.0
        self.codec = cv2.VideoWriter_fourcc(*'avc1')
        self._start_clip_writer()
        
        self._start_cleanup_thread()
        mode_str = "24/7 Continuo" if self.continuous_enabled else "🎯 Modo Solo Eventos (Ahorro de recursos)"
        audio_str = "Micrófono ACTIVO" if self.has_audio else "Sin audio RTSP"
        logger.info(f"Grabador iniciado en: {self.output_dir} ({mode_str} | {audio_str})")
    
    # ----------------- GRABACIÓN CONTINUA 24/7 (FFMPEG DIRECTO) -----------------
    # ----------------- GRABACIÓN CONTINUA 24/7 (FFMPEG DIRECTO) -----------------
    def _start_continuous_ffmpeg(self):
        """Lanza FFmpeg solo si la grabación continua 24/7 está explícitamente activada."""
        with self.ffmpeg_lock:
            if self.ffmpeg_supervisor_running:
                return
            self.ffmpeg_supervisor_running = True

        def supervisor():
            while self.running and self.continuous_enabled:
                try:
                    today_str = datetime.now().strftime('%Y-%m-%d')
                    day_dir = self.continuous_dir / today_str
                    day_dir.mkdir(parents=True, exist_ok=True)
                    
                    out_pattern = str(self.continuous_dir / "%Y-%m-%d/cam_%Y%m%d_%H%M%S.mp4")
                    
                    # Detectar si el encoder de hardware h264_videotoolbox está disponible
                    use_hw_encoder = self._check_hw_encoder_available()
                    
                    cmd = [
                        "ffmpeg", "-hide_banner", "-loglevel", "error",
                        "-rtsp_transport", "tcp",
                        "-fflags", "+genpts",
                        "-i", self.rtsp_url,
                        "-map", "0:v:0",
                    ]
                    
                    if use_hw_encoder:
                        # Apple Silicon VideoToolbox: ~2% CPU, calidad excelente
                        cmd.extend(["-c:v", "h264_videotoolbox", "-b:v", "2200k"])
                        encoder_label = "H.264 (VideoToolbox HW)"
                    else:
                        # Fallback software: libx264 ultrafast
                        cmd.extend(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "22"])
                        encoder_label = "H.264 (libx264 SW)"
                    
                    if self.has_audio:
                        cmd.extend([
                            "-map", "0:a?",
                            "-c:a", "aac",
                            "-b:a", "64k"
                        ])
                    cmd.extend([
                        "-f", "segment",
                        "-segment_time", str(self.segment_seconds),
                        "-reset_timestamps", "1",
                        "-strftime", "1",
                        "-segment_format", "mp4",
                        "-segment_format_options", "movflags=+faststart",
                        out_pattern
                    ])
                    
                    self._stop_ffmpeg_process()
                    logger.info(f"Iniciando FFmpeg {encoder_label} para grabación continua 24/7 (Audio: {'AAC' if self.has_audio else 'Desactivado'})...")
                    with self.ffmpeg_lock:
                        self.ffmpeg_proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    
                    while self.running and self.continuous_enabled:
                        next_day_dir = self.continuous_dir / datetime.now().strftime('%Y-%m-%d')
                        next_day_dir.mkdir(parents=True, exist_ok=True)
                        
                        proc = None
                        with self.ffmpeg_lock:
                            proc = self.ffmpeg_proc
                        if proc is None or proc.poll() is not None:
                            logger.warning("Proceso FFmpeg finalizó. Reiniciando en 3s...")
                            break
                        time.sleep(2)
                        
                except Exception as e:
                    logger.error(f"Error en supervisor FFmpeg: {e}")
                    time.sleep(3)
                
                self._stop_ffmpeg_process()
                time.sleep(1)
            
            with self.ffmpeg_lock:
                self.ffmpeg_supervisor_running = False
        
        t = threading.Thread(target=supervisor, daemon=True, name="ffmpeg-supervisor")
        t.start()
    
    def _stop_ffmpeg_process(self):
        with self.ffmpeg_lock:
            if self.ffmpeg_proc is not None:
                try:
                    if self.ffmpeg_proc.poll() is None:
                        self.ffmpeg_proc.terminate()
                        self.ffmpeg_proc.wait(timeout=2)
                except Exception:
                    try:
                        self.ffmpeg_proc.kill()
                    except Exception:
                        pass
                finally:
                    self.ffmpeg_proc = None

    def _check_hw_encoder_available(self):
        """Verifica si el encoder de hardware h264_videotoolbox está disponible en el sistema."""
        try:
            result = subprocess.run(
                ["ffmpeg", "-hide_banner", "-encoders"],
                capture_output=True, text=True, timeout=5
            )
            return "h264_videotoolbox" in result.stdout
        except Exception:
            return False

    # ----------------- CLIPS DE VIDEO POR EVENTO (DETECCIÓN INTELIGENTE) -----------------
    def trigger_event_clip(self, label='evento'):
        """
        Inicia o extiende la grabación de un clip de video durante una detección activa.
        Incluye el pre-buffer de 2 segundos para capturar el inicio completo del suceso.
        """
        now = time.time()
        with self.clip_lock:
            if self.active_clip is not None:
                # El evento sigue ocurriendo: extender tiempo de actividad
                self.active_clip['last_activity'] = now
                return self.active_clip['url']
            
            today_str = datetime.now().strftime('%Y-%m-%d')
            day_dir = self.clips_dir / today_str
            day_dir.mkdir(parents=True, exist_ok=True)
            
            time_str = datetime.now().strftime('%Y%m%d_%H%M%S')
            filename = f"clip_{label}_{time_str}.mp4"
            filepath = day_dir / filename
            clip_url = f"/clips/{today_str}/{filename}"
            audio_path = str(filepath) + ".audio.m4a" if self.has_audio else None

            # Lanzar captura de audio concurrente si la cámara dispone de audio RTSP
            audio_proc = None
            if self.has_audio:
                try:
                    audio_cmd = [
                        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                        "-rtsp_transport", "tcp",
                        "-i", self.rtsp_url,
                        "-vn",
                        "-c:a", "aac",
                        "-b:a", "64k",
                        audio_path
                    ]
                    audio_proc = subprocess.Popen(audio_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception as e:
                    logger.warning(f"No se pudo iniciar captura de audio para clip: {e}")
                    audio_proc = None
            
            # Transferir los cuadros previos al suceso (Pre-Buffer de 2s)
            with self.pre_buffer_lock:
                for b_frame in list(self.pre_buffer):
                    try:
                        self.clip_queue.put_nowait(b_frame)
                    except Exception:
                        pass
            
            self.active_clip = {
                'filename': filename,
                'filepath': str(filepath),
                'audio_path': audio_path,
                'audio_proc': audio_proc,
                'day': today_str,
                'url': clip_url,
                'start_time': now,
                'last_activity': now,
                'writer': None,
                'frame_size': None
            }
            logger.info(f"🔴 Grabando clip por evento con IA: {filename} (Audio: {'Capturando' if audio_proc else 'No disponible'})")
            return clip_url

    def _start_clip_writer(self):
        """Hilo en segundo plano que escribe los cuadros en el clip de evento activo."""
        def clip_worker():
            while self.running:
                try:
                    try:
                        frame = self.clip_queue.get(timeout=0.25)
                    except Empty:
                        with self.clip_lock:
                            if self.active_clip is not None:
                                now = time.time()
                                # 5 segundos de buffer después de que termina el movimiento, o 90s máximo
                                if (now - self.active_clip['last_activity'] > 5.0 or 
                                    now - self.active_clip['start_time'] > 90.0):
                                    self._close_active_clip()
                        continue
                    
                    if frame is None:
                        continue
                    
                    now = time.time()
                    writer = None
                    with self.clip_lock:
                        if self.active_clip is None:
                            self.clip_queue.task_done()
                            continue
                        
                        if (now - self.active_clip['last_activity'] > 5.0 or 
                            now - self.active_clip['start_time'] > 90.0):
                            self._close_active_clip()
                            self.clip_queue.task_done()
                            continue
                        
                        h, w = frame.shape[:2]
                        if self.active_clip['writer'] is None:
                            self.active_clip['frame_size'] = (w, h)
                            self.active_clip['writer'] = cv2.VideoWriter(
                                self.active_clip['filepath'],
                                self.codec,
                                self.fps,
                                (w, h)
                            )
                        writer = self.active_clip['writer']
                    
                    if writer:
                        writer.write(frame)
                    
                    self.clip_queue.task_done()
                    
                except Exception as e:
                    logger.error(f"Error en clip_worker: {e}")
                    time.sleep(0.5)
            
            with self.clip_lock:
                self._close_active_clip()
        
        t = threading.Thread(target=clip_worker, daemon=True, name="clip-worker")
        t.start()

    def _close_active_clip(self):
        if self.active_clip and self.active_clip.get('writer'):
            clip_info = dict(self.active_clip)
            self.active_clip = None
            
            def finalize_in_background(info):
                writer = info.get('writer')
                filename = info.get('filename')
                audio_proc = info.get('audio_proc')
                audio_path = info.get('audio_path')
                video_path = info.get('filepath')
                
                try:
                    if writer:
                        writer.release()
                        logger.info(f"🎬 Clip de evento guardado: {filename}")
                except Exception as e:
                    logger.error(f"Error al cerrar VideoWriter: {e}")
                
                if audio_proc is not None:
                    try:
                        audio_proc.terminate()
                        audio_proc.wait(timeout=2)
                    except Exception:
                        try: audio_proc.kill()
                        except Exception: pass
                
                # Muxing de audio + optimización para reproducción web (faststart)
                if video_path and os.path.exists(video_path):
                    tmp = video_path + ".tmp.mp4"
                    has_valid_audio = audio_path and os.path.exists(audio_path) and os.path.getsize(audio_path) > 200
                    try:
                        if has_valid_audio:
                            cmd = [
                                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                "-i", video_path,
                                "-i", audio_path,
                                "-c:v", "copy",
                                "-c:a", "copy",
                                "-shortest",
                                "-movflags", "+faststart",
                                tmp
                            ]
                        else:
                            cmd = [
                                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                "-i", video_path,
                                "-c", "copy",
                                "-movflags", "+faststart",
                                tmp
                            ]
                        res = subprocess.run(cmd, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        if res.returncode == 0 and os.path.exists(tmp):
                            os.replace(tmp, video_path)
                            if has_valid_audio:
                                logger.info(f"🔊 Audio incorporado con éxito al clip: {filename}")
                    except Exception as e:
                        logger.warning(f"No se pudo optimizar clip con faststart: {e}")
                    finally:
                        if audio_path and os.path.exists(audio_path):
                            try: os.remove(audio_path)
                            except Exception: pass
            
            threading.Thread(target=finalize_in_background, args=(clip_info,), daemon=True, name="finalize-clip").start()
        self.active_clip = None

    # ----------------- ALIMENTACIÓN Y FOTOS -----------------
    def feed_frame(self, frame):
        """Alimenta el pre-buffer circular y el clip de evento si hay detección activa."""
        if frame is None:
            return
        
        # Mantener buffer circular de los últimos 2 segundos
        with self.pre_buffer_lock:
            self.pre_buffer.append(frame.copy())
        
        # Si un clip de evento está grabando, enviar frame a la cola de escritura
        if self.active_clip is not None:
            if self.clip_queue.full():
                try:
                    self.clip_queue.get_nowait()
                except Empty:
                    pass
            try:
                self.clip_queue.put_nowait(frame.copy())
            except Exception:
                pass
    
    def save_snapshot(self, frame, prefix='evento'):
        """Guarda una captura instantánea en alta resolución en el disco externo."""
        if frame is None:
            return None
        
        try:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]
            filename = f"{prefix}_{timestamp}.jpg"
            filepath = self.snapshots_dir / filename
            
            cv2.imwrite(str(filepath), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            logger.info(f"Snapshot guardado: {filename}")
            return filename
        except Exception as e:
            logger.error(f"Error guardando snapshot: {e}")
            return None
    
    def toggle_continuous(self):
        """Alterna entre Grabación Continua 24/7 y Modo Solo Eventos."""
        self.continuous_enabled = not self.continuous_enabled
        if self.continuous_enabled:
            self._start_continuous_ffmpeg()
            logger.info("Grabación continua 24/7: ACTIVADA")
        else:
            self._stop_ffmpeg_process()
            logger.info("Grabación continua 24/7: DESACTIVADA (Modo Solo Eventos activo)")
        return self.continuous_enabled
    
    def is_continuous_active(self):
        return self.continuous_enabled
    
    def set_continuous(self, state: bool):
        self.continuous_enabled = state
        if self.continuous_enabled:
            self._start_continuous_ffmpeg()
        else:
            self._stop_ffmpeg_process()
        return self.continuous_enabled
    
    def get_storage_info(self):
        try:
            total, used, free = shutil.disk_usage(str(self.output_dir))
            total_gb = round(total / (1024**3), 1)
            used_gb = round(used / (1024**3), 1)
            free_gb = round(free / (1024**3), 1)
            percent = int((used / total) * 100) if total > 0 else 0
            
            return {
                'path': str(self.output_dir),
                'total_gb': total_gb,
                'used_gb': used_gb,
                'free_gb': free_gb,
                'percent_used': percent,
                'continuous_active': self.continuous_enabled,
                'mode': '24/7 Continuo' if self.continuous_enabled else 'Solo Eventos',
                'segment_minutes': self.segment_seconds // 60
            }
        except Exception as e:
            logger.error(f"Error obteniendo almacenamiento: {e}")
            return {
                'path': str(self.output_dir),
                'total_gb': 0, 'used_gb': 0, 'free_gb': 0, 'percent_used': 0,
                'continuous_active': self.continuous_enabled,
                'mode': 'Solo Eventos',
                'segment_minutes': self.segment_seconds // 60
            }
    
    def _start_cleanup_thread(self):
        def cleanup_worker():
            while self.running:
                try:
                    self._run_cleanup_cycle()
                except Exception as e:
                    logger.error(f"Error en ciclo de limpieza: {e}")
                time.sleep(3600)
        t = threading.Thread(target=cleanup_worker, daemon=True)
        t.start()
    
    def _run_cleanup_cycle(self):
        cutoff = time.time() - (self.max_days * 86400)
        for base in [self.continuous_dir, self.clips_dir]:
            for date_dir in sorted(base.glob('*')):
                if date_dir.is_dir():
                    try:
                        dir_date = datetime.strptime(date_dir.name, '%Y-%m-%d').timestamp()
                        if dir_date < cutoff:
                            shutil.rmtree(date_dir)
                            logger.info(f"Grabaciones antiguas eliminadas: {date_dir.name}")
                    except Exception:
                        pass
        
        try:
            _, _, free = shutil.disk_usage(str(self.output_dir))
            free_gb = free / (1024**3)
            if free_gb < 3.0:
                logger.warning(f"Espacio libre crítico ({free_gb:.1f} GB). Purgando grabaciones más antiguas...")
                existing_days = sorted(self.continuous_dir.glob('*'))
                if existing_days:
                    shutil.rmtree(existing_days[0])
        except Exception as e:
            logger.error(f"Error en verificación de espacio: {e}")
    
    def list_snapshots(self, limit=30):
        snapshots = []
        try:
            for f in sorted(self.snapshots_dir.glob('*.jpg'), key=os.path.getmtime, reverse=True)[:limit]:
                snapshots.append({
                    'filename': f.name,
                    'size': f.stat().st_size,
                    'timestamp': datetime.fromtimestamp(f.stat().st_mtime).isoformat()
                })
        except Exception as e:
            logger.error(f"Error listando snapshots: {e}")
        return snapshots
    
    def list_clips(self, limit=40):
        clips = []
        try:
            for p in sorted(self.clips_dir.glob('*/*.mp4'), key=os.path.getmtime, reverse=True)[:limit]:
                clips.append({
                    'filename': p.name,
                    'day': p.parent.name,
                    'size_mb': round(p.stat().st_size / (1024 * 1024), 2),
                    'timestamp': datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
                    'url': f"/clips/{p.parent.name}/{p.name}"
                })
        except Exception as e:
            logger.error(f"Error listando clips: {e}")
        return clips
    
    def list_continuous_segments(self, limit=40):
        segments = []
        try:
            for p in sorted(self.continuous_dir.glob('*/*.mp4'), key=os.path.getmtime, reverse=True)[:limit]:
                segments.append({
                    'filename': p.name,
                    'day': p.parent.name,
                    'size_mb': round(p.stat().st_size / (1024 * 1024), 1),
                    'timestamp': datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
                    'url': f"/recordings/continuous/{p.parent.name}/{p.name}"
                })
        except Exception as e:
            logger.error(f"Error listando segmentos: {e}")
        return segments
    
    def delete_file(self, file_type: str, filename: str, day: str = None) -> bool:
        """Elimina de forma segura un archivo de clips, continuous o snapshots."""
        try:
            # Validar nombre de archivo seguro
            safe_name = Path(filename).name
            target = None
            if file_type == 'snapshot':
                target = self.snapshots_dir / safe_name
            elif file_type == 'clip':
                if day:
                    target = self.clips_dir / Path(day).name / safe_name
                else:
                    # Buscar en los subdirectorios de clips
                    found = list(self.clips_dir.glob(f"*/{safe_name}"))
                    if found:
                        target = found[0]
            elif file_type == 'continuous':
                if day:
                    target = self.continuous_dir / Path(day).name / safe_name
                else:
                    found = list(self.continuous_dir.glob(f"*/{safe_name}"))
                    if found:
                        target = found[0]
            
            if target and target.is_file():
                target.unlink()
                logger.info(f"Archivo eliminado exitosamente: {target}")
                # Limpiar carpeta de fecha si quedó vacía
                if target.parent != self.snapshots_dir and not any(target.parent.iterdir()):
                    try:
                        target.parent.rmdir()
                    except Exception:
                        pass
                return True
            else:
                logger.warning(f"Archivo a eliminar no encontrado: type={file_type}, name={filename}, day={day}")
                return False
        except Exception as e:
            logger.error(f"Error eliminando archivo ({filename}): {e}")
            return False

    def bulk_delete_older_than(self, days: int) -> int:
        """Elimina grabaciones y clips con más de X días de antigüedad. Retorna cuántos se borraron."""
        deleted_count = 0
        cutoff = time.time() - (days * 86400)
        try:
            # Clips y continuos
            for base in [self.continuous_dir, self.clips_dir]:
                for date_dir in list(base.glob('*')):
                    if date_dir.is_dir():
                        try:
                            dir_date = datetime.strptime(date_dir.name, '%Y-%m-%d').timestamp()
                            if dir_date < cutoff:
                                for f in date_dir.glob('*'):
                                    if f.is_file():
                                        f.unlink()
                                        deleted_count += 1
                                date_dir.rmdir()
                        except Exception:
                            pass
            # Snapshots
            for f in list(self.snapshots_dir.glob('*.jpg')):
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink()
                    deleted_count += 1
        except Exception as e:
            logger.error(f"Error en borrado masivo por días: {e}")
        return deleted_count

    def get_detailed_storage_metrics(self):
        """Calcula el tamaño de cada carpeta y la estimación de días restantes."""
        try:
            total, used, free = shutil.disk_usage(str(self.output_dir))
            total_gb = round(total / (1024**3), 1)
            used_gb = round(used / (1024**3), 1)
            free_gb = round(free / (1024**3), 1)
            percent = int((used / total) * 100) if total > 0 else 0

            # Calcular tamaño de clips, continuous y snapshots
            def dir_size_mb(path: Path):
                if not path.exists():
                    return 0.0
                return round(sum(f.stat().st_size for f in path.rglob('*') if f.is_file()) / (1024 * 1024), 1)

            clips_mb = dir_size_mb(self.clips_dir)
            cont_mb = dir_size_mb(self.continuous_dir)
            snaps_mb = dir_size_mb(self.snapshots_dir)

            # Estimación de días restantes:
            # Si continuous_active: ~24 GB/día por cámara (1080p)
            # Si solo eventos: ~1.5 GB/día por cámara
            daily_burn_gb = 24.0 if self.continuous_enabled else 1.5
            days_remaining = round(free_gb / daily_burn_gb, 1) if daily_burn_gb > 0 else 999.0

            return {
                'total_gb': total_gb,
                'used_gb': used_gb,
                'free_gb': free_gb,
                'percent_used': percent,
                'continuous_active': self.continuous_enabled,
                'daily_burn_gb': daily_burn_gb,
                'estimated_days_remaining': days_remaining,
                'clips_mb': clips_mb,
                'continuous_mb': cont_mb,
                'snapshots_mb': snaps_mb
            }
        except Exception as e:
            logger.error(f"Error en get_detailed_storage_metrics: {e}")
            return {
                'total_gb': 0, 'used_gb': 0, 'free_gb': 0, 'percent_used': 0,
                'continuous_active': False, 'daily_burn_gb': 1.5,
                'estimated_days_remaining': 0, 'clips_mb': 0, 'continuous_mb': 0, 'snapshots_mb': 0
            }

    def stop(self):
        self.running = False
        self._stop_ffmpeg_process()
        with self.clip_lock:
            self._close_active_clip()
