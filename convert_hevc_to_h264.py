#!/usr/bin/env python3
"""
Script de conversión de grabaciones HEVC (H.265) existentes a H.264 universal.
Utiliza h264_videotoolbox (Apple Silicon HW) a velocidad ~18x (~17s por archivo de 5 min).

Uso:
    python3 convert_existing_hevc.py [--dry-run]

Opciones:
    --dry-run   Solo listar archivos que serían convertidos, sin ejecutar.
"""

import os
import sys
import subprocess
import shutil
import time
from pathlib import Path

# Directorio base de grabaciones continuas
RECORDINGS_BASE = Path("/Volumes/ExternalData/Grabaciones_Camara")
# Carpetas a escanear (cam1/continuous y cam2/continuous)
SCAN_DIRS = [
    RECORDINGS_BASE / "cam1" / "continuous",
    RECORDINGS_BASE / "cam2" / "continuous",
    RECORDINGS_BASE / "continuous",  # Legacy
]

# Configuración del encoder
HW_ENCODER = "h264_videotoolbox"
SW_ENCODER = "libx264"
BITRATE = "2200k"
SW_PRESET = "ultrafast"
SW_CRF = "22"


def detect_encoder():
    """Detecta si h264_videotoolbox está disponible."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=10
        )
        if HW_ENCODER in result.stdout:
            return HW_ENCODER
    except Exception:
        pass
    return SW_ENCODER


def get_video_codec(filepath):
    """Retorna el nombre del códec de video del archivo."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0",
             str(filepath)],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def convert_file(filepath, encoder, dry_run=False):
    """Convierte un archivo HEVC a H.264 preservando timestamps del archivo."""
    try:
        if filepath.stat().st_size < 1024:
            return False, "Omitido (archivo vacío o en grabación activa)"
    except Exception:
        return False, "Error al leer archivo"
        
    codec = get_video_codec(filepath)
    if codec != "hevc":
        return False, f"Omitido (ya es {codec or 'desconocido'})"
    
    if dry_run:
        size_mb = filepath.stat().st_size / (1024 * 1024)
        return True, f"HEVC → H.264 ({size_mb:.1f} MB)"
    
    # Preservar timestamps originales
    orig_mtime = filepath.stat().st_mtime
    orig_atime = filepath.stat().st_atime
    
    tmp_output = filepath.with_suffix(".h264_tmp.mp4")
    
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-hwaccel", "videotoolbox" if encoder == HW_ENCODER else "auto",
        "-i", str(filepath),
    ]
    
    if encoder == HW_ENCODER:
        cmd.extend(["-c:v", HW_ENCODER, "-b:v", BITRATE])
    else:
        cmd.extend(["-c:v", SW_ENCODER, "-preset", SW_PRESET, "-crf", SW_CRF])
    
    cmd.extend(["-c:a", "copy", str(tmp_output)])
    
    try:
        start_time = time.time()
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        elapsed = time.time() - start_time
        
        if result.returncode != 0:
            # Limpiar temporal fallido
            if tmp_output.exists():
                tmp_output.unlink()
            return False, f"Error FFmpeg: {result.stderr[:200]}"
        
        # Verificar que el nuevo archivo es válido
        new_codec = get_video_codec(tmp_output)
        if new_codec != "h264":
            if tmp_output.exists():
                tmp_output.unlink()
            return False, f"Códec resultante inesperado: {new_codec}"
        
        # Reemplazar el original con el convertido
        shutil.move(str(tmp_output), str(filepath))
        
        # Restaurar timestamps originales
        os.utime(str(filepath), (orig_atime, orig_mtime))
        
        size_mb = filepath.stat().st_size / (1024 * 1024)
        return True, f"OK ({size_mb:.1f} MB, {elapsed:.1f}s)"
        
    except subprocess.TimeoutExpired:
        if tmp_output.exists():
            tmp_output.unlink()
        return False, "Timeout (>10 min)"
    except Exception as e:
        if tmp_output.exists():
            tmp_output.unlink()
        return False, f"Error: {e}"


def main():
    dry_run = "--dry-run" in sys.argv
    
    encoder = detect_encoder()
    print(f"{'🔍 MODO DRY-RUN' if dry_run else '🔄 MODO CONVERSIÓN'}")
    print(f"Encoder: {encoder}")
    print(f"Directorios a escanear:")
    for d in SCAN_DIRS:
        print(f"  → {d} {'(existe)' if d.exists() else '(no existe)'}")
    print()
    
    # Recopilar todos los archivos .mp4
    all_files = []
    for scan_dir in SCAN_DIRS:
        if scan_dir.exists():
            all_files.extend(sorted(scan_dir.rglob("*.mp4")))
    
    if not all_files:
        print("No se encontraron archivos MP4.")
        return
    
    print(f"Total de archivos encontrados: {len(all_files)}")
    print("-" * 70)
    
    converted = 0
    skipped = 0
    errors = 0
    
    for i, filepath in enumerate(all_files, 1):
        rel_path = filepath.relative_to(RECORDINGS_BASE)
        success, msg = convert_file(filepath, encoder, dry_run=dry_run)
        
        status = "✅" if success else "⏭️"
        if "Error" in msg or "Timeout" in msg:
            status = "❌"
            errors += 1
        elif success:
            converted += 1
        else:
            skipped += 1
        
        print(f"  [{i}/{len(all_files)}] {status} {rel_path} → {msg}")
    
    print("-" * 70)
    print(f"Resultado: {converted} convertidos, {skipped} omitidos, {errors} errores")
    
    if dry_run and converted > 0:
        print(f"\n💡 Ejecuta sin --dry-run para convertir los {converted} archivos HEVC.")


if __name__ == "__main__":
    main()
