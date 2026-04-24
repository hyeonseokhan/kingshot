from __future__ import annotations

import io
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


class AdbError(RuntimeError):
    pass


@dataclass
class Device:
    adb_path: str
    serial: str

    def _run(self, args: list[str], capture_bytes: bool = False, timeout: float = 30.0):
        cmd = [self.adb_path, "-s", self.serial, *args]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            stderr = proc.stderr.decode("utf-8", errors="replace")
            raise AdbError(f"adb {' '.join(args)} failed: {stderr.strip()}")
        return proc.stdout if capture_bytes else proc.stdout.decode("utf-8", errors="replace")

    def shell(self, cmd: str) -> str:
        return self._run(["shell", cmd])

    def screencap(self) -> Image.Image:
        raw = self._run(["exec-out", "screencap", "-p"], capture_bytes=True)
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise AdbError(
                f"screencap returned non-PNG data ({len(raw)} bytes). "
                "On Windows this usually means CRLF mangling — retry via shell+pull."
            )
        return Image.open(io.BytesIO(raw)).convert("RGB")

    def tap(self, x: int, y: int) -> None:
        self.shell(f"input tap {x} {y}")

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 300) -> None:
        self.shell(f"input swipe {x1} {y1} {x2} {y2} {duration_ms}")

    def key(self, keycode: str) -> None:
        self.shell(f"input keyevent {keycode}")

    def back(self) -> None:
        self.key("KEYCODE_BACK")

    def foreground_package(self) -> str:
        out = self.shell("dumpsys window windows | grep -E 'mCurrentFocus'")
        return out.strip()

    def wm_size(self) -> tuple[int, int]:
        out = self.shell("wm size").strip()
        w, h = out.split(":")[-1].strip().split("x")
        return int(w), int(h)


def connect_from_config(cfg: dict) -> Device:
    dev = Device(adb_path=cfg["adb_path"], serial=cfg["device_serial"])
    devices_out = subprocess.run(
        [cfg["adb_path"], "devices"], capture_output=True, timeout=10
    ).stdout.decode("utf-8", errors="replace")
    if cfg["device_serial"] not in devices_out:
        raise AdbError(
            f"{cfg['device_serial']} not in adb devices output:\n{devices_out}"
        )
    return dev


def wait_after_tap(seconds: float = 0.5) -> None:
    time.sleep(seconds)
