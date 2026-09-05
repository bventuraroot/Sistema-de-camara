#!/usr/bin/env python3
"""
Script de Detección Rápida de IPs de Cámaras CCTV / ONVIF / RTSP
Úsalo si la cámara cambió de IP, tras reiniciar el router o al conectar una cámara nueva.
"""

import sys
import time
from analyzer.network_scanner import scan_network_cameras, test_rtsp_connection, CAMERA_PRESETS

def print_banner():
    print("\n" + "=" * 70)
    print(" 🔍 ANALIZADOR DE RED Y DETECTOR DE CÁMARAS IP (CCTV)")
    print("=" * 70)
    print(" Escaneando subred local con sondas ONVIF UDP y puertos RTSP...")

def main():
    print_banner()
    t0 = time.time()
    
    custom_subnet = sys.argv[1] if len(sys.argv) > 1 else None
    res = scan_network_cameras(custom_subnet=custom_subnet)
    
    devices = res.get('devices', [])
    count = len(devices)
    elapsed = res.get('elapsed_seconds', round(time.time() - t0, 2))
    subnet = res.get('subnet_scanned', '192.168.1.')
    local_ip = res.get('local_ip', '')

    print(f"\n📡 Subred analizada: {subnet}0/24 | IP Local de esta PC: {local_ip}")
    print(f"⏱️ Tiempo de escaneo: {elapsed}s")
    print(f"🎯 Cámaras encontradas: {count}\n")

    if count == 0:
        print("⚠️ No se encontraron cámaras activas.")
        print("💡 Consejos:")
        print("   1. Revisa que la cámara esté encendida y conectada a la misma red/Wi-Fi.")
        print("   2. Si tu router usa otra subred (ej: 192.168.0.x), ejecuta:")
        print("      python escanear_ips.py 192.168.0.")
    else:
        for idx, dev in enumerate(devices, 1):
            print(f"[{idx}] 📹 DIRECCIÓN IP: \033[1;32m{dev['ip']}\033[0m")
            print(f"    • Tipo/Marca detectada: {dev.get('hardware', 'Cámara IP')}")
            print(f"    • Nombre de Host: {dev.get('name', 'N/A')}")
            print(f"    • MAC Address: {dev.get('mac', 'N/A')}")
            print(f"    • Puertos abiertos: {dev.get('open_ports', [])}")
            print(f"    • Latencia: {dev.get('latency_ms', 0)}ms")
            print(f"    • RTSP sugerido: \033[1;36m{dev.get('suggested_rtsp', '')}\033[0m")
            print("-" * 70)

    print("\n💡 Puedes ver y aplicar estas cámaras desde el panel web en: http://localhost:5001")
    print("   Haz clic en el botón superior '[RED 🔍 Analizar IPs]' para asignarla con 1 clic.\n")

if __name__ == '__main__':
    main()
