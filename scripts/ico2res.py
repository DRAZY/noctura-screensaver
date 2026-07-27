#!/usr/bin/env python3
"""Convert a .ico into a Win32 .res resource file (RT_ICON entries + one
RT_GROUP_ICON), so the icon can be linked into a PE without needing rc.exe or
llvm-rc anywhere in the toolchain — lld-link and MSVC link both accept .res
inputs directly. Regenerate whenever the icon changes:

    python3 scripts/ico2res.py src-tauri/icons/icon.ico windows-saver/icon.res
"""
import struct
import sys


def res_entry(rtype: int, name: int, data: bytes, memflags: int = 0x1030, lang: int = 0x0409) -> bytes:
    header = struct.pack(
        "<IIHHHHIHHII",
        len(data),  # DataSize
        32,         # HeaderSize (ordinal type + ordinal name)
        0xFFFF, rtype,   # TYPE as ordinal
        0xFFFF, name,    # NAME as ordinal
        0,          # DataVersion
        memflags,   # MemoryFlags
        lang,       # LanguageId
        0,          # Version
        0,          # Characteristics
    )
    pad = (-len(data)) % 4
    return header + data + b"\x00" * pad


def main() -> None:
    ico_path, res_path = sys.argv[1], sys.argv[2]
    ico = open(ico_path, "rb").read()
    reserved, ico_type, count = struct.unpack_from("<HHH", ico, 0)
    assert reserved == 0 and ico_type == 1, "not a .ico file"

    out = bytearray()
    # Mandatory empty preamble resource.
    out += struct.pack("<IIHHHHIHHII", 0, 32, 0xFFFF, 0, 0xFFFF, 0, 0, 0, 0, 0, 0)

    grp = struct.pack("<HHH", 0, 1, count)
    for i in range(count):
        off = 6 + 16 * i
        (w, h, colors, rsv, planes, bitcount, size, img_off) = struct.unpack_from("<BBBBHHII", ico, off)
        img = ico[img_off : img_off + size]
        rid = i + 1
        out += res_entry(3, rid, img)  # RT_ICON
        grp += struct.pack("<BBBBHHIH", w, h, colors, rsv, planes, bitcount, size, rid)
    out += res_entry(14, 1, grp)  # RT_GROUP_ICON, ordinal 1

    open(res_path, "wb").write(out)
    print(f"wrote {res_path}: {count} images, {len(out)} bytes")


if __name__ == "__main__":
    main()
