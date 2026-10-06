import socket
import uuid
import re
import os
import subprocess
import platform
import xml.etree.ElementTree as ET
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Puertos comúnmente utilizados por cámaras de seguridad IP y NVRs
CAMERA_PORTS = [554, 80, 8080, 8899, 34567, 5000, 8554, 8000, 8800, 2020, 5054, 3702]

# Plantillas y perfiles de conexión para diferentes fabricantes
CAMERA_PRESETS = [
    {
        'id': 'v380',
        'name': 'V380 / V380 Pro / Macro-video',
        'brand': 'V380',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch1',
        'alt_template_1': 'rtsp://{user}:{pass}@{ip}:554/0',
        'alt_template_2': 'rtsp://{user}:{pass}@{ip}:554/onvif1',
        'onvif_port': 8899,
        'default_user': 'admin',
        'default_pass': '',
        'instructions': (
            "1. En la app móvil V380 Pro, abre la cámara > Ajustes del Dispositivo > "
            "Seguridad de Red / Contraseña para configurar tu clave.\n"
            "2. El usuario predeterminado es 'admin' y la contraseña es la que asignaste en la app.\n"
            "3. En modelos modernos, el stream HD usa '/live/ch0' o '/0'. "
            "Si no conecta, prueba puerto ONVIF 8899 o activa 'Monitoreo LAN' en la app."
        ),
        'notes': 'Cámaras populares V380/V380 Pro. Soportan RTSP en puerto 554 y ONVIF en 8899 u 80.'
    },
    {
        'id': 'sehmua',
        'name': 'Sehmua (PTZ / Domo / Exterior)',
        'brand': 'Sehmua',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch1',
        'alt_template_1': 'rtsp://{user}:{pass}@{ip}:554/stream0',
        'alt_template_2': 'rtsp://{user}:{pass}@{ip}:554/h264Preview_01_main',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin',
        'instructions': (
            "1. Modelos Wi-Fi cableados a corriente: Tienen servidor RTSP activo en puerto 554 con usuario admin/admin.\n"
            "2. En modelos domo exteriores con ONVIF, el puerto de control es 80 u 8899."
        ),
        'notes': 'Cámaras Sehmua Wi-Fi/4MP y domos PTZ. Protocolo ONVIF en puerto 80/8899 y RTSP en 554.'
    },
    {
        'id': 'ubox',
        'name': 'Ubox (Cámaras Solares / Batería PIR / Ingenic)',
        'brand': 'Ubox',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch1',
        'alt_template_1': 'rtsp://{user}:{pass}@{ip}:554/h264Preview_01_main',
        'alt_template_2': 'rtsp://{user}:{pass}@{ip}:554/stream0',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin',
        'instructions': (
            "⚠️ ATENCIÓN: Las cámaras Ubox usan arquitectura de ahorro de energía para batería/solar:\n"
            "1. SUSPENSIÓN PROFUNDA (Deep Sleep): Si no detecta calor humano (PIR), apaga el Wi-Fi normal. "
            "Pasa la mano frente al lente o abre la app móvil Ubox para despertarla.\n"
            "2. MODO CONTINUO OBLIGATORIO: En la app Ubox > Ajustes > Modo de Energía, cámbialo a 'Continuo / Siempre Encendida' "
            "(debe estar enchufada a corriente continua USB, de lo contrario la batería se agotará rápido).\n"
            "3. ACTIVAR RTSP/LAN EN LA APP: En la app Ubox busca 'Monitoreo LAN' o 'Configuración de PC' y fija una contraseña.\n"
            "4. Si tu cámara Ubox es estrictamente Cloud P2P (sin RTSP de fábrica), no emitirá por puerto 554 sin un bridge."
        ),
        'notes': 'Cámaras que usan la app móvil Ubox (chipsets Ingenic/AI-Link). Requieren modo siempre encendido y RTSP activado en la app.'
    },
    {
        'id': 'tapo',
        'name': 'TP-Link Tapo (C200 / C310 / C500 / TC70)',
        'brand': 'Tapo',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/stream1',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/stream2',
        'onvif_port': 2020,
        'default_user': 'admin',
        'default_pass': '',
        'instructions': (
            "En la App Tapo: Ajustes de la cámara > Ajustes Avanzados > Cuenta de Cámara.\n"
            "Crea un nombre de usuario y contraseña específicos para RTSP/ONVIF."
        ),
        'notes': 'Cámaras TP-Link Tapo. Requiere crear cuenta de cámara en la app Tapo.'
    },
    {
        'id': 'icam365',
        'name': 'iCam365 / EyePlus / Ginatex',
        'brand': 'iCam365',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch1',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin',
        'instructions': 'Cámara Wi-Fi exterior/interior iCam365. Protocolo ONVIF Profile S nativo (Puerto 80). Usuario y clave admin/admin.',
        'notes': 'Cámara Wi-Fi exterior/interior iCam365. Protocolo ONVIF Profile S nativo (Puerto 80).'
    },
    {
        'id': 'xm_icsee',
        'name': 'Xiongmai / iCSee / XM (Cámara China común)',
        'brand': 'iCSee',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/stream0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/stream1',
        'onvif_port': 8899,
        'default_user': 'admin',
        'default_pass': '',
        'instructions': 'Usada en cámaras iCSee / XMeye. Puerto ONVIF típico: 8899. Clave por defecto en blanco o configurada en app.',
        'notes': 'Usada en millones de cámaras chinas (iCSee / XMeye). Puerto ONVIF típico: 8899.'
    },
    {
        'id': 'yoosee',
        'name': 'Yoosee / CooCam / GOSCAM',
        'brand': 'Yoosee',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/onvif1',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/onvif2',
        'onvif_port': 5000,
        'default_user': 'admin',
        'default_pass': '123456',
        'instructions': 'Cámaras de bombillo y domo Yoosee. En la app Yoosee se debe habilitar RTSP y fijar clave numérica.',
        'notes': 'Cámaras de bombillo y domo Yoosee. En la app Yoosee se debe habilitar RTSP y fijar clave.'
    },
    {
        'id': 'camhi',
        'name': 'CamHi / HiSilicon',
        'brand': 'CamHi',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/11',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/12',
        'onvif_port': 8080,
        'default_user': 'admin',
        'default_pass': 'admin',
        'instructions': 'Chipsets HiSilicon comunes en cámaras metálicas domo/bala. Stream HD en /11 y substream en /12.',
        'notes': 'Chipsets HiSilicon comunes en cámaras metálicas domo/bala.'
    },
    {
        'id': 'tuya_bridge',
        'name': 'Tuya / Smart Life (vía RTSP Bridge)',
        'brand': 'Tuya',
        'rtsp_template': 'rtsp://localhost:8554/{stream_name}/hd',
        'substream_template': 'rtsp://localhost:8554/{stream_name}/sd',
        'onvif_port': 8787,
        'default_user': '',
        'default_pass': '',
        'instructions': 'Cámaras Tuya / Smart Life que requieren puente local tuya-rtsp-bridge (:8554).',
        'notes': 'Cámaras Tuya que requieren contenedor tuya-rtsp-bridge (:8554).'
    },
    {
        'id': 'dahua',
        'name': 'Dahua / Imou / Lorex',
        'brand': 'Dahua',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/cam/realmonitor?channel=1&subtype=0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/cam/realmonitor?channel=1&subtype=1',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin123',
        'instructions': 'Cámaras Dahua e Imou. Para Imou, la contraseña es el código de seguridad (Safety Code) impreso en la etiqueta.',
        'notes': 'Cámaras y NVR Dahua/Imou estándar.'
    },
    {
        'id': 'hikvision',
        'name': 'Hikvision / Hilook / Ezviz',
        'brand': 'Hikvision',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/Streaming/Channels/101',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/Streaming/Channels/102',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': '12345',
        'instructions': 'Cámaras Hikvision / Ezviz. En Ezviz, la clave es el Verification Code impreso en la base de la cámara.',
        'notes': 'Cámaras y grabadores Hikvision/Ezviz con RTSP habilitado.'
    },
    {
        'id': 'generic_onvif',
        'name': 'Genérica ONVIF / RTSP',
        'brand': 'Generic',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch1',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin',
        'instructions': 'Cualquier cámara compatible con ONVIF Profile S o flujo RTSP estándar H.264/H.265.',
        'notes': 'Cualquier cámara compatible con ONVIF Profile S.'
    }
]

