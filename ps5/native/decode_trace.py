"""Print the valid tail of a PS5Library native diagnostic stage ring."""
import argparse
from pathlib import Path
import struct

MAGIC = 0x354C504E
FAULT_MAGIC = 0x544C4650
SALT = 0x71545350354C4942
RECORD = struct.Struct("<IiQQ")
FAULT_V1 = struct.Struct("<IIII")
FAULT_V2 = struct.Struct("<IIIIIIQQQQ")
FAULT_V3 = struct.Struct("<IIIIIIQQQQQQ")


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("trace", type=Path)
parser.add_argument("--fault", type=Path)
parser.add_argument("--tail", type=int, default=64)
args = parser.parse_args()
if args.tail < 1:
    parser.error("--tail must be positive")

data = args.trace.read_bytes()
if len(data) % RECORD.size:
    raise SystemExit("invalid trace size")
records = []
for offset in range(0, len(data), RECORD.size):
    magic, stage, sequence, checksum = RECORD.unpack_from(data, offset)
    if magic == MAGIC and checksum == SALT ^ ((stage & 0xFFFFFFFF) << 32) ^ sequence:
        records.append((sequence, stage))
records.sort()
print(f"valid={len(records)} showing={min(len(records), args.tail)}")
for sequence, stage in records[-args.tail:]:
    print(f"{sequence:016x} {stage}")

fault_path = args.fault or args.trace.with_name("ps5library-native-fault.bin")
if fault_path.is_file():
    fault = fault_path.read_bytes()
    if len(fault) == FAULT_V1.size:
        magic, signal, stage, pid = FAULT_V1.unpack(fault)
        detail = ""
    elif len(fault) == FAULT_V2.size:
        magic, signal, stage, pid, code, trap, rip, rax, address, handler = FAULT_V2.unpack(fault)
        detail = (f" code={code} trap={trap} rip=0x{rip:x} rax=0x{rax:x}"
                  f" address=0x{address:x} handler=0x{handler:x}")
    elif len(fault) == FAULT_V3.size:
        magic, signal, stage, pid, code, trap, rip, rax, address, handler, thread, main_thread = FAULT_V3.unpack(fault)
        detail = (f" code={code} trap={trap} rip=0x{rip:x} rax=0x{rax:x}"
                  f" address=0x{address:x} handler=0x{handler:x} thread=0x{thread:x}"
                  f" mainThread=0x{main_thread:x} role={'main' if thread == main_thread else 'worker'}")
    else:
        raise SystemExit("invalid fault size")
    if magic != FAULT_MAGIC:
        raise SystemExit("invalid fault magic")
    if stage & 0x80000000:
        stage -= 0x100000000
    print(f"fault signal={signal} stage={stage} pid={pid}{detail}")
else:
    print("fault=none")
