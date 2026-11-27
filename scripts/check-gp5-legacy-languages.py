"""Check that regenerating a legacy GP5 does not narrow its language mask."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import xml.etree.ElementTree as ET

generator = Path(sys.argv[1]) if len(sys.argv) > 1 else (
    Path(__file__).resolve().parents[1]
    / "data/toolkits/sdk-fpkg279-fix8-deltas/scripts/create-gp5-from-folder.py")
builder = generator.parent.parent / "build-from-folder.ps1"
spec = importlib.util.spec_from_file_location("gp5", generator)
gp5 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gp5)

with tempfile.TemporaryDirectory(prefix="gp5-languages-") as directory:
    root = Path(directory)
    source = root / "source"
    system = source / "sce_sys"
    system.mkdir(parents=True)
    (system / "param.json").write_text(json.dumps({
        "contentId": "UP9000-PPSA99783_00-OPENSTORYPS50000",
        "localizedParameters": {"defaultLanguage": "en-US"},
    }), encoding="utf-8")
    scenario = gp5.default_scenario("en-US")
    for name, value in (("explicit", scenario), ("legacy", {
        k: v for k, v in scenario.items()
        if k not in ("chunkDefaultLanguage", "chunkSupportedLanguages")
    }), ("new", None)):
        scenario_path = system / "playgo-scenario.json"
        if value is None:
            scenario_path.unlink()
        else:
            scenario_path.write_text(json.dumps(value), encoding="utf-8")
        output = root / f"{name}.gp5"
        gp5.build_gp5(source, output, "app", "0" * 32, True, set(), None)
        tree = ET.parse(output)
        chunks = tree.find(".//chunks")
        if name == "legacy":
            assert not chunks.attrib, "Legacy all-language chunks were narrowed"
            assert all("languages" not in c.attrib for c in chunks)
            assert not any(f.get("dst_path", "").startswith("playgo-languages/")
                           for f in tree.findall(".//file"))
        else:
            assert chunks.get("supported_languages") == "en-US"
            assert chunks.get("default_language") == "en-US"
            assert all(c.get("languages") == "en-US" for c in chunks)
print("PASS: legacy all-language and explicit/new English GP5 layouts are preserved.")
with tempfile.TemporaryDirectory(prefix="gp5-patch-inputs-") as directory:
    root = Path(directory)
    source = root / "source"
    system = source / "sce_sys"
    (system / "about").mkdir(parents=True)
    (source / "sce_module").mkdir()
    (system / "param.json").write_text(json.dumps({
        "contentId": "UP9000-PPSA99783_00-OPENSTORYPS50000",
        "sdkVersion": "0x0200000000000000",
        "localizedParameters": {"defaultLanguage": "en-US"},
    }), encoding="utf-8")
    (system / "keystone").write_bytes(bytes(0x60))
    (system / "about/right.sprx").write_bytes(b"RIGHT")
    (system / "nptitle.dat").write_bytes(b"TITLE-SPECIFIC")
    (source / "eboot.bin").write_bytes(b"PLAINTEXT-CONTAINER")
    output = root / "patch.gp5"
    gp5.build_gp5(source, output, "patch", "0" * 32, True, {
        "sce_sys/keystone",
    }, None)
    files = {entry.get("dst_path"): Path(entry.get("src_path"))
             for entry in ET.parse(output).findall(".//file")}
    assert "sce_sys/about/right.sprx" not in files
    assert "sce_sys/nptitle.dat" in files
    assert files["eboot.bin"] == source / "eboot.bin"
    generated_param = json.loads(files["sce_sys/param.json"].read_text())
    assert generated_param["sdkVersion"] == "0x0200000000000000"

print("PASS: title metadata is preserved and reserved About input is excluded.")
