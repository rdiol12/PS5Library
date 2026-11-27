"""Check the native storefront's package metadata contract."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from verify import verify_package_metadata


expected = "0x0200000000000000"
param = {
    "titleId": "PPSA99051",
    "contentId": "UP9000-PPSA99051_00-PS5LIBRARYHOMETE",
    "sdkVersion": expected,
    "requiredSystemSoftwareVersion": expected,
}
verify_package_metadata(param)

for field in ("sdkVersion", "requiredSystemSoftwareVersion"):
    invalid = dict(param)
    invalid[field] = "0x0000000000000000"
    try:
        verify_package_metadata(invalid)
    except AssertionError:
        continue
    raise AssertionError(f"zero {field} accepted")

print("Native package metadata checks passed")
