"""
analyzer/system_profiler.py
Módulo de diagnóstico de hardware, detección de capacidades y auto-acomodación del sistema CCTV.
Permite que el sistema se adapte de forma transparente a cualquier computadora (Mac, Windows o Linux),
identificando si es un equipo modesto (Modo NVR Ligero) o de alto rendimiento (Modo IA Full).
"""

import os
import sys
import platform
import shutil
import logging
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# Intentar importar psutil para métricas precisas de RAM y CPU; fallback nativo si no está instalado
try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    psutil = None
    PSUTIL_AVAILABLE = False


def check_ai_libraries() -> Dict[str, Any]:
    """Verifica si PyTorch y Ultralytics están instalados y qué acelerador de hardware está disponible."""
    info = {
        'torch_installed': False,
        'torch_version': None,
        'ultralytics_installed': False,
        'ultralytics_version': None,
        'acceleration': 'none',  # 'mps', 'cuda', 'cpu', 'none'
        'device_name': 'No disponible',
        'is_available': False
    }

    try:
        import torch
        info['torch_installed'] = True
        info['torch_version'] = getattr(torch, '__version__', 'Desconocida')

        # Detección de Aceleración por Hardware
        if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            info['acceleration'] = 'mps'
            info['device_name'] = 'Apple Silicon (Metal Performance Shaders / GPU)'
        elif torch.cuda.is_available():
            info['acceleration'] = 'cuda'
            gpu_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else 'NVIDIA CUDA'
            info['device_name'] = f"NVIDIA GPU ({gpu_name})"
        else:
            info['acceleration'] = 'cpu'
            info['device_name'] = 'CPU Convencional (Sin Acelerador Gráfico)'
    except ImportError:
        pass
    except Exception as e:
        logger.debug(f"Aviso verificando Torch: {e}")

    try:
        import ultralytics
        info['ultralytics_installed'] = True
        info['ultralytics_version'] = getattr(ultralytics, '__version__', 'Desconocida')
    except ImportError:
        pass
    except Exception as e:
        logger.debug(f"Aviso verificando Ultralytics: {e}")

    # IA completamente disponible solo si ambos módulos existen
    info['is_available'] = bool(info['torch_installed'] and info['ultralytics_installed'])
    return info


def get_hardware_specs() -> Dict[str, Any]:
    """Obtiene información sobre CPU, RAM, Sistema Operativo y Almacenamiento."""
    os_name = platform.system()
    os_release = platform.release()
    arch = platform.machine()
    
    # 1. CPU Cores
    logical_cores = os.cpu_count() or 1
    physical_cores = logical_cores
    if PSUTIL_AVAILABLE:
        try:
            p_cores = psutil.cpu_count(logical=False)
            if p_cores:
                physical_cores = p_cores
        except Exception:
            pass

    # 2. RAM (GB)
    total_ram_gb = 0.0
    free_ram_gb = 0.0
    ram_usage_percent = 0.0

    if PSUTIL_AVAILABLE:
        try:
            mem = psutil.virtual_memory()
            total_ram_gb = round(mem.total / (1024 ** 3), 1)
            free_ram_gb = round(mem.available / (1024 ** 3), 1)
            ram_usage_percent = mem.percent
        except Exception as e:
            logger.debug(f"Error con psutil en RAM: {e}")

    # Fallbacks nativos si psutil no está disponible o falló
    if total_ram_gb == 0.0:
        try:
            if os_name == 'Darwin':
                import subprocess
                out = subprocess.check_output(['sysctl', '-n', 'hw.memsize']).decode().strip()
                total_ram_gb = round(int(out) / (1024 ** 3), 1)
                free_ram_gb = round(total_ram_gb * 0.5, 1)  # Estimación segura
            elif os_name == 'Linux':
                with open('/proc/meminfo', 'r') as f:
                    for line in f:
                        if line.startswith('MemTotal:'):
                            kb = int(line.split()[1])
                            total_ram_gb = round(kb / (1024 ** 2), 1)
                        elif line.startswith('MemAvailable:'):
                            kb = int(line.split()[1])
                            free_ram_gb = round(kb / (1024 ** 2), 1)
            elif os_name == 'Windows':
                total_ram_gb = 8.0
                free_ram_gb = 4.0
        except Exception:
            total_ram_gb = 4.0
            free_ram_gb = 2.0

    # 3. FFmpeg Check
    ffmpeg_available = bool(shutil.which('ffmpeg'))

    return {
        'os': os_name,
        'os_release': os_release,
        'architecture': arch,
        'logical_cores': logical_cores,
        'physical_cores': physical_cores,
        'total_ram_gb': total_ram_gb,
        'free_ram_gb': free_ram_gb,
        'ram_usage_percent': ram_usage_percent,
        'ffmpeg_available': ffmpeg_available
    }


