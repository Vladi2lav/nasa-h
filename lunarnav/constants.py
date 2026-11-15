from pathlib import Path

MOON_RADIUS_M = 1_737_400.0
MOON_RADIUS_KM = MOON_RADIUS_M / 1000.0
SUN_RADIUS_KM = 695_700.0
EARTH_RADIUS_KM = 6_378.137

MOON_FRAME = "MOON_ME"
ABCORR = "LT+S"

DEFAULT_OBSERVER_HEIGHT_M = 2.0

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data_raw"
WEB_DATA_DIR = ROOT / "web" / "data"
FIXTURE_DIR = ROOT / "tests" / "fixtures"
