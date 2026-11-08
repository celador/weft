"""Read-only Desktop backend. Reads the plugin's own snapshots; never polls the Weft gateway.
The host's authenticated /api/plugins/weft namespace protects this endpoint.
"""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from fastapi import APIRouter

_spec = spec_from_file_location("weft_snapshot_reader", Path(__file__).resolve().parents[1] / "status.py")
_reader = module_from_spec(_spec)
_spec.loader.exec_module(_reader)
router = APIRouter()


@router.get("/status")
def status():
    return {"agents": _reader.read_all()}