def determine_recommended_profile(specs: Dict[str, Any], ai_info: Dict[str, Any]) -> str:
    """
    Determina el perfil de rendimiento recomendado según el hardware detectado:
    - 'light': PC modesta (<4 núcleos, <4GB RAM, o sin IA instalada).
    - 'balanced': PC estándar (4-6 núcleos, >=4GB RAM, CPU pura).
    - 'performance': PC potente (Apple Silicon MPS, NVIDIA CUDA, o >=8 núcleos con >=8GB RAM).
    """
    if not ai_info['is_available']:
        return 'light'

    if ai_info['acceleration'] in ('mps', 'cuda'):
        return 'performance'

    cores = specs.get('logical_cores', 1)
    ram = specs.get('total_ram_gb', 0.0)

    if cores < 4 or ram < 3.5:
        return 'light'

    if cores >= 8 and ram >= 7.5:
        return 'performance'

    return 'balanced'


def get_capabilities_matrix(profile: str, specs: Dict[str, Any], ai_info: Dict[str, Any]) -> Dict[str, Any]:
    """
    Genera el desglose interactivo de qué funciones están habilitadas, deshabilitadas
    y la justificación técnica en lenguaje comprensible para el usuario.
    """
    is_light = (profile == 'light')
    is_balanced = (profile == 'balanced')
    is_performance = (profile == 'performance')
    has_ai = ai_info['is_available']

    matrix = {
        'continuous_recording': {
            'supported': True,
            'enabled': True,
            'label': 'Grabación Continua 24/7',
            'desc': 'Guardado directo de video a disco sin compresión pesada.',
            'status_badge': '100% Soportada',
            'impact': 'Mínimo (~1% a 3% CPU)'
        },
        'motion_recording': {
            'supported': True,
            'enabled': True,
            'label': 'Grabación por Detección de Movimiento',
            'desc': 'Guarda videoclips MP4 con algoritmo de substracción de fondo OpenCV.',
            'status_badge': '100% Soportada',
            'impact': 'Ultra-ligero (~2% CPU)'
        },
        'motion_detection': {
            'supported': True,
            'enabled': True,
            'label': 'Detección Visual de Movimiento',
            'desc': 'Dibuja recuadros y calcula el porcentaje de movimiento en pantalla.',
            'status_badge': '100% Soportada',
            'impact': 'Ultra-ligero'
        },
        'ai_filter': {
            'supported': has_ai,
            'enabled': has_ai and (not is_light),
            'label': 'Filtro Inteligente con IA (Personas / Vehículos)',
            'desc': 'Filtra eventos para alertar únicamente cuando hay personas o vehículos, ignorando sombras o animales.',
            'status_badge': (
                'Activo (Acelerado)' if (has_ai and is_performance) else
                'Activo (Bajo Demanda)' if (has_ai and is_balanced) else
                'Desactivado (Modo Ligero)' if is_light else
                'No Instalado'
            ),
            'reason': (
                'Funcionando con aceleración por hardware.' if (has_ai and is_performance) else
                'Se activa de forma inteligente solo cuando hay movimiento previo para no sobrecalentar el CPU.' if (has_ai and is_balanced) else
                'Desactivado en Modo Ligero para garantizar 0% de saturación y fluidez total en este equipo.' if is_light else
                'Librerías de IA (Torch / Ultralytics) no instaladas en este equipo.'
            )
        },
        'auto_tracking': {
            'supported': has_ai,
            'enabled': has_ai and (not is_light),
            'label': 'Seguimiento Físico Automático (Auto-Tracking PTZ)',
            'desc': 'Gira los motores de la cámara para centrar a personas u objetos en movimiento.',
            'status_badge': (
                'Activo Continuo' if (has_ai and is_performance) else
                'Activo por Evento' if (has_ai and is_balanced) else
                'Desactivado en Modo Ligero'
            ),
            'reason': (
                'Seguimiento en tiempo real activado.' if (has_ai and is_performance) else
                'Seguimiento activado cuando se detecta movimiento de personas.' if (has_ai and is_balanced) else
                'Requiere módulo de IA para seguir objetivos de forma precisa.'
            )
        },
        'live_streaming': {
            'supported': True,
            'enabled': True,
            'label': 'Visor en Vivo (Web & Modo Móvil /m)',
            'desc': 'Visualización en tiempo real desde PC, tablet o celular en la red local.',
            'status_badge': '100% Soportado',
            'impact': 'Acelerado por navegador'
        }
    }

    return matrix