def get_lan_subnets():
    """Obtiene la lista de subredes locales e IPs de interfaces activas."""
    subnets = []
    seen_prefixes = set()

    # Método 1: Conexión saliente simulada (interfaz principal)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        parts = local_ip.split('.')
        prefix = f"{parts[0]}.{parts[1]}.{parts[2]}."
        subnets.append((prefix, local_ip))
        seen_prefixes.add(prefix)
    except Exception:
        pass

    # Método 2: Inspección de interfaces por socket / hostname
    try:
        host_ips = socket.gethostbyname_ex(socket.gethostname())[2]
        for ip in host_ips:
            if ip.startswith("127.") or ip.startswith("169.254."):
                continue
            parts = ip.split('.')
            if len(parts) == 4:
                prefix = f"{parts[0]}.{parts[1]}.{parts[2]}."
                if prefix not in seen_prefixes:
                    subnets.append((prefix, ip))
                    seen_prefixes.add(prefix)
    except Exception:
        pass

    if not subnets:
        subnets = [("192.168.1.", "192.168.1.10")]

    return subnets

def get_lan_subnet():
    """Obtiene la subred local principal (ej: '192.168.1.') y la IP local."""
    subnets = get_lan_subnets()
    return subnets[0]

# Caché persistente en memoria de direcciones MAC descubiertas para cámaras a batería
_SEEN_ARP_CACHE = {
    '192.168.1.28': 'b4:61:e9:5d:fa:ac',
    '192.168.1.20': 'bc:2b:02:fd:13:3b'
}

