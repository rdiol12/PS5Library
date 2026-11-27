# Synthetic archive fixture

`patches.json` contains owned BPS vectors made with an independent Python encoder and standard-library CRC32. They cover a generated ELF, all four BPS actions, overlapping/negative references, invalid forward references, output limits, corrupt output CRC and bounded module growth. No commercial patch payload or game library is bundled.

`homebrew.part1.rar` through `homebrew.part4.rar` contain a generated ELF that returns immediately, fabricated PS5Library metadata and 50,000 deterministic random bytes. They contain no game dump, keys or commercial content.

Created with RAR 7.20, RAR5 format, stored compression and 16,384-byte volumes. Used to check multipart discovery, missing volumes, streaming extraction and the real package builder. PS5 execution is not tested or intended.