class SystemProfiler:
    """Clase principal de diagnóstico y acomodación del sistema."""
    
    def __init__(self, settings_profile: str = 'auto'):
        self.specs = get_hardware_specs()
        self.ai_info = check_ai_libraries()
        self.recommended_profile = determine_recommended_profile(self.specs, self.ai_info)
        
        # Perfil configurado por el usuario ('auto', 'light', 'balanced', 'performance')
        self.configured_profile = settings_profile or 'auto'
        self.active_profile = self.resolve_active_profile(self.configured_profile)
        self.capabilities = get_capabilities_matrix(self.active_profile, self.specs, self.ai_info)

    def resolve_active_profile(self, target_profile: str) -> str:
        """Resuelve el perfil efectivo considerando si la IA está disponible."""
        if target_profile == 'auto':
            return self.recommended_profile
        
        # Si el usuario eligió un perfil con IA pero no está instalada, forzar 'light'
        if target_profile in ('balanced', 'performance') and not self.ai_info['is_available']:
            logger.warning(
                f"Perfil '{target_profile}' solicitado, pero PyTorch/Ultralytics no está disponible. "
                "Cambiando automáticamente a 'light' (Modo NVR Ligero)."
            )
            return 'light'

        if target_profile in ('light', 'balanced', 'performance'):
            return target_profile

        return self.recommended_profile

    def set_profile(self, new_profile: str) -> Dict[str, Any]:
        """Cambia el perfil activo y recalcula las capacidades."""
        self.configured_profile = new_profile
        self.active_profile = self.resolve_active_profile(new_profile)
        self.capabilities = get_capabilities_matrix(self.active_profile, self.specs, self.ai_info)
        return self.get_summary()

    def get_summary(self) -> Dict[str, Any]:
        """Retorna un diccionario completo listo para serializar en JSON para la API Web."""
        profile_names = {
            'light': 'Modo NVR Ligero (Solo Grabador y Visor)',
            'balanced': 'Modo Equilibrado (IA Bajo Demanda)',
            'performance': 'Modo Alto Rendimiento (IA Full Core)'
        }

        profile_badges = {
            'light': '⚡ NVR Ligero (Sin IA)',
            'balanced': '⚖️ IA Equilibrada',
            'performance': f"🚀 IA Acelerada ({self.ai_info['acceleration'].upper()})"
        }

        return {
            'configured_profile': self.configured_profile,
            'active_profile': self.active_profile,
            'recommended_profile': self.recommended_profile,
            'profile_name': profile_names.get(self.active_profile, 'Personalizado'),
            'profile_badge': profile_badges.get(self.active_profile, 'Estándar'),
            'ai_available': self.ai_info['is_available'],
            'ai_acceleration': self.ai_info['acceleration'],
            'ai_device_name': self.ai_info['device_name'],
            'specs': {
                'os': f"{self.specs['os']} ({self.specs['architecture']})",
                'cpu_cores': self.specs['logical_cores'],
                'physical_cores': self.specs['physical_cores'],
                'ram_total_gb': self.specs['total_ram_gb'],
                'ram_free_gb': self.specs['free_ram_gb'],
                'ffmpeg_installed': self.specs['ffmpeg_available']
            },
            'capabilities': self.capabilities,
            'recommendation_text': self._get_recommendation_text()
        }

    def _get_recommendation_text(self) -> str:
        cores = self.specs['logical_cores']
        ram = self.specs['total_ram_gb']
        
        if self.active_profile == 'light':
            if not self.ai_info['is_available']:
                return (
                    "Este equipo opera como un NVR puro de grabación continua 24/7 y detección por movimiento con OpenCV. "
                    "Las librerías de IA no están instaladas, lo que permite un arranque inmediato y un consumo insignificante de procesador."
                )
            return (
                f"Equipo configurado en Modo Ligero ({cores} núcleos, {ram}GB RAM). "
                "La grabación 24/7 y la detección de movimiento OpenCV funcionan al 100%, mientras la IA se mantiene apagada para proteger el procesador."
            )
        elif self.active_profile == 'balanced':
            return (
                f"Equipo equilibrado ({cores} núcleos, {ram}GB RAM). "
                "La IA se activa de forma inteligente solo cuando se detecta movimiento previo, reduciendo el consumo de procesador hasta un 80%."
            )
        else:
            return (
                f"Equipo de alto rendimiento detectado ({cores} núcleos, {ram}GB RAM, aceleración {self.ai_info['acceleration'].upper()}). "
                "Todas las capacidades de IA neuronal continua, auto-tracking y grabación 24/7 están habilitadas al máximo."
            )

    def print_startup_banner(self):
        """Imprime un banner claro y profesional en la terminal al iniciar el sistema."""
        summary = self.get_summary()
        specs = summary['specs']
        border = "=" * 70

        print(border)
        print("  🛡️  SISTEMA CCTV MULTI-CÁMARA - AUTO-DIAGNÓSTICO DE HARDWARE")
        print(border)
        print(f"  💻 Equipo:          {specs['os']} | CPU: {specs['cpu_cores']} núcleos | RAM: {specs['ram_total_gb']} GB")
        print(f"  ⚡ Aceleración:      {summary['ai_device_name']}")
        print(f"  🎯 Modo Activo:      {summary['profile_name']}")
        print("  📋 Acceso y Capacidades en esta Computadora:")
        
        caps = summary['capabilities']
        for key, cap in caps.items():
            check = "✅" if cap['enabled'] else "⚠️" if cap['supported'] else "❌"
            print(f"     {check} {cap['label']}: {cap['status_badge']}")
        
        print("  💡 Diagnóstico:")
        print(f"     {summary['recommendation_text']}")
        print(border)
