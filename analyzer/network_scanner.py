import socket
import uuid
import re
import xml.etree.ElementTree as ET
import logging
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse
import cv2

logger = logging.getLogger(__name__)

# Puertos comúnmente utilizados por cámaras de seguridad IP
CAMERA_PORTS = [554, 80, 8080, 8899, 34567, 8554]

# Plantillas y perfiles de conexión para diferentes fabricantes
CAMERA_PRESETS = [
    {
        'id': 'icam365',
        'name': 'iCam365 / EyePlus / Ginatex',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch1',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin',
        'notes': 'Cámara Wi-Fi exterior/interior iCam365. Protocolo ONVIF Profile S nativo.'
    },
    {
        'id': 'xm_icsee',
        'name': 'Xiongmai / iCSee / XM (Cámara China común)',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/stream0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/stream1',
        'onvif_port': 8899,
        'default_user': 'admin',
        'default_pass': '',
        'notes': 'Usada en millones de cámaras chinas baratas (iCSee / XMeye). Puerto ONVIF típico: 8899.'
    },
    {
        'id': 'yoosee',
        'name': 'Yoosee / CooCam / GOSCAM',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/onvif1',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/onvif2',
        'onvif_port': 5000,
        'default_user': 'admin',
        'default_pass': '123456',
        'notes': 'Cámaras de bombillo y domo Yoosee. En la app Yoosee se debe habilitar RTSP y fijar clave.'
    },
    {
        'id': 'camhi',
        'name': 'CamHi / HiSilicon',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/11',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/12',
        'onvif_port': 8080,
        'default_user': 'admin',
        'default_pass': 'admin',
        'notes': 'Chipsets HiSilicon comunes en cámaras de metal para exterior.'
    },
    {
        'id': 'tuya_bridge',
        'name': 'Tuya / Smart Life (vía RTSP Bridge)',
        'rtsp_template': 'rtsp://localhost:8554/{stream_name}/hd',
        'substream_template': 'rtsp://localhost:8554/{stream_name}/sd',
        'onvif_port': 8787,
        'default_user': '',
        'default_pass': '',
        'notes': 'Cámaras Tuya que requieren contenedor tuya-rtsp-bridge para extraer RTSP.'
    },
    {
        'id': 'dahua',
        'name': 'Dahua / Imou / Lorex',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/cam/realmonitor?channel=1&subtype=0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/cam/realmonitor?channel=1&subtype=1',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin123',
        'notes': 'Cámaras y NVR Dahua/Imou estándar.'
    },
    {
        'id': 'hikvision',
        'name': 'Hikvision / Hilook / Ezviz',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/Streaming/Channels/101',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/Streaming/Channels/102',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': '12345',
        'notes': 'Cámaras y grabadores Hikvision/Ezviz con RTSP habilitado.'
    },
    {
        'id': 'generic_onvif',
        'name': 'Genérica ONVIF / RTSP',
        'rtsp_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch0',
        'substream_template': 'rtsp://{user}:{pass}@{ip}:554/live/ch1',
        'onvif_port': 80,
        'default_user': 'admin',
        'default_pass': 'admin',
        'notes': 'Cualquier cámara compatible con ONVIF Profile S.'
    }
]

def get_lan_subnet():
    """Obtiene la subred local (ej: '192.168.1.') para el escaneo de puertos."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        parts = local_ip.split('.')
        return f"{parts[0]}.{parts[1]}.{parts[2]}.", local_ip
    except Exception:
        return "192.168.1.", "192.168.1.5"

def onvif_ws_discovery(timeout=2.0):
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

        while True:
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
                    'service_url': service_url,
                    'suggested_rtsp': f"rtsp://admin:admin@{ip}:554/live/ch0",
                    'status': 'discovered'
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

def _check_port(ip, port, timeout=0.35):
    """Verifica si un puerto TCP está abierto en una IP específica."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, port))
        s.close()
        return True
    except Exception:
        return False

def scan_network_cameras():
    """
    Escaneo combinado:
    1. WS-Discovery ONVIF multicast (instantáneo, 1.5s)
    2. Sondeo rápido de puertos RTSP y ONVIF en la subred
    3. Asignación de plantillas sugeridas
    """
    discovered = []
    seen_ips = set()

    # 1. Probar descubrimiento ONVIF
    onvif_devices = onvif_ws_discovery(timeout=1.8)
    for dev in onvif_devices:
        discovered.append(dev)
        seen_ips.add(dev['ip'])

    # 2. Barrido de subred en puertos clave (solo si faltan cámaras o para detectar cámaras no-ONVIF)
    subnet, local_ip = get_lan_subnet()
    ips_to_scan = [f"{subnet}{i}" for i in range(1, 255) if f"{subnet}{i}" != local_ip and f"{subnet}{i}" not in seen_ips]

    def probe_host(ip):
        open_ports = []
        for port in [554, 8899, 80]:
            if _check_port(ip, port, timeout=0.25):
                open_ports.append(port)
        if 554 in open_ports or 8899 in open_ports:
            return {
                'ip': ip,
                'type': 'rtsp_host',
                'name': f"Dispositivo de Video ({ip})",
                'hardware': "XM / iCSee / Genérica" if 8899 in open_ports else "RTSP Camera",
                'onvif_port': 8899 if 8899 in open_ports else 80,
                'suggested_rtsp': f"rtsp://admin:admin@{ip}:554/stream0" if 8899 in open_ports else f"rtsp://admin:admin@{ip}:554/live/ch0",
                'status': 'discovered'
            }
        return None

    with ThreadPoolExecutor(max_workers=45) as executor:
        results = executor.map(probe_host, ips_to_scan)
        for res in results:
            if res:
                discovered.append(res)
                seen_ips.add(res['ip'])

    return {
        'count': len(discovered),
        'devices': discovered,
        'presets': CAMERA_PRESETS
    }

def test_rtsp_connection(rtsp_url: str, timeout: float = 3.0) -> dict:
    """
    Verifica si una URL RTSP responde correctamente y puede entregar fotogramas de video.
    """
    if not rtsp_url:
        return {'success': False, 'error': 'URL RTSP vacía'}

    try:
        import os
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            return {'success': False, 'error': 'No se pudo abrir el flujo RTSP. Verifica IP, usuario y contraseña.'}

        ret, frame = cap.read()
        cap.release()

        if ret and frame is not None and frame.size > 0:
            h, w = frame.shape[:2]
            return {
                'success': True,
                'resolution': f"{w}x{h}",
                'message': f"¡Conexión exitosa! Resolución detectada: {w}x{h}"
            }
        else:
            return {'success': False, 'error': 'Flujo abierto pero no se recibió ningún fotograma de video.'}
    except Exception as e:
        return {'success': False, 'error': str(e)}
