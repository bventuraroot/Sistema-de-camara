#!/usr/bin/env python3
"""
purgar_grabaciones.py
Herramienta rápida para liberar espacio en disco y purgar grabaciones pesadas (continuous, clips, snapshots).

Uso:
    python3 purgar_grabaciones.py --all           # Elimina todas las grabaciones acumuladas
    python3 purgar_grabaciones.py --info          # Solo muestra el espacio ocupado por grabaciones
"""

import sys
import os
import shutil
import argparse
from pathlib import Path
import json

def get_recordings_dirs():
    dirs = []
    # 1. Config en settings.json si existe
    settings_file = Path(__file__).parent / 'config' / 'settings.json'
    if settings_file.exists():
        try:
            with open(settings_file, 'r') as f:
                data = json.load(f)
                sp = data.get('storage_path')
                if sp and Path(sp).exists():
                    dirs.append(Path(sp))
        except Exception:
            pass

    # 2. Variable de entorno
    env_dir = os.getenv('RECORDINGS_DIR')
    if env_dir and Path(env_dir).exists() and Path(env_dir) not in dirs:
        dirs.append(Path(env_dir))

    # 3. Carpeta local ./recordings
    local_rec = Path(__file__).parent / 'recordings'
    if local_rec.exists() and local_rec not in dirs:
        dirs.append(local_rec)

    # 4. Carpeta común externa si existe
    ext_dir = Path('/Volumes/ExternalData/Grabaciones_Camara')
    if ext_dir.exists() and ext_dir not in dirs:
        dirs.append(ext_dir)

    return dirs

def get_dir_size(path: Path):
    if not path.exists():
        return 0
    total = 0
    for f in path.rglob('*'):
        if f.is_file():
            try:
                total += f.stat().st_size
            except Exception:
                pass
    return total

def format_size(bytes_val):
    gb = bytes_val / (1024**3)
    if gb >= 1.0:
        return f"{gb:.2f} GB"
    mb = bytes_val / (1024**2)
    return f"{mb:.1f} MB"

def show_info(rec_dirs):
    print("\n📦 RESUMEN DE ESPACIO OCUPADO POR GRABACIONES:")
    grand_total = 0
    for base in rec_dirs:
        print(f"\n📂 Directorio: {base}")
        try:
            total, used, free = shutil.disk_usage(str(base))
            print(f"   Disco total: {format_size(total)} | Libre: {format_size(free)} | Usado: {format_size(used)}")
        except Exception:
            pass

        for sub in ['cam1', 'cam2', 'continuous', 'clips', 'snapshots']:
            sub_path = base / sub
            if sub_path.exists():
                sz = get_dir_size(sub_path)
                grand_total += sz
                print(f"   - {sub}/: {format_size(sz)}")

    print(f"\n🔥 Total acumulado en grabaciones: {format_size(grand_total)}\n")

def purge_all(rec_dirs):
    print("\n⚠️  PURGANDO TODAS LAS GRABACIONES PARA LIBERAR DISCO...")
    freed = 0
    for base in rec_dirs:
        targets = [
            base / 'cam1' / 'continuous',
            base / 'cam1' / 'clips',
            base / 'cam2' / 'continuous',
            base / 'cam2' / 'clips',
            base / 'continuous',
            base / 'clips',
        ]
        for t in targets:
            if t.exists():
                sz = get_dir_size(t)
                shutil.rmtree(t, ignore_errors=True)
                t.mkdir(parents=True, exist_ok=True)
                freed += sz
                print(f"   ✅ Limpiado: {t} ({format_size(sz)} liberados)")

    print(f"\n🎉 ¡Espacio liberado exitosamente: {format_size(freed)}!\n")

def main():
    parser = argparse.ArgumentParser(description="Purgar grabaciones pesadas de CCTV.")
    parser.add_argument('--all', action='store_true', help="Elimina todas las grabaciones continuas y clips.")
    parser.add_argument('--info', action='store_true', help="Muestra el espacio ocupado.")
    args = parser.parse_args()

    rec_dirs = get_recordings_dirs()
    if not rec_dirs:
        print("❌ No se encontraron directorios de grabaciones.")
        return

    if args.all:
        purge_all(rec_dirs)
    else:
        show_info(rec_dirs)
        if not args.info:
            ans = input("¿Deseas purgar todas las grabaciones ahora para liberar el disco? (s/n): ").strip().lower()
            if ans in ('s', 'si', 'y', 'yes'):
                purge_all(rec_dirs)
            else:
                print("Operación cancelada.")

if __name__ == '__main__':
    main()