def _get_arp_table(target_ip=None):
    """Obtiene la tabla ARP del sistema operativo para mapear IPs a direcciones MAC."""
    arp_map = dict(_SEEN_ARP_CACHE)
    try:
        if target_ip and platform.system() != "Windows":
            cmd = ["arp", target_ip]
        elif platform.system() != "Windows":
            cmd = ["arp", "-a"]
        else:
            cmd = ["arp", "-a"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=3.5)
        if res.returncode == 0:
            for line in res.stdout.splitlines():
                if "incomplete" in line.lower() or "no entry" in line.lower():
                    continue
                # Formato Unix/Mac: ? (192.168.1.28) at b4:61:e9:5d:fa:ac on en1 ifscope [ethernet]
                # Formato Windows:  192.168.1.28      b4-61-e9-5d-fa-ac     dinámico
                ip_match = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                mac_match = re.search(r'([0-9a-fA-F]{1,2}[:-][0-9a-fA-F]{1,2}[:-][0-9a-fA-F]{1,2}[:-][0-9a-fA-F]{1,2}[:-][0-9a-fA-F]{1,2}[:-][0-9a-fA-F]{1,2})', line)
                if ip_match and mac_match:
                    ip = ip_match.group(1)
                    mac = mac_match.group(1).replace('-', ':').lower()
                    arp_map[ip] = mac
                    _SEEN_ARP_CACHE[ip] = mac
    except Exception:
        pass
    return arp_map

