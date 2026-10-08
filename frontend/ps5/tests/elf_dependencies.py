"""Check the actual PS5 ELF's loader prerequisites, including their order."""
import re
import subprocess
import sys

for filename in sys.argv[2:]:
    dynamic = subprocess.check_output([sys.argv[1], '-d', filename], text=True, timeout=15)
    needed = re.findall(r'\(NEEDED\).*\[([^]]+)\]', dynamic)
    assert needed, f'{filename}: no dynamic dependencies found'
    # SDK issue 26: AppInstUtil loading needs Ipmi already loaded, before main runs.
    if 'libSceAppInstUtil.sprx' in needed:
        assert ('libSceIpmi.sprx' in needed and
                needed.index('libSceIpmi.sprx') < needed.index('libSceAppInstUtil.sprx')), (
                    f'{filename}: libSceIpmi must precede libSceAppInstUtil in DT_NEEDED')
    print(f'{filename}: loader prerequisites PASS')