def onvif_ws_discovery(timeout=1.8):
    """
    Descubre cámaras ONVIF en la red local enviando un WS-Discovery Probe por UDP Multicast.
    Retorna una lista de diccionarios con la información detectada.
    """
    probe_msg = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
        'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
        'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        f'<s:Header><a:MessageID>uuid:{uuid.uuid4()}</a:MessageID>'
        '<a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>'
        '<a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>'
        '</s:Header><s:Body><d:Probe>'
        '<d:Types>dn:NetworkVideoTransmitter</d:Types>'
        '</d:Probe></s:Body></s:Envelope>'
    ).encode('utf-8')

    devices = []
    seen_ips = set()

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(timeout)
        # Multicast ONVIF estándar 239.255.255.250:3702
        sock.sendto(probe_msg, ("239.255.255.250", 3702))

        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                data, addr = sock.recvfrom(65535)
                ip = addr[0]
                if ip in seen_ips:
                    continue
                seen_ips.add(ip)

                xml_str = data.decode('utf-8', errors='ignore')
                xaddrs_match = re.search(r'XAddrs>([^<]+)<', xml_str)
                scopes_match = re.search(r'Scopes>([^<]+)<', xml_str)

                xaddrs = xaddrs_match.group(1).split() if xaddrs_match else []
                scopes = scopes_match.group(1).split() if scopes_match else []

                # Extraer fabricante/modelo de los scopes ONVIF
                hardware = "ONVIF Camera"
                name = f"Cámara ONVIF ({ip})"
                for scope in scopes:
                    if 'hardware/' in scope:
                        hardware = scope.split('hardware/')[-1]
                    elif 'name/' in scope:
                        name = scope.split('name/')[-1]
                    elif 'model/' in scope:
                        hardware = scope.split('model/')[-1]

                # Determinar puerto ONVIF
                onvif_port = 80
                service_url = f"http://{ip}:{onvif_port}/onvif/device_service"
                if xaddrs:
                    service_url = xaddrs[0]
                    parsed = urlparse(service_url)
                    if parsed.port:
                        onvif_port = parsed.port

                devices.append({
                    'ip': ip,
                    'type': 'onvif',
                    'name': name,
                    'hardware': hardware,
                    'onvif_port': onvif_port,
                    'open_ports': [554, onvif_port],
                    'service_url': service_url,
                    'suggested_rtsp': f"rtsp://admin:admin@{ip}:554/live/ch0",
                    'status': 'online',
                    'latency_ms': round((time.time() - start_time) * 1000, 1)
                })
            except socket.timeout:
                break
            except Exception as e:
                logger.debug(f"Error procesando respuesta ONVIF: {e}")
                break
        sock.close()
    except Exception as e:
        logger.error(f"Error en onvif_ws_discovery: {e}")

    return devices

def _check_port(ip, port, timeout=0.25):
    """Verifica si un puerto TCP está abierto en una IP específica y mide latencia."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    t0 = time.time()
    try:
        s.connect((ip, port))
        lat = round((time.time() - t0) * 1000, 1)
        s.close()
        return True, lat
    except Exception:
        return False, 0

def scan_network_cameras(custom_subnet=None):
    """
    Escaneo inteligente de alta velocidad:
    1. WS-Discovery ONVIF multicast (instantáneo ~1.5s)
    2. Barrido multihilo de puertos RTSP y CCTV en la subred local
    3. Identificación de marca y generación de URLs RTSP sugeridas
    """
    start_time = time.time()
    discovered = []
    seen_ips = set()
    arp_map = _get_arp_table()

    # 1. Probar descubrimiento ONVIF
    onvif_devices = onvif_ws_discovery(timeout=1.6)
    for dev in onvif_devices:
        dev['mac'] = arp_map.get(dev['ip'], 'Desconocida')
        dev['suggested_urls'] = build_suggested_urls(dev['ip'], dev.get('hardware', ''))
        discovered.append(dev)
        seen_ips.add(dev['ip'])

    # 2. Barrido de subredes
    if custom_subnet:
        subnets_to_scan = [(custom_subnet if custom_subnet.endswith('.') else custom_subnet + '.', '')]
    else:
        subnets_to_scan = get_lan_subnets()

    # Recopilar todas las IPs locales de esta máquina para no auto-detectarse como cámara
    all_local_ips = set()
    for _, lip in subnets_to_scan:
        all_local_ips.add(lip)
    try:
        for host_ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            all_local_ips.add(host_ip)
    except Exception:
        pass

    ips_to_scan = []
    for subnet, local_ip in subnets_to_scan:
        for i in range(1, 255):
            target_ip = f"{subnet}{i}"
            if target_ip not in all_local_ips and target_ip not in seen_ips:
                ips_to_scan.append(target_ip)

    def probe_host(ip):
        open_ports = []
        best_lat = 999.0
        for port in [554, 8899, 80, 8080, 34567, 5000, 8554, 8800, 2020, 5054]:
            is_open, lat = _check_port(ip, port, timeout=0.22)
            if is_open:
                open_ports.append(port)
                if lat < best_lat:
                    best_lat = lat

        if not open_ports:
            return None

        # Para considerar que es una cámara CCTV real:
        is_camera = (554 in open_ports or 8899 in open_ports or 34567 in open_ports or 
                     (5000 in open_ports and 554 in open_ports) or 8554 in open_ports or
                     8800 in open_ports or 2020 in open_ports or 5054 in open_ports)
        if not is_camera:
            return None

        # Deducir fabricante / hardware
        if 8800 in open_ports or 5054 in open_ports:
            hardware = "V380 / Macro-video"
            onvif_p = 8899 if 8899 in open_ports else 80
            suggested_rtsp = f"rtsp://admin:@{ip}:554/live/ch0"
        elif 2020 in open_ports:
            hardware = "TP-Link Tapo"
            onvif_p = 2020
            suggested_rtsp = f"rtsp://admin:@{ip}:554/stream1"
        elif 8899 in open_ports or 34567 in open_ports:
            hardware = "Xiongmai / iCSee / V380 ONVIF"
            onvif_p = 8899
            suggested_rtsp = f"rtsp://admin:@{ip}:554/stream0"
        elif 5000 in open_ports and 554 in open_ports:
            hardware = "Yoosee / CooCam"
            onvif_p = 5000
            suggested_rtsp = f"rtsp://admin:123456@{ip}:554/onvif1"
        elif 8554 in open_ports:
            hardware = "Tuya RTSP Bridge / Local RTSP"
            onvif_p = 8787
            suggested_rtsp = f"rtsp://localhost:8554/Cámara_de_nubes/hd"
        else:
            hardware = "Sehmua / iCam365 / Genérica ONVIF"
            onvif_p = 80 if 80 in open_ports else (8080 if 8080 in open_ports else 554)
            suggested_rtsp = f"rtsp://admin:admin@{ip}:554/live/ch0"

        # Nombre de host DNS
        hostname = ""
        try:
            hostname = socket.gethostbyaddr(ip)[0]
        except Exception:
            hostname = f"Cámara IP ({ip})"

        mac = arp_map.get(ip, 'Desconocida')

        return {
            'ip': ip,
            'type': 'rtsp_host',
            'name': hostname,
            'hardware': hardware,
            'onvif_port': onvif_p,
            'open_ports': open_ports,
            'mac': mac,
            'latency_ms': best_lat if best_lat < 900 else 10.0,
            'suggested_rtsp': suggested_rtsp,
            'suggested_urls': build_suggested_urls(ip, hardware),
            'status': 'online'
        }

    with ThreadPoolExecutor(max_workers=55) as executor:
        results = executor.map(probe_host, ips_to_scan)
        for res in results:
            if res and res['ip'] not in seen_ips:
                discovered.append(res)
                seen_ips.add(res['ip'])

    elapsed = round(time.time() - start_time, 2)

    return {
        'count': len(discovered),
        'elapsed_seconds': elapsed,
        'subnet_scanned': subnets_to_scan[0][0] if subnets_to_scan else '192.168.1.',
        'local_ip': subnets_to_scan[0][1] if subnets_to_scan else '',
        'devices': discovered,
        'presets': CAMERA_PRESETS
    }

def build_suggested_urls(ip: str, hardware: str = "") -> list:
    """Genera una lista de URLs RTSP sugeridas listas para probar según la IP."""
    urls = [
        {
            'label': 'V380 / V380 Pro (Canal HD /live/ch0)',
            'url': f"rtsp://admin:@{ip}:554/live/ch0",
            'substream': f"rtsp://admin:@{ip}:554/live/ch1",
            'brand': 'V380'
        },
        {
            'label': 'V380 Alternativo (/0)',
            'url': f"rtsp://admin:@{ip}:554/0",
            'substream': f"rtsp://admin:@{ip}:554/1",
            'brand': 'V380'
        },
        {
            'label': 'Sehmua / Ubox (PTZ HD)',
            'url': f"rtsp://admin:admin@{ip}:554/live/ch0",
            'substream': f"rtsp://admin:admin@{ip}:554/live/ch1",
            'brand': 'Sehmua'
        },
        {
            'label': 'Sehmua Alternativo (/stream0)',
            'url': f"rtsp://admin:admin@{ip}:554/stream0",
            'substream': f"rtsp://admin:admin@{ip}:554/stream1",
            'brand': 'Sehmua'
        },
        {
            'label': 'TP-Link Tapo (Canal 1)',
            'url': f"rtsp://admin:@{ip}:554/stream1",
            'substream': f"rtsp://admin:@{ip}:554/stream2",
            'brand': 'Tapo'
        },
        {
            'label': 'iCam365 / EyePlus (HD)',
            'url': f"rtsp://admin:admin@{ip}:554/live/ch0",
            'substream': f"rtsp://admin:admin@{ip}:554/live/ch1",
            'brand': 'iCam365'
        },
        {
            'label': 'Xiongmai / iCSee (XMeye)',
            'url': f"rtsp://admin:@{ip}:554/stream0",
            'substream': f"rtsp://admin:@{ip}:554/stream1",
            'brand': 'iCSee'
        },
        {
            'label': 'Yoosee / CooCam (Clave: 123456)',
            'url': f"rtsp://admin:123456@{ip}:554/onvif1",
            'substream': f"rtsp://admin:123456@{ip}:554/onvif2",
            'brand': 'Yoosee'
        },
        {
            'label': 'CamHi / HiSilicon (11)',
            'url': f"rtsp://admin:admin@{ip}:554/11",
            'substream': f"rtsp://admin:admin@{ip}:554/12",
            'brand': 'CamHi'
        },
        {
            'label': 'Dahua / Imou (Canal 1)',
            'url': f"rtsp://admin:admin123@{ip}:554/cam/realmonitor?channel=1&subtype=0",
            'substream': f"rtsp://admin:admin123@{ip}:554/cam/realmonitor?channel=1&subtype=1",
            'brand': 'Dahua'
        },
        {
            'label': 'Hikvision / Hilook (Canal 101)',
            'url': f"rtsp://admin:12345@{ip}:554/Streaming/Channels/101",
            'substream': f"rtsp://admin:12345@{ip}:554/Streaming/Channels/102",
            'brand': 'Hikvision'
        }
    ]
    return urls

def test_rtsp_connection(rtsp_url: str, timeout: float = 3.5) -> dict:
    """
    Verifica si una URL RTSP responde correctamente y puede entregar fotogramas de video.
    Retorna la resolución, tiempo de respuesta y estado.
    """
    if not rtsp_url:
        return {'success': False, 'error': 'URL RTSP vacía'}

    t0 = time.time()
    try:
        import cv2
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|analyzeduration;1000000|probesize;1000000"
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            elapsed = round((time.time() - t0) * 1000)
            return {
                'success': False,
                'latency_ms': elapsed,
                'error': 'No se pudo abrir el flujo RTSP. Verifica la IP, usuario y contraseña.'
            }

        ret, frame = cap.read()
        cap.release()
        elapsed = round((time.time() - t0) * 1000)

        if ret and frame is not None and frame.size > 0:
            h, w = frame.shape[:2]
            return {
                'success': True,
                'resolution': f"{w}x{h}",
                'latency_ms': elapsed,
                'message': f"¡Conexión exitosa! Resolución: {w}x{h} ({elapsed}ms)"
            }
        else:
            return {
                'success': False,
                'latency_ms': elapsed,
                'error': 'Flujo conectado pero no se recibió ningún fotograma de video válido.'
            }
    except Exception as e:
        return {'success': False, 'error': str(e)}

def diagnose_camera_ip(ip: str) -> dict:
    """
    Diagnóstico forense y profundo de una cámara IP específica (ej: 192.168.1.28).
    Evalúa conectividad, tabla ARP, puertos abiertos, protocolos ONVIF/RTSP y estado de suspensión de batería (Ubox).
    """
    ip = ip.strip()
    res = {
        'ip': ip,
        'ping': False,
        'mac': 'Desconocida',
        'vendor': 'Desconocido',
        'is_sleep_mode': False,
        'is_ubox': False,
        'open_ports': [],
        'onvif_detected': False,
        'rtsp_tested': False,
        'working_url': None,
        'status': 'offline',
        'diagnosis': '',
        'recommendations': []
    }

    # 1. Ping (con margen de despertar para cámaras a batería que tardan ~1s en responder el primer ICMP)
    try:
        ping_cmd = ["ping", "-c", "2", "-W", "1500", ip] if platform.system() != "Windows" else ["ping", "-n", "2", "-w", "1500", ip]
        p_res = subprocess.run(ping_cmd, capture_output=True, text=True, timeout=4.0)
        res['ping'] = (p_res.returncode == 0)
    except Exception:
        res['ping'] = False

    # 2. ARP y MAC (consultar después del ping para que el kernel haya registrado la MAC)
    arp_map = _get_arp_table(target_ip=ip)
    mac = arp_map.get(ip, 'Desconocida')
    if mac == 'Desconocida':
        time.sleep(0.3)
        arp_map = _get_arp_table(target_ip=ip)
        mac = arp_map.get(ip, 'Desconocida')
    res['mac'] = mac

    # Identificación de fabricante por prefijo MAC
    mac_lower = mac.lower().replace('-', ':')
    vendor = "Desconocido"
    if mac_lower.startswith(('b4:61:e9', '38:01:46', '84:f7:03', '70:89:10')):
        vendor = "Sichuan AI-Link Technology (Cámara Ubox / Batería)"
        res['is_ubox'] = True
    elif mac_lower.startswith(('bc:2b:02', '34:ea:e7', '00:12:12')):
        vendor = "China Dragon Tech / Xiongmai (iCam365 / V380 / XM)"
    elif mac_lower.startswith(('44:19:b6', '60:03:49', '50:d4:f7')):
        vendor = "TP-Link Tapo"
    elif mac_lower.startswith(('d8:96:e0', '28:6c:07', '18:69:d8')):
        vendor = "Tuya Smart Inc."
    res['vendor'] = vendor

    # 3. Escaneo de puertos CCTV conocidos
    ports_to_test = [554, 80, 8899, 8080, 8554, 34567, 5000, 2020, 8800, 5054]
    open_ports = []
    for p in ports_to_test:
        is_open, _ = _check_port(ip, p, timeout=0.3)
        if is_open:
            open_ports.append(p)
    res['open_ports'] = open_ports

    # 4. Probar WS-Discovery ONVIF unicast
    try:
        probe = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<Envelope xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns="http://www.w3.org/2003/05/soap-envelope">'
            '<Header><Action xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</Action></Header>'
            '<Body><Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery"/></Body></Envelope>'
        )
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(1.0)
        s.sendto(probe.encode(), (ip, 3702))
        data, _ = s.recvfrom(2048)
        if b'Envelope' in data:
            res['onvif_detected'] = True
        s.close()
    except Exception:
        pass

    # 5. Probar RTSP si el puerto 554 está abierto
    if 554 in open_ports:
        test_paths = ['/live/ch0', '/h264Preview_01_main', '/stream0', '/0', '/onvif1', '/live/ch1']
        test_creds = [('admin', 'admin'), ('admin', ''), ('admin', '123456')]
        for path in test_paths:
            for u, pwd in test_creds:
                auth = f"{u}:{pwd}@" if pwd or u else (f"{u}@" if u else "")
                url = f"rtsp://{auth}{ip}:554{path}"
                t_res = test_rtsp_connection(url, timeout=2.5)
                if t_res.get('success'):
                    res['working_url'] = url
                    res['rtsp_tested'] = True
                    break
            if res['working_url']:
                break

    # 6. Diagnóstico y Dictamen
    if res['working_url']:
        res['status'] = 'online'
        res['diagnosis'] = f"¡Cámara operativa! Flujo RTSP detectado exitosamente en: {res['working_url']}"
        res['recommendations'].append(f"Usa directamente la URL: {res['working_url']}")
    elif 554 in open_ports:
        res['status'] = 'rtsp_open_unauthenticated'
        res['diagnosis'] = "El puerto RTSP (554) está ABIERTO, pero las credenciales predeterminadas no coincidieron."
        res['recommendations'].append("Ingresa el usuario y contraseña que configuraste en la app móvil.")
    elif res['mac'] != 'Desconocida' and len(open_ports) == 0:
        res['status'] = 'sleep_or_closed'
        res['is_sleep_mode'] = True
        if res['is_ubox']:
            res['diagnosis'] = (
                f"La cámara está registrada en el router (MAC: {mac}, Módulo: {vendor}), "
                "pero está en MODO SUSPENSIÓN PROFUNDA (Batería/PIR) o tiene el servidor RTSP local deshabilitado de fábrica en la app Ubox."
            )
            res['recommendations'].append("1. Pasa la mano frente al sensor PIR de la cámara o abre la transmisión en vivo en la app Ubox de tu celular para despertarla.")
            res['recommendations'].append("2. En la app Ubox: Ve a Ajustes > Modo de Energía y cámbialo a 'Modo Continuo / Siempre Encendida' (requiere cable de alimentación USB constante).")
            res['recommendations'].append("3. En la app Ubox: Busca 'Monitoreo LAN' o 'Configuración de PC' para activar la transmisión en red local y fijar una contraseña.")
            res['recommendations'].append("4. Si tu cámara Ubox es estrictamente 'Cloud P2P Only', el fabricante no incluye servidor RTSP en su firmware.")
        else:
            res['diagnosis'] = f"El dispositivo responde en ARP ({mac}) pero no tiene puertos de cámara abiertos."
            res['recommendations'].append("Verifica que la cámara esté encendida y tenga habilitado el protocolo ONVIF o RTSP.")
    else:
        res['status'] = 'unreachable'
        res['diagnosis'] = f"La IP {ip} no responde en la red local (Host no alcanzable o apagado)."
        res['recommendations'].append("Verifica que la cámara esté encendida y conectada al mismo Wi-Fi.")

    return res

# ----------------- EJECUCIÓN DIRECTA POR TERMINAL (CLI) -----------------
if __name__ == '__main__':
    print("\n" + "=" * 65)
    print(" 🔍 ANALIZADOR DE RED Y DETECTOR DE CÁMARAS IP (CCTV)")
    print("=" * 65)
    print(" Escaneando la red local en busca de cámaras ONVIF / RTSP...")
    
    scan_res = scan_network_cameras()
    devices = scan_res.get('devices', [])
    count = len(devices)
    elapsed = scan_res.get('elapsed_seconds', 0)
    subnet = scan_res.get('subnet_scanned', '')
    local_ip = scan_res.get('local_ip', '')

    print(f"\n📡 Subred analizada: {subnet}0/24 | IP Local: {local_ip}")
    print(f"⏱️ Tiempo de escaneo: {elapsed} segundos")
    print(f"🎯 Cámaras encontradas: {count}\n")

    if count == 0:
        print("⚠️ No se encontraron cámaras activas en esta subred.")
        print("💡 Sugerencias:")
        print("   1. Asegúrate de que la cámara esté encendida y conectada al mismo Wi-Fi o Router.")
        print("   2. Revisa si la cámara usa una subred diferente (ej. 192.168.0.x o 10.0.0.x).")
    else:
        for idx, dev in enumerate(devices, 1):
            print(f"[{idx}] 📹 IP: {dev['ip']}")
            print(f"    • Fabricante / Tipo: {dev['hardware']}")
            print(f"    • Nombre: {dev['name']}")
            print(f"    • Puertos abiertos: {dev.get('open_ports', [])}")
            print(f"    • MAC: {dev.get('mac', 'N/A')}")
            print(f"    • RTSP sugerido: {dev['suggested_rtsp']}")
            print("-" * 65)

    print("\n")
