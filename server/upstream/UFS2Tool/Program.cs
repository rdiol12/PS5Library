// Copyright (c) 2026, SvenGDK
// Licensed under the BSD 2-Clause License. See LICENSE file for details.

using System.Runtime.InteropServices;
using UFS2Tool;

namespace Ufs2Tool
{
    class Program
    {
        // Recognized single-character boolean flags for newfs (can be combined, e.g., -Ujt)
        private const string BooleanFlags = "EJNUjlnt";

        static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                PrintUsage();
                return 1;
            }

            try
            {
                return args[0].ToLower() switch
                {
                    "newfs" => HandleNewFs(args),
                    "makefs" => HandleMakeFs(args),
                    "tunefs" => HandleTuneFs(args),
                    "growfs" => HandleGrowFs(args),
                    "fsck_ufs" or "fsck_ffs" => HandleFsckUfs(args),
                    "info" => HandleInfo(args),
                    "ls" => HandleLs(args),
                    "extract" => HandleExtract(args),
                    "replace" => HandleReplace(args),
                    "add" => HandleAdd(args),
                    "delete" => HandleDelete(args),
                    "rename" => HandleRename(args),
                    "chmod" => HandleChmod(args),
                    "stat" => HandleStat(args),
                    "find" => HandleFind(args),
                    "du" => HandleDu(args),
                    "devinfo" => HandleDevInfo(args),
                    "mount_udf" => HandleMountUdf(args),
                    "umount_udf" => HandleUmountUdf(args),
                    _ => PrintUsageAndReturn()
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: {ex.Message}");
                if (ex.InnerException != null)
                    Console.Error.WriteLine($"  Detail: {ex.InnerException.Message}");
                return 1;
            }
        }

        /// <summary>
        /// Parse newfs arguments following FreeBSD newfs(8) conventions:
        ///   newfs [-EJNUjlnt] [-L volname] [-O filesystem-format] [-S sector-size]
        ///         [-a maxcontig] [-b block-size] [-c blocks-per-cylinder-group]
        ///         [-d max-extent-size] [-e maxbpg] [-f frag-size] [-g avgfilesize]
        ///         [-h avgfpdir] [-i bytes-per-inode] [-m free-space] [-o optimization]
        ///         [-p partition] [-s size] special
        ///
        /// Target can be:
        ///   - A file path:     myimage.img  (requires size-in-MB)
        ///   - A device path:   \\.\PhysicalDrive2  (size auto-detected)
        ///   - A volume path:   \\.\E:  (size auto-detected)
        /// </summary>
        static int HandleNewFs(string[] args)
        {
            var creator = new Ufs2ImageCreator();

            // Parse optional flags, collect positional args
            var positional = new List<string>();
            int i = 1;
            while (i < args.Length)
            {
                switch (args[i])
                {
                    // --- Flags with values ---
                    case "-O":
                        if (!TryParseIntArg(args, ref i, "filesystem format", out int format))
                            return 1;
                        creator.FilesystemFormat = format;
                        break;

                    case "-b":
                        if (!TryParseIntArg(args, ref i, "block size", out int blockSize))
                            return 1;
                        creator.BlockSize = blockSize;
                        break;

                    case "-f":
                        if (!TryParseIntArg(args, ref i, "fragment size", out int fragSize))
                            return 1;
                        creator.FragmentSize = fragSize;
                        break;

                    case "-S":
                        if (!TryParseIntArg(args, ref i, "sector size", out int sectorSize))
                            return 1;
                        creator.SectorSize = sectorSize;
                        break;

                    case "-L":
                        if (!TryParseStringArg(args, ref i, "volume name", out string? volName))
                            return 1;
                        creator.VolumeName = volName!;
                        break;

                    case "-a":
                        if (!TryParseIntArg(args, ref i, "maxcontig", out int maxContig))
                            return 1;
                        creator.MaxContig = maxContig;
                        break;

                    case "-c":
                        if (!TryParseIntArg(args, ref i, "blocks per cylinder group", out int bpcg))
                            return 1;
                        creator.BlocksPerCylGroup = bpcg;
                        break;

                    case "-d":
                        if (!TryParseIntArg(args, ref i, "max extent size", out int maxExtent))
                            return 1;
                        creator.MaxExtentSize = maxExtent;
                        break;

                    case "-e":
                        if (!TryParseIntArg(args, ref i, "maxbpg", out int maxBpg))
                            return 1;
                        creator.MaxBpg = maxBpg;
                        break;

                    case "-g":
                        if (!TryParseIntArg(args, ref i, "average file size", out int avgFile))
                            return 1;
                        creator.AvgFileSize = avgFile;
                        break;

                    case "-h":
                        if (!TryParseIntArg(args, ref i, "average files per directory", out int avgFpd))
                            return 1;
                        creator.AvgFilesPerDir = avgFpd;
                        break;

                    case "-i":
                        if (!TryParseIntArg(args, ref i, "bytes per inode", out int bpi))
                            return 1;
                        creator.BytesPerInode = bpi;
                        break;

                    case "-m":
                        if (!TryParseIntArg(args, ref i, "minimum free space %", out int minfree))
                            return 1;
                        creator.MinFreePercent = minfree;
                        break;

                    case "-o":
                        if (!TryParseStringArg(args, ref i, "optimization", out string? optim))
                            return 1;
                        if (optim != "time" && optim != "space")
                        {
                            Console.Error.WriteLine($"Error: -o must be 'time' or 'space'. Got: '{optim}'");
                            return 1;
                        }
                        creator.OptimizationPreference = optim!;
                        break;

                    case "-p":
                        if (!TryParseStringArg(args, ref i, "partition", out string? part))
                            return 1;
                        creator.Partition = part!;
                        break;

                    case "-D":
                        if (!TryParseStringArg(args, ref i, "input directory", out string? inputDir))
                            return 1;
                        creator.InputDirectory = inputDir!;
                        break;

                    case "-s":
                        if (!TryParseLongArg(args, ref i, "size", out long sizeVal))
                            return 1;
                        creator.SizeOverride = sizeVal;
                        break;

                    // --- Boolean flags ---
                    case "-E":
                        creator.EraseContents = true;
                        i++;
                        break;
                    case "-J":
                        creator.Gjournal = true;
                        i++;
                        break;
                    case "-N":
                        creator.DryRun = true;
                        i++;
                        break;
                    case "-U":
                        creator.SoftUpdates = true;
                        i++;
                        break;
                    case "-j":
                        creator.SoftUpdatesJournal = true;
                        i++;
                        break;
                    case "-l":
                        creator.MultilabelMac = true;
                        i++;
                        break;
                    case "-n":
                        creator.NoSnapDir = true;
                        i++;
                        break;
                    case "-t":
                        creator.TrimEnabled = true;
                        i++;
                        break;

                    default:
                        // Check for combined boolean flags (e.g., -EUjt)
                        if (args[i].StartsWith("-") && args[i].Length > 1 &&
                            IsBooleanFlagString(args[i]))
                        {
                            ParseCombinedFlags(creator, args[i]);
                            i++;
                        }
                        else
                        {
                            positional.Add(args[i]);
                            i++;
                        }
                        break;
                }
            }

            if (positional.Count < 1)
            {
                Console.Error.WriteLine("Error: Missing target (image path or device path).");
                PrintNewFsUsage();
                return 1;
            }

            string target = positional[0];
            bool isDevice = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                && DriveIO.IsDevicePath(target);

            // Volume name from positional arg (legacy compatibility)
            // With -D and no explicit size, positional layout is: <image-path> [volume-name]
            // Without -D, positional layout is: <image-path> <size-MB> [volume-name]
            if (string.IsNullOrEmpty(creator.VolumeName))
            {
                bool hasInputDir = !string.IsNullOrEmpty(creator.InputDirectory);
                int volIdx;
                if (isDevice)
                {
                    volIdx = 1;
                }
                else if (hasInputDir && (positional.Count < 2 || !long.TryParse(positional[1], out _)))
                {
                    // With -D and no numeric size arg, volume name is at index 1
                    volIdx = 1;
                }
                else
                {
                    volIdx = 2;
                }
                if (positional.Count > volIdx)
                    creator.VolumeName = positional[volIdx];
            }

            if (isDevice)
            {
                return HandleNewFsDevice(creator, target);
            }
            else
            {
                return HandleNewFsImage(creator, target, positional);
            }
        }

        /// <summary>
        /// Handle makefs command — replicates FreeBSD makefs(8) behavior exactly.
        ///
        /// Synopsis:
        ///   makefs [-DxZ] [-B endian] [-b free-blocks] [-d debug-mask]
        ///          [-F mtree-specfile] [-f free-files] [-M minimum-size]
        ///          [-m maximum-size] [-N userdb-dir] [-O offset] [-o fs-options]
        ///          [-R roundup-size] [-S sector-size] [-s image-size]
        ///          [-T timestamp] [-t fs-type] image-file directory
        ///
        /// Only -t ffs is supported (the default).
        /// FFS-specific -o options: version, bsize, fsize, label, softupdates,
        ///   density, minfree, optimization, avgfilesize, avgfpdir, maxbpg,
        ///   extent, maxbpcg
        /// </summary>
        static int HandleMakeFs(string[] args)
        {
            var creator = new Ufs2ImageCreator
            {
                // makefs defaults: version=1 (UFS1/FFS) per FreeBSD convention
                FilesystemFormat = 1
            };

            var positional = new List<string>();
            long imageSize = 0;
            long minimumSize = 0;
            long maximumSize = 0;
            long roundupSize = 0;
            string freeBlocksStr = "";
            string freeFilesStr = "";
            long makeFsTimestamp = -1;
            int i = 1;

            while (i < args.Length)
            {
                switch (args[i])
                {
                    case "-B":
                        // Byte order — accepted but UFS uses native little-endian
                        if (!TryParseStringArg(args, ref i, "endian", out _))
                            return 1;
                        break;

                    case "-b":
                        if (!TryParseStringArg(args, ref i, "free-blocks", out string? fbStr))
                            return 1;
                        freeBlocksStr = fbStr!;
                        break;

                    case "-d":
                        // Debug mask — accepted but not used
                        if (!TryParseStringArg(args, ref i, "debug-mask", out _))
                            return 1;
                        break;

                    case "-f":
                        if (!TryParseStringArg(args, ref i, "free-files", out string? ffStr))
                            return 1;
                        freeFilesStr = ffStr!;
                        break;

                    case "-M":
                        if (!TryParseStringArg(args, ref i, "minimum-size", out string? minStr))
                            return 1;
                        if (!TryParseMakeFsSize(minStr!, out minimumSize))
                        {
                            Console.Error.WriteLine($"Error: Invalid minimum size: '{minStr}'");
                            return 1;
                        }
                        break;

                    case "-m":
                        if (!TryParseStringArg(args, ref i, "maximum-size", out string? maxStr))
                            return 1;
                        if (!TryParseMakeFsSize(maxStr!, out maximumSize))
                        {
                            Console.Error.WriteLine($"Error: Invalid maximum size: '{maxStr}'");
                            return 1;
                        }
                        break;

                    case "-N":
                        // In FreeBSD makefs, -N is userdb-dir — accepted but not used
                        if (!TryParseStringArg(args, ref i, "userdb-dir", out _))
                            return 1;
                        break;

                    case "-o":
                        if (!TryParseStringArg(args, ref i, "fs-options", out string? fsOpts))
                            return 1;
                        if (!ParseFfsOptions(creator, fsOpts!))
                            return 1;
                        break;

                    case "-R":
                        if (!TryParseStringArg(args, ref i, "roundup-size", out string? roundupStr))
                            return 1;
                        if (!TryParseMakeFsSize(roundupStr!, out roundupSize))
                        {
                            Console.Error.WriteLine($"Error: Invalid roundup size: '{roundupStr}'");
                            return 1;
                        }
                        break;

                    case "-S":
                        if (!TryParseStringArg(args, ref i, "sector-size", out string? secStr))
                            return 1;
                        if (!TryParseMakeFsSize(secStr!, out long secSize))
                        {
                            Console.Error.WriteLine($"Error: Invalid sector size: '{secStr}'");
                            return 1;
                        }
                        creator.SectorSize = (int)secSize;
                        break;

                    case "-s":
                        if (!TryParseStringArg(args, ref i, "image-size", out string? imgSizeStr))
                            return 1;
                        if (!TryParseMakeFsSize(imgSizeStr!, out imageSize))
                        {
                            Console.Error.WriteLine($"Error: Invalid image size: '{imgSizeStr}'");
                            return 1;
                        }
                        break;

                    case "-T":
                        if (!TryParseStringArg(args, ref i, "timestamp", out string? tsStr))
                            return 1;
                        if (!long.TryParse(tsStr!, out makeFsTimestamp))
                        {
                            Console.Error.WriteLine($"Error: Invalid timestamp: '{tsStr}'. Expected seconds from epoch.");
                            return 1;
                        }
                        break;

                    case "-t":
                        if (!TryParseStringArg(args, ref i, "fs-type", out string? fsType))
                            return 1;
                        if (fsType != "ffs")
                        {
                            Console.Error.WriteLine($"Error: Only 'ffs' filesystem type is supported. Got: '{fsType}'");
                            return 1;
                        }
                        break;

                    case "-Z":
                    case "-p":
                    case "-D":
                    case "-x":
                        // Accepted flags (-Z/-p sparse, -D mtree duplicates, -x exclude)
                        i++;
                        break;

                    case "-F":
                    case "-O":
                        // Flags with values that are accepted but not used
                        if (!TryParseStringArg(args, ref i, args[i].TrimStart('-'), out _))
                            return 1;
                        break;

                    default:
                        positional.Add(args[i]);
                        i++;
                        break;
                }
            }

            if (positional.Count < 2)
            {
                Console.Error.WriteLine("Error: makefs requires an image path and a source directory.");
                PrintMakeFsUsage();
                return 1;
            }

            string imagePath = positional[0];
            string sourceDir = positional[1];

            if (!Directory.Exists(sourceDir))
            {
                Console.Error.WriteLine($"Error: Source directory not found: {sourceDir}");
                return 1;
            }

            // Parse free blocks: absolute count or percentage
            long freeBlocksAbs = 0;
            int freeBlocksPc = 0;
            if (!string.IsNullOrEmpty(freeBlocksStr))
            {
                if (freeBlocksStr.EndsWith('%'))
                {
                    if (!int.TryParse(freeBlocksStr[..^1], out freeBlocksPc))
                    {
                        Console.Error.WriteLine($"Error: Invalid free block percentage: '{freeBlocksStr}'");
                        return 1;
                    }
                }
                else
                {
                    if (!long.TryParse(freeBlocksStr, out freeBlocksAbs))
                    {
                        Console.Error.WriteLine($"Error: Invalid free blocks: '{freeBlocksStr}'");
                        return 1;
                    }
                }
            }

            // Parse free files: absolute count or percentage
            long freeFilesAbs = 0;
            int freeFilesPc = 0;
            if (!string.IsNullOrEmpty(freeFilesStr))
            {
                if (freeFilesStr.EndsWith('%'))
                {
                    if (!int.TryParse(freeFilesStr[..^1], out freeFilesPc))
                    {
                        Console.Error.WriteLine($"Error: Invalid free file percentage: '{freeFilesStr}'");
                        return 1;
                    }
                }
                else
                {
                    if (!long.TryParse(freeFilesStr, out freeFilesAbs))
                    {
                        Console.Error.WriteLine($"Error: Invalid free files: '{freeFilesStr}'");
                        return 1;
                    }
                }
            }

            creator.InputDirectory = sourceDir;

            string formatStr = (creator.FilesystemFormat == 1) ? "UFS1" : "UFS2";
            Console.WriteLine($"=== {formatStr} makefs — Image from Directory ===");
            Console.WriteLine();

            long totalSizeBytes = creator.MakeFsImage(imagePath, sourceDir,
                imageSize: imageSize,
                freeblocks: freeBlocksAbs, freeblockpc: freeBlocksPc,
                freefiles: freeFilesAbs, freefilepc: freeFilesPc,
                minimumSize: minimumSize, maximumSize: maximumSize,
                roundup: roundupSize, makeFsTimestamp: makeFsTimestamp);

            if (!creator.DryRun)
            {
                Console.WriteLine();
                Console.WriteLine("Image created successfully.");
                Console.WriteLine();

                using var image = new Ufs2Image(imagePath, readOnly: true);
                Console.WriteLine(image.GetInfo());
            }

            return 0;
        }

        /// <summary>
        /// Parse FFS-specific options from -o flag (comma-separated key=value pairs).
        /// Matches FreeBSD makefs(8) FFS-specific options.
        /// </summary>
        static bool ParseFfsOptions(Ufs2ImageCreator creator, string optionsStr)
        {
            foreach (string option in optionsStr.Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = option.Split('=', 2);
                string key = parts[0].Trim();
                string value = parts.Length > 1 ? parts[1].Trim() : "";

                switch (key)
                {
                    case "version":
                        if (!int.TryParse(value, out int ver) || (ver != 1 && ver != 2))
                        {
                            Console.Error.WriteLine($"Error: Invalid version: '{value}'. Must be 1 or 2.");
                            return false;
                        }
                        creator.FilesystemFormat = ver;
                        break;

                    case "bsize":
                        if (!int.TryParse(value, out int bsize))
                        {
                            Console.Error.WriteLine($"Error: Invalid bsize: '{value}'");
                            return false;
                        }
                        creator.BlockSize = bsize;
                        break;

                    case "fsize":
                        if (!int.TryParse(value, out int fsize))
                        {
                            Console.Error.WriteLine($"Error: Invalid fsize: '{value}'");
                            return false;
                        }
                        creator.FragmentSize = fsize;
                        break;

                    case "label":
                        creator.VolumeName = value;
                        break;

                    case "softupdates":
                        if (!int.TryParse(value, out int su) || (su != 0 && su != 1))
                        {
                            Console.Error.WriteLine($"Error: Invalid softupdates: '{value}'. Must be 0 or 1.");
                            return false;
                        }
                        creator.SoftUpdates = (su == 1);
                        break;

                    case "density":
                        if (!int.TryParse(value, out int density))
                        {
                            Console.Error.WriteLine($"Error: Invalid density: '{value}'");
                            return false;
                        }
                        creator.BytesPerInode = density;
                        break;

                    case "minfree":
                        if (!int.TryParse(value, out int minfree))
                        {
                            Console.Error.WriteLine($"Error: Invalid minfree: '{value}'");
                            return false;
                        }
                        creator.MinFreePercent = minfree;
                        break;

                    case "optimization":
                        if (value != "time" && value != "space")
                        {
                            Console.Error.WriteLine($"Error: Invalid optimization: '{value}'. Must be 'time' or 'space'.");
                            return false;
                        }
                        creator.OptimizationPreference = value;
                        break;

                    case "avgfilesize":
                        if (!int.TryParse(value, out int avgfs))
                        {
                            Console.Error.WriteLine($"Error: Invalid avgfilesize: '{value}'");
                            return false;
                        }
                        creator.AvgFileSize = avgfs;
                        break;

                    case "avgfpdir":
                        if (!int.TryParse(value, out int avgfpd))
                        {
                            Console.Error.WriteLine($"Error: Invalid avgfpdir: '{value}'");
                            return false;
                        }
                        creator.AvgFilesPerDir = avgfpd;
                        break;

                    case "maxbpg":
                        if (!int.TryParse(value, out int maxbpg))
                        {
                            Console.Error.WriteLine($"Error: Invalid maxbpg: '{value}'");
                            return false;
                        }
                        creator.MaxBpg = maxbpg;
                        break;

                    case "extent":
                        if (!int.TryParse(value, out int extent))
                        {
                            Console.Error.WriteLine($"Error: Invalid extent: '{value}'");
                            return false;
                        }
                        creator.MaxExtentSize = extent;
                        break;

                    case "maxbpcg":
                        if (!int.TryParse(value, out int maxbpcg))
                        {
                            Console.Error.WriteLine($"Error: Invalid maxbpcg: '{value}'");
                            return false;
                        }
                        creator.BlocksPerCylGroup = maxbpcg;
                        break;

                    default:
                        Console.Error.WriteLine($"Warning: Unknown FFS option: '{key}'");
                        break;
                }
            }
            return true;
        }

        /// <summary>
        /// Parse a size value following FreeBSD makefs(8) conventions:
        /// - Decimal number of bytes
        /// - Optional suffix: b (×512), k (×1024), m (×1048576), g (×1073741824), t (×1099511627776), w (×4)
        /// - Products separated by 'x': e.g., "512x1024"
        /// </summary>
        static bool TryParseMakeFsSize(string input, out long result)
        {
            result = 0;
            if (string.IsNullOrWhiteSpace(input))
                return false;

            // Handle product notation (e.g., "512x1024")
            string[] factors = input.Split('x', StringSplitOptions.RemoveEmptyEntries);
            if (factors.Length == 0)
                return false;
            long product = 1;

            foreach (string factor in factors)
            {
                string trimmed = factor.Trim();
                if (trimmed.Length == 0)
                    return false;

                long multiplier = 1;
                string numPart = trimmed;

                // Check for suffix
                char lastChar = char.ToLower(trimmed[^1]);
                if (char.IsLetter(lastChar))
                {
                    numPart = trimmed[..^1];
                    multiplier = lastChar switch
                    {
                        'b' => 512,
                        'k' => 1024,
                        'm' => 1024 * 1024,
                        'g' => 1024L * 1024 * 1024,
                        't' => 1024L * 1024 * 1024 * 1024,
                        'w' => 4,  // word = sizeof(int)
                        _ => -1
                    };
                    if (multiplier < 0)
                        return false;
                }

                if (!long.TryParse(numPart, out long val))
                    return false;

                try
                {
                    checked { product *= val * multiplier; }
                }
                catch (OverflowException)
                {
                    return false;
                }
            }

            result = product;
            return result > 0;
        }

        /// <summary>
        /// Check if a flag string contains only recognized boolean flag characters.
        /// </summary>
        static bool IsBooleanFlagString(string flag)
        {
            for (int i = 1; i < flag.Length; i++)
            {
                if (!BooleanFlags.Contains(flag[i]))
                    return false;
            }
            return true;
        }

        /// <summary>
        /// Parse combined single-character boolean flags (e.g., -EUjt).
        /// </summary>
        static void ParseCombinedFlags(Ufs2ImageCreator creator, string flags)
        {
            for (int i = 1; i < flags.Length; i++)
            {
                switch (flags[i])
                {
                    case 'E': creator.EraseContents = true; break;
                    case 'J': creator.Gjournal = true; break;
                    case 'N': creator.DryRun = true; break;
                    case 'U': creator.SoftUpdates = true; break;
                    case 'j': creator.SoftUpdatesJournal = true; break;
                    case 'l': creator.MultilabelMac = true; break;
                    case 'n': creator.NoSnapDir = true; break;
                    case 't': creator.TrimEnabled = true; break;
                }
            }
        }

        // --- Argument parsing helpers ---

        static bool TryParseIntArg(string[] args, ref int i, string name, out int value)
        {
            value = 0;
            if (i + 1 >= args.Length)
            {
                Console.Error.WriteLine($"Error: {args[i]} requires a {name} value.");
                return false;
            }
            if (!int.TryParse(args[i + 1], out value))
            {
                Console.Error.WriteLine($"Error: Invalid {name}: '{args[i + 1]}'");
                return false;
            }
            i += 2;
            return true;
        }

        static bool TryParseLongArg(string[] args, ref int i, string name, out long value)
        {
            value = 0;
            if (i + 1 >= args.Length)
            {
                Console.Error.WriteLine($"Error: {args[i]} requires a {name} value.");
                return false;
            }
            if (!long.TryParse(args[i + 1], out value))
            {
                Console.Error.WriteLine($"Error: Invalid {name}: '{args[i + 1]}'");
                return false;
            }
            i += 2;
            return true;
        }

        static bool TryParseStringArg(string[] args, ref int i, string name, out string? value)
        {
            value = null;
            if (i + 1 >= args.Length)
            {
                Console.Error.WriteLine($"Error: {args[i]} requires a {name} value.");
                return false;
            }
            value = args[i + 1];
            i += 2;
            return true;
        }

        // --- Command handlers ---

        static int HandleNewFsDevice(Ufs2ImageCreator creator, string devicePath)
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                Console.Error.WriteLine("Error: Device writing is only supported on Windows.");
                return 1;
            }

            string formatStr = (creator.FilesystemFormat == 1) ? "UFS1" : "UFS2";
            Console.WriteLine($"=== {formatStr} newfs — Device Mode ===");
            Console.WriteLine();
            Console.WriteLine($"  Target:         {devicePath}");
            Console.WriteLine($"  Block size:     {creator.BlockSize} bytes (-b)");
            Console.WriteLine($"  Fragment size:  {creator.FragmentSize} bytes (-f)");

            // Query device info
            long deviceSize = DriveIO.GetDeviceSize(devicePath);
            int sectorSize = DriveIO.GetSectorSize(devicePath);

            Console.WriteLine($"  Device size:    {deviceSize:N0} bytes ({deviceSize / (1024 * 1024)} MB)");
            Console.WriteLine($"  Sector size:    {sectorSize} bytes");
            if (!string.IsNullOrEmpty(creator.VolumeName))
                Console.WriteLine($"  Volume name:    {creator.VolumeName}");
            Console.WriteLine();

            if (creator.DryRun)
            {
                Console.WriteLine("Dry run (-N) — computing parameters only:");
                Console.WriteLine();
                creator.CreateOnDevice(devicePath);
                return 0;
            }

            // Safety confirmation
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("  WARNING: ALL DATA ON THIS DEVICE WILL BE DESTROYED!");
            Console.ResetColor();
            Console.Write("  Type 'yes' to continue: ");
            string? confirmation = Console.ReadLine()?.Trim();

            if (!string.Equals(confirmation, "yes", StringComparison.OrdinalIgnoreCase))
            {
                Console.WriteLine("  Aborted.");
                return 1;
            }

            Console.WriteLine();
            creator.CreateOnDevice(devicePath);

            Console.WriteLine();
            Console.WriteLine($"Done. The device now contains a {formatStr} filesystem.");
            Console.WriteLine("On FreeBSD, verify with: fsck_ffs /dev/<device>");

            return 0;
        }

        static int HandleNewFsImage(Ufs2ImageCreator creator, string imagePath,
            List<string> positional)
        {
            bool hasInputDir = !string.IsNullOrEmpty(creator.InputDirectory);

            if (positional.Count < 2 && creator.SizeOverride <= 0 && !hasInputDir)
            {
                Console.Error.WriteLine("Error: Image file target requires a size in MB (or use -s for size in sectors, or -D for auto-sizing).");
                Console.Error.WriteLine("  (Device targets auto-detect size. Did you mean a device path?)");
                PrintNewFsUsage();
                return 1;
            }

            // Validate input directory if specified
            if (hasInputDir && !Directory.Exists(creator.InputDirectory))
            {
                Console.Error.WriteLine($"Error: Input directory not found: {creator.InputDirectory}");
                return 1;
            }

            long sizeMb = 0;
            long totalSizeBytes = 0;

            if (creator.SizeOverride > 0)
            {
                totalSizeBytes = creator.SizeOverride * Ufs2Constants.DefaultSectorSize;
            }
            else if (positional.Count >= 2 && long.TryParse(positional[1], out sizeMb) && sizeMb > 0)
            {
                totalSizeBytes = sizeMb * 1024 * 1024;
            }
            else if (!hasInputDir)
            {
                Console.Error.WriteLine($"Error: Invalid size: '{positional[1]}'. Must be a positive integer (MB).");
                return 1;
            }

            // When -D is specified, use the unified CreateImageFromDirectory method that:
            // 1. Calculates required space from directory contents (when no explicit size)
            // 2. Creates an empty UFS2 filesystem
            // 3. Recursively adds all files and directories
            if (hasInputDir)
            {
                // Auto-size: let CreateImageFromDirectory calculate the size
                totalSizeBytes = creator.CreateImageFromDirectory(imagePath, creator.InputDirectory, totalSizeBytes);

                if (!creator.DryRun)
                {
                    Console.WriteLine();
                    Console.WriteLine("Image created successfully.");
                    Console.WriteLine();

                    using var image = new Ufs2Image(imagePath, readOnly: true);
                    Console.WriteLine(image.GetInfo());
                }

                return 0;
            }

            string formatStr = (creator.FilesystemFormat == 1) ? "UFS1" : "UFS2";
            Console.WriteLine($"=== {formatStr} newfs — Image File Mode ===");
            Console.WriteLine();
            Console.WriteLine($"  Target:         {imagePath}");
            Console.WriteLine($"  Size:           {totalSizeBytes / (1024 * 1024)} MB ({totalSizeBytes:N0} bytes)");
            Console.WriteLine($"  Block size:     {creator.BlockSize} bytes (-b)");
            Console.WriteLine($"  Fragment size:  {creator.FragmentSize} bytes (-f)");
            if (!string.IsNullOrEmpty(creator.VolumeName))
                Console.WriteLine($"  Volume name:    {creator.VolumeName}");
            Console.WriteLine();

            creator.CreateImage(imagePath, totalSizeBytes);

            if (!creator.DryRun)
            {
                Console.WriteLine("Image created successfully.");
                Console.WriteLine();

                using var image = new Ufs2Image(imagePath, readOnly: true);
                Console.WriteLine(image.GetInfo());
            }

            return 0;
        }

        /// <summary>
        /// Handle tunefs command — change layout parameters on an existing UFS filesystem.
        /// Replicates FreeBSD's tunefs(8) behavior.
        ///
        /// Synopsis:
        ///   tunefs [-A] [-a enable | disable] [-e maxbpg] [-f avgfilesize]
        ///          [-J enable | disable] [-j enable | disable] [-k metaspace]
        ///          [-L volname] [-l enable | disable] [-m minfree]
        ///          [-N enable | disable] [-n enable | disable]
        ///          [-o space | time] [-p] [-s avgfpdir] [-t enable | disable]
        ///          special
        /// </summary>
        static int HandleTuneFs(string[] args)
        {
            bool Aflag = false, aflag = false, eflag = false, fflag = false;
            bool jflag = false, Jflag = false, kflag = false, Lflag = false;
            bool lflag = false, mflag = false, Nflag = false, nflag = false;
            bool oflag = false, pflag = false, sflag = false, tflag = false;

            string? avalue = null, jvalue = null, Jvalue = null, Lvalue = null;
            string? lvalue = null, Nvalue = null, nvalue = null, tvalue = null;
            int evalue = 0, fvalue = 0, kvalue = 0, mvalue = 0, ovalue = 0, svalue = 0;

            int foundArg = 0;

            var positional = new List<string>();
            int i = 1;
            while (i < args.Length)
            {
                switch (args[i])
                {
                    case "-A":
                        foundArg++;
                        Aflag = true;
                        i++;
                        break;

                    case "-a":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "POSIX.1e ACLs", out avalue))
                            return 1;
                        if (avalue != "enable" && avalue != "disable")
                        {
                            Console.Error.WriteLine("Error: -a requires 'enable' or 'disable'.");
                            return 1;
                        }
                        aflag = true;
                        break;

                    case "-e":
                        if (!TryParseIntArg(args, ref i, "maximum blocks per file in a cylinder group", out evalue))
                            return 1;
                        if (evalue < 1)
                        {
                            Console.Error.WriteLine("Error: -e value must be >= 1.");
                            return 1;
                        }
                        foundArg++;
                        eflag = true;
                        break;

                    case "-f":
                        if (!TryParseIntArg(args, ref i, "average file size", out fvalue))
                            return 1;
                        if (fvalue < 1)
                        {
                            Console.Error.WriteLine("Error: -f value must be >= 1.");
                            return 1;
                        }
                        foundArg++;
                        fflag = true;
                        break;

                    case "-j":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "soft updates journaling", out jvalue))
                            return 1;
                        if (jvalue != "enable" && jvalue != "disable")
                        {
                            Console.Error.WriteLine("Error: -j requires 'enable' or 'disable'.");
                            return 1;
                        }
                        jflag = true;
                        break;

                    case "-J":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "gjournal", out Jvalue))
                            return 1;
                        if (Jvalue != "enable" && Jvalue != "disable")
                        {
                            Console.Error.WriteLine("Error: -J requires 'enable' or 'disable'.");
                            return 1;
                        }
                        Jflag = true;
                        break;

                    case "-k":
                        if (!TryParseIntArg(args, ref i, "space to hold for metadata blocks", out kvalue))
                            return 1;
                        if (kvalue < 0)
                        {
                            Console.Error.WriteLine("Error: -k value must be >= 0.");
                            return 1;
                        }
                        foundArg++;
                        kflag = true;
                        break;

                    case "-L":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "volume label", out Lvalue))
                            return 1;
                        // Validate: only alphanumerics, dashes, underscores
                        foreach (char c in Lvalue!)
                        {
                            if (!char.IsLetterOrDigit(c) && c != '_' && c != '-')
                            {
                                Console.Error.WriteLine("Error: Volume label may only contain alphanumerics, dashes, and underscores.");
                                return 1;
                            }
                        }
                        if (Lvalue.Length >= Ufs2Constants.MaxVolLen)
                        {
                            Console.Error.WriteLine($"Error: Volume label length must be < {Ufs2Constants.MaxVolLen}.");
                            return 1;
                        }
                        Lflag = true;
                        break;

                    case "-l":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "multilabel MAC", out lvalue))
                            return 1;
                        if (lvalue != "enable" && lvalue != "disable")
                        {
                            Console.Error.WriteLine("Error: -l requires 'enable' or 'disable'.");
                            return 1;
                        }
                        lflag = true;
                        break;

                    case "-m":
                        if (!TryParseIntArg(args, ref i, "minimum percentage of free space", out mvalue))
                            return 1;
                        if (mvalue < 0 || mvalue > 99)
                        {
                            Console.Error.WriteLine("Error: -m value must be between 0 and 99.");
                            return 1;
                        }
                        foundArg++;
                        mflag = true;
                        break;

                    case "-N":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "NFSv4 ACLs", out Nvalue))
                            return 1;
                        if (Nvalue != "enable" && Nvalue != "disable")
                        {
                            Console.Error.WriteLine("Error: -N requires 'enable' or 'disable'.");
                            return 1;
                        }
                        Nflag = true;
                        break;

                    case "-n":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "soft updates", out nvalue))
                            return 1;
                        if (nvalue != "enable" && nvalue != "disable")
                        {
                            Console.Error.WriteLine("Error: -n requires 'enable' or 'disable'.");
                            return 1;
                        }
                        nflag = true;
                        break;

                    case "-o":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "optimization preference", out string? optVal))
                            return 1;
                        if (optVal == "space")
                            ovalue = Ufs2Constants.FsOptSpace;
                        else if (optVal == "time")
                            ovalue = Ufs2Constants.FsOptTime;
                        else
                        {
                            Console.Error.WriteLine("Error: -o requires 'space' or 'time'.");
                            return 1;
                        }
                        oflag = true;
                        break;

                    case "-p":
                        foundArg++;
                        pflag = true;
                        i++;
                        break;

                    case "-s":
                        if (!TryParseIntArg(args, ref i, "expected number of files per directory", out svalue))
                            return 1;
                        if (svalue < 1)
                        {
                            Console.Error.WriteLine("Error: -s value must be >= 1.");
                            return 1;
                        }
                        foundArg++;
                        sflag = true;
                        break;

                    case "-t":
                        foundArg++;
                        if (!TryParseStringArg(args, ref i, "TRIM", out tvalue))
                            return 1;
                        if (tvalue != "enable" && tvalue != "disable")
                        {
                            Console.Error.WriteLine("Error: -t requires 'enable' or 'disable'.");
                            return 1;
                        }
                        tflag = true;
                        break;

                    default:
                        positional.Add(args[i]);
                        i++;
                        break;
                }
            }

            if (foundArg == 0 || positional.Count != 1)
            {
                PrintTuneFsUsage();
                return 1;
            }

            string target = positional[0];

            // Print mode: open read-only
            if (pflag)
            {
                using var image = new Ufs2Image(target, readOnly: true);
                PrintTuneFsValues(image.Superblock);
                return 0;
            }

            // Modification mode: open read-write
            using (var image = new Ufs2Image(target, readOnly: false))
            {
                var sb = image.Superblock;

                if (Lflag)
                {
                    Console.Error.WriteLine($"volume label changes from '{sb.VolumeName}' to '{Lvalue}'");
                    sb.VolumeName = Lvalue!;
                }
                if (aflag)
                {
                    string name = "POSIX.1e ACLs";
                    if (avalue == "enable")
                    {
                        if ((sb.Flags & Ufs2Constants.FsAcls) != 0)
                            Console.Error.WriteLine($"{name} remains unchanged as enabled");
                        else if ((sb.Flags & Ufs2Constants.FsNfs4Acls) != 0)
                            Console.Error.WriteLine($"{name} and NFSv4 ACLs are mutually exclusive");
                        else
                        {
                            sb.Flags |= Ufs2Constants.FsAcls;
                            Console.Error.WriteLine($"{name} set");
                        }
                    }
                    else
                    {
                        if ((sb.Flags & Ufs2Constants.FsAcls) == 0)
                            Console.Error.WriteLine($"{name} remains unchanged as disabled");
                        else
                        {
                            sb.Flags &= ~Ufs2Constants.FsAcls;
                            Console.Error.WriteLine($"{name} cleared");
                        }
                    }
                }
                if (eflag)
                {
                    string name = "maximum blocks per file in a cylinder group";
                    if (sb.MaxBpg == evalue)
                        Console.Error.WriteLine($"{name} remains unchanged as {evalue}");
                    else
                    {
                        Console.Error.WriteLine($"{name} changes from {sb.MaxBpg} to {evalue}");
                        sb.MaxBpg = evalue;
                    }
                }
                if (fflag)
                {
                    string name = "average file size";
                    if (sb.AvgFileSize == fvalue)
                        Console.Error.WriteLine($"{name} remains unchanged as {fvalue}");
                    else
                    {
                        Console.Error.WriteLine($"{name} changes from {sb.AvgFileSize} to {fvalue}");
                        sb.AvgFileSize = fvalue;
                    }
                }
                if (jflag)
                {
                    string name = "soft updates journaling";
                    if (jvalue == "enable")
                    {
                        if ((sb.Flags & (Ufs2Constants.FsDosoftdep | Ufs2Constants.FsSuj)) ==
                            (Ufs2Constants.FsDosoftdep | Ufs2Constants.FsSuj))
                            Console.Error.WriteLine($"{name} remains unchanged as enabled");
                        else
                        {
                            sb.Flags |= Ufs2Constants.FsDosoftdep | Ufs2Constants.FsSuj;
                            Console.Error.WriteLine($"{name} set");
                        }
                    }
                    else
                    {
                        if ((sb.Flags & Ufs2Constants.FsSuj) == 0)
                            Console.Error.WriteLine($"{name} remains unchanged as disabled");
                        else
                        {
                            sb.Flags &= ~Ufs2Constants.FsSuj;
                            Console.Error.WriteLine($"{name} cleared but soft updates still set.");
                        }
                    }
                }
                if (Jflag)
                {
                    string name = "gjournal";
                    if (Jvalue == "enable")
                    {
                        if ((sb.Flags & Ufs2Constants.FsGjournal) != 0)
                            Console.Error.WriteLine($"{name} remains unchanged as enabled");
                        else
                        {
                            sb.Flags |= Ufs2Constants.FsGjournal;
                            Console.Error.WriteLine($"{name} set");
                        }
                    }
                    else
                    {
                        if ((sb.Flags & Ufs2Constants.FsGjournal) == 0)
                            Console.Error.WriteLine($"{name} remains unchanged as disabled");
                        else
                        {
                            sb.Flags &= ~Ufs2Constants.FsGjournal;
                            Console.Error.WriteLine($"{name} cleared");
                        }
                    }
                }
                if (kflag)
                {
                    string name = "space to hold for metadata blocks";
                    if (sb.MetaSpace == kvalue)
                        Console.Error.WriteLine($"{name} remains unchanged as {kvalue}");
                    else
                    {
                        // Round down to block boundary
                        int blockAligned = (kvalue / sb.FragsPerBlock) * sb.FragsPerBlock;
                        if (blockAligned > sb.CylGroupSize / 2)
                        {
                            blockAligned = (sb.CylGroupSize / 2 / sb.FragsPerBlock) * sb.FragsPerBlock;
                            Console.Error.WriteLine($"{name} cannot exceed half the file system space");
                        }
                        Console.Error.WriteLine($"{name} changes from {sb.MetaSpace} to {blockAligned}");
                        sb.MetaSpace = blockAligned;
                    }
                }
                if (lflag)
                {
                    string name = "multilabel";
                    if (lvalue == "enable")
                    {
                        if ((sb.Flags & Ufs2Constants.FsMultilabel) != 0)
                            Console.Error.WriteLine($"{name} remains unchanged as enabled");
                        else
                        {
                            sb.Flags |= Ufs2Constants.FsMultilabel;
                            Console.Error.WriteLine($"{name} set");
                        }
                    }
                    else
                    {
                        if ((sb.Flags & Ufs2Constants.FsMultilabel) == 0)
                            Console.Error.WriteLine($"{name} remains unchanged as disabled");
                        else
                        {
                            sb.Flags &= ~Ufs2Constants.FsMultilabel;
                            Console.Error.WriteLine($"{name} cleared");
                        }
                    }
                }
                if (mflag)
                {
                    string name = "minimum percentage of free space";
                    if (sb.MinFreePercent == mvalue)
                        Console.Error.WriteLine($"{name} remains unchanged as {mvalue}%");
                    else
                    {
                        Console.Error.WriteLine($"{name} changes from {sb.MinFreePercent}% to {mvalue}%");
                        sb.MinFreePercent = mvalue;
                        if (mvalue >= 8 && sb.Optimization == Ufs2Constants.FsOptSpace)
                            Console.Error.WriteLine("should optimize for time with minfree >= 8%");
                        if (mvalue < 8 && sb.Optimization == Ufs2Constants.FsOptTime)
                            Console.Error.WriteLine("should optimize for space with minfree < 8%");
                    }
                }
                if (Nflag)
                {
                    string name = "NFSv4 ACLs";
                    if (Nvalue == "enable")
                    {
                        if ((sb.Flags & Ufs2Constants.FsNfs4Acls) != 0)
                            Console.Error.WriteLine($"{name} remains unchanged as enabled");
                        else if ((sb.Flags & Ufs2Constants.FsAcls) != 0)
                            Console.Error.WriteLine($"{name} and POSIX.1e ACLs are mutually exclusive");
                        else
                        {
                            sb.Flags |= Ufs2Constants.FsNfs4Acls;
                            Console.Error.WriteLine($"{name} set");
                        }
                    }
                    else
                    {
                        if ((sb.Flags & Ufs2Constants.FsNfs4Acls) == 0)
                            Console.Error.WriteLine($"{name} remains unchanged as disabled");
                        else
                        {
                            sb.Flags &= ~Ufs2Constants.FsNfs4Acls;
                            Console.Error.WriteLine($"{name} cleared");
                        }
                    }
                }
                if (nflag)
                {
                    string name = "soft updates";
                    if (nvalue == "enable")
                    {
                        if ((sb.Flags & Ufs2Constants.FsDosoftdep) != 0)
                            Console.Error.WriteLine($"{name} remains unchanged as enabled");
                        else
                        {
                            sb.Flags |= Ufs2Constants.FsDosoftdep;
                            Console.Error.WriteLine($"{name} set");
                        }
                    }
                    else
                    {
                        if ((sb.Flags & Ufs2Constants.FsDosoftdep) == 0)
                            Console.Error.WriteLine($"{name} remains unchanged as disabled");
                        else
                        {
                            sb.Flags &= ~Ufs2Constants.FsDosoftdep;
                            Console.Error.WriteLine($"{name} cleared");
                        }
                    }
                }
                if (oflag)
                {
                    string name = "optimization preference";
                    static string OptName(int v) => v == Ufs2Constants.FsOptTime ? "time" : v == Ufs2Constants.FsOptSpace ? "space" : $"unknown({v})";
                    if (sb.Optimization == ovalue)
                        Console.Error.WriteLine($"{name} remains unchanged as {OptName(ovalue)}");
                    else
                    {
                        Console.Error.WriteLine($"{name} changes from {OptName(sb.Optimization)} to {OptName(ovalue)}");
                        sb.Optimization = ovalue;
                        if (sb.MinFreePercent >= 8 && ovalue == Ufs2Constants.FsOptSpace)
                            Console.Error.WriteLine("should optimize for time with minfree >= 8%");
                        if (sb.MinFreePercent < 8 && ovalue == Ufs2Constants.FsOptTime)
                            Console.Error.WriteLine("should optimize for space with minfree < 8%");
                    }
                }
                if (sflag)
                {
                    string name = "expected number of files per directory";
                    if (sb.AvgFilesPerDir == svalue)
                        Console.Error.WriteLine($"{name} remains unchanged as {svalue}");
                    else
                    {
                        Console.Error.WriteLine($"{name} changes from {sb.AvgFilesPerDir} to {svalue}");
                        sb.AvgFilesPerDir = svalue;
                    }
                }
                if (tflag)
                {
                    string name = "issue TRIM to the disk";
                    if (tvalue == "enable")
                    {
                        if ((sb.Flags & Ufs2Constants.FsTrim) != 0)
                            Console.Error.WriteLine($"{name} remains unchanged as enabled");
                        else
                        {
                            sb.Flags |= Ufs2Constants.FsTrim;
                            Console.Error.WriteLine($"{name} set");
                        }
                    }
                    else
                    {
                        if ((sb.Flags & Ufs2Constants.FsTrim) == 0)
                            Console.Error.WriteLine($"{name} remains unchanged as disabled");
                        else
                        {
                            sb.Flags &= ~Ufs2Constants.FsTrim;
                            Console.Error.WriteLine($"{name} cleared");
                        }
                    }
                }

                // Write the modified superblock
                if (Aflag)
                    image.WriteSuperblockToAll();
                else
                    image.WriteSuperblock();
            }

            return 0;
        }

        /// <summary>
        /// Print current tuneable filesystem values, matching FreeBSD tunefs -p output.
        /// </summary>
        static void PrintTuneFsValues(Ufs2Superblock sb)
        {
            Console.Error.WriteLine($"POSIX.1e ACLs: (-a)                                {((sb.Flags & Ufs2Constants.FsAcls) != 0 ? "enabled" : "disabled")}");
            Console.Error.WriteLine($"NFSv4 ACLs: (-N)                                   {((sb.Flags & Ufs2Constants.FsNfs4Acls) != 0 ? "enabled" : "disabled")}");
            Console.Error.WriteLine($"MAC multilabel: (-l)                               {((sb.Flags & Ufs2Constants.FsMultilabel) != 0 ? "enabled" : "disabled")}");
            Console.Error.WriteLine($"soft updates: (-n)                                 {((sb.Flags & Ufs2Constants.FsDosoftdep) != 0 ? "enabled" : "disabled")}");
            Console.Error.WriteLine($"soft update journaling: (-j)                       {((sb.Flags & Ufs2Constants.FsSuj) != 0 ? "enabled" : "disabled")}");
            Console.Error.WriteLine($"gjournal: (-J)                                     {((sb.Flags & Ufs2Constants.FsGjournal) != 0 ? "enabled" : "disabled")}");
            Console.Error.WriteLine($"trim: (-t)                                         {((sb.Flags & Ufs2Constants.FsTrim) != 0 ? "enabled" : "disabled")}");
            Console.Error.WriteLine($"maximum blocks per file in a cylinder group: (-e)  {sb.MaxBpg}");
            Console.Error.WriteLine($"average file size: (-f)                            {sb.AvgFileSize}");
            Console.Error.WriteLine($"average number of files in a directory: (-s)       {sb.AvgFilesPerDir}");
            Console.Error.WriteLine($"minimum percentage of free space: (-m)             {sb.MinFreePercent}%");
            Console.Error.WriteLine($"space to hold for metadata blocks: (-k)            {sb.MetaSpace}");
            Console.Error.WriteLine($"optimization preference: (-o)                      {(sb.Optimization == Ufs2Constants.FsOptSpace ? "space" : "time")}");
            if (sb.MinFreePercent >= 8 && sb.Optimization == Ufs2Constants.FsOptSpace)
                Console.Error.WriteLine("should optimize for time with minfree >= 8%");
            if (sb.MinFreePercent < 8 && sb.Optimization == Ufs2Constants.FsOptTime)
                Console.Error.WriteLine("should optimize for space with minfree < 8%");
            Console.Error.WriteLine($"volume label: (-L)                                 {sb.VolumeName}");
        }

        /// <summary>
        /// Parse growfs arguments following FreeBSD growfs(8) conventions:
        ///   growfs [-Ny] [-s size] special
        ///
        /// Grows an existing UFS1/UFS2 filesystem image to a larger size.
        /// </summary>
        static int HandleGrowFs(string[] args)
        {
            bool Nflag = false;
            bool yflag = false;
            long sizeBytes = 0;

            var positional = new List<string>();
            int i = 1;
            while (i < args.Length)
            {
                switch (args[i])
                {
                    case "-N":
                        Nflag = true;
                        i++;
                        break;

                    case "-y":
                        yflag = true;
                        i++;
                        break;

                    case "-s":
                        if (!TryParseStringArg(args, ref i, "size", out string? sizeStr))
                            return 1;
                        if (!ParseGrowFsSize(sizeStr!, out sizeBytes))
                        {
                            Console.Error.WriteLine($"Error: Invalid size: '{sizeStr}'");
                            return 1;
                        }
                        break;

                    default:
                        positional.Add(args[i]);
                        i++;
                        break;
                }
            }

            if (positional.Count != 1)
            {
                PrintGrowFsUsage();
                return 1;
            }

            string target = positional[0];

            // Open read-only first to validate and get current size
            using var image = new Ufs2Image(target, readOnly: Nflag);
            var sb = image.Superblock;

            long currentSizeBytes = sb.TotalBlocks * sb.FSize;

            // Default: grow to image file size
            if (sizeBytes == 0)
            {
                var fileInfo = new FileInfo(target);
                sizeBytes = fileInfo.Length;
            }

            // Align to fragment boundary
            sizeBytes -= sizeBytes % sb.FSize;

            if (sizeBytes <= currentSizeBytes)
            {
                if (sizeBytes == currentSizeBytes)
                    Console.Error.WriteLine($"Error: Requested size ({FormatSize(sizeBytes)}) is equal to " +
                        $"the current filesystem size ({FormatSize(currentSizeBytes)}).");
                else
                    Console.Error.WriteLine($"Error: Requested size ({FormatSize(sizeBytes)}) is smaller than " +
                        $"the current filesystem size ({FormatSize(currentSizeBytes)}).");
                return 2;
            }

            if (!yflag && !Nflag)
            {
                Console.Write($"OK to grow filesystem on {target} " +
                    $"from {FormatSize(currentSizeBytes)} to {FormatSize(sizeBytes)}? [yes/no] ");
                Console.Out.Flush();
                string? reply = Console.ReadLine();
                if (!string.Equals(reply?.Trim(), "yes", StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine("Response other than \"yes\"; aborting");
                    return 0;
                }
            }

            image.GrowFs(sizeBytes, dryRun: Nflag);

            return 0;
        }

        /// <summary>
        /// Parse a size value with optional suffix for growfs, following FreeBSD conventions.
        /// Without suffix: value is in 512-byte sectors.
        /// Suffixes: b=bytes, k=kilobytes, m=megabytes, g=gigabytes, t=terabytes.
        /// </summary>
        static bool ParseGrowFsSize(string input, out long result)
        {
            result = 0;
            if (string.IsNullOrWhiteSpace(input))
                return false;

            // Handle product notation (e.g., "512x1024")
            string[] factors = input.Split('x', StringSplitOptions.RemoveEmptyEntries);
            if (factors.Length == 0)
                return false;
            long product = 1;

            foreach (string factor in factors)
            {
                string trimmed = factor.Trim();
                if (trimmed.Length == 0)
                    return false;

                long multiplier;
                string numPart;

                char lastChar = char.ToLower(trimmed[^1]);

                if (char.IsLetter(lastChar))
                {
                    numPart = trimmed[..^1];
                    multiplier = lastChar switch
                    {
                        'b' => 1,
                        'k' => 1024,
                        'm' => 1024 * 1024,
                        'g' => 1024L * 1024 * 1024,
                        't' => 1024L * 1024 * 1024 * 1024,
                        _ => -1
                    };
                    if (multiplier < 0)
                        return false;
                }
                else
                {
                    numPart = trimmed;
                    multiplier = factors.Length > 1 ? 1 : 512; // default: sectors only for single values
                }

                if (!long.TryParse(numPart, out long val) || val <= 0)
                    return false;

                try
                {
                    checked { product *= val * multiplier; }
                }
                catch (OverflowException)
                {
                    return false;
                }
            }

            result = product;
            return result > 0;
        }

        static string FormatSize(long bytes)
        {
            if (bytes >= 1024L * 1024 * 1024)
                return $"{bytes / (1024.0 * 1024 * 1024):F1}GB";
            if (bytes >= 1024L * 1024)
                return $"{bytes / (1024.0 * 1024):F1}MB";
            if (bytes >= 1024L)
                return $"{bytes / 1024.0:F1}KB";
            return $"{bytes}B";
        }

        static void PrintGrowFsUsage()
        {
            Console.Error.WriteLine("""
                Usage: ufs2tool growfs [-Ny] [-s size] special

                Expand an existing UFS1/UFS2 filesystem image.

                Options:
                  -N        Test mode. Print new parameters without modifying the filesystem.
                  -y        Assume yes to all prompts.
                  -s size   New filesystem size. Default unit is 512-byte sectors.
                            Suffixes: b (bytes), k (KB), m (MB), g (GB), t (TB).
                            Defaults to the image file size if not specified.
                """);
        }

        /// <summary>
        /// Handle the fsck_ufs / fsck_ffs command following FreeBSD fsck_ffs(8) conventions:
        ///   fsck_ufs [-dfnpy] [-b block] filesystem
        /// </summary>
        static int HandleFsckUfs(string[] args)
        {
            bool pflag = false;  // preen mode
            bool nflag = false;  // assume no (read-only)
            bool yflag = false;  // assume yes
            bool fflag = false;  // force check
            bool dflag = false;  // debug
            long altSuperblock = -1;

            var positional = new List<string>();
            int i = 1;
            while (i < args.Length)
            {
                switch (args[i])
                {
                    case "-p":
                        pflag = true;
                        i++;
                        break;

                    case "-n":
                        nflag = true;
                        i++;
                        break;

                    case "-y":
                        yflag = true;
                        i++;
                        break;

                    case "-f":
                        fflag = true;
                        i++;
                        break;

                    case "-d":
                        dflag = true;
                        i++;
                        break;

                    case "-b":
                        if (!TryParseLongArg(args, ref i, "alternate superblock", out altSuperblock))
                            return 1;
                        break;

                    default:
                        // Handle combined flags (e.g., -pf, -nyd)
                        if (args[i].StartsWith('-') && args[i].Length > 1)
                        {
                            bool allValid = true;
                            for (int c = 1; c < args[i].Length; c++)
                            {
                                if (args[i][c] != 'p' && args[i][c] != 'n' &&
                                    args[i][c] != 'y' && args[i][c] != 'f' &&
                                    args[i][c] != 'd')
                                {
                                    allValid = false;
                                    break;
                                }
                            }
                            if (allValid)
                            {
                                for (int c = 1; c < args[i].Length; c++)
                                {
                                    switch (args[i][c])
                                    {
                                        case 'p': pflag = true; break;
                                        case 'n': nflag = true; break;
                                        case 'y': yflag = true; break;
                                        case 'f': fflag = true; break;
                                        case 'd': dflag = true; break;
                                    }
                                }
                            }
                            else
                            {
                                positional.Add(args[i]);
                            }
                        }
                        else
                        {
                            positional.Add(args[i]);
                        }
                        i++;
                        break;
                }
            }

            if (positional.Count != 1)
            {
                PrintFsckUfsUsage();
                return 1;
            }

            string target = positional[0];

            // -n and -y are mutually exclusive
            if (nflag && yflag)
            {
                Console.Error.WriteLine("Error: -n and -y are mutually exclusive.");
                return 1;
            }

            // Open image — read-only when -n is specified.
            // -b altsuperblock: read SB from the given 512-byte sector instead of
            // the primary location (matches FreeBSD fsck_ffs(8) -b behavior).
            bool readOnly = nflag;
            using var image = altSuperblock >= 0
                ? new Ufs2Image(target, readOnly: readOnly, altSuperblockSector: altSuperblock)
                : new Ufs2Image(target, readOnly: readOnly);

            if (altSuperblock >= 0)
                Console.WriteLine($"Using alternate super-block at sector {altSuperblock}");

            // Check clean flag — skip if filesystem is clean (unless -f)
            var sb = image.Superblock;
            bool isClean = (sb.Flags & Ufs2Constants.FsUnclean) == 0 &&
                           (sb.Flags & Ufs2Constants.FsNeedsfsck) == 0;

            if (isClean && !fflag && (pflag || (!yflag && !nflag)))
            {
                Console.WriteLine($"** {target} is clean");
                return 0;
            }

            // Run the filesystem check
            var result = image.FsckUfs(preen: pflag, debug: dflag);

            // Print messages
            foreach (var msg in result.Messages)
                Console.WriteLine(msg);

            // Print warnings
            foreach (var warn in result.Warnings)
                Console.Error.WriteLine(warn);

            // Print errors
            foreach (var err in result.Errors)
                Console.Error.WriteLine(err);

            // Determine exit code per FreeBSD fsck_ffs(8) convention:
            //   0 = file system is clean (or check completed without unrecoverable errors)
            //   8 = unrecoverable error (corrupt superblock, etc.)
            // Repair (FSCK_REBOOT, exit 4) is not implemented — we only consistency-check.
            if (result.Errors.Count > 0)
                return 8;
            return 0;
        }

        static void PrintFsckUfsUsage()
        {
            Console.Error.WriteLine("""
                Usage: ufs2tool fsck_ufs [-dfnpy] [-b block] filesystem

                File system consistency check and interactive repair.
                (FreeBSD fsck_ffs(8)/fsck_ufs(8) compatible)

                Options:
                  -b block  Use the specified block number as the superblock for the filesystem.
                            An alternate super block is usually located at block 32 for UFS1,
                            and block 192 for UFS2.
                  -d        Enable debugging messages.
                  -f        Force fsck_ufs to check 'clean' file systems when preening.
                  -n        Assume a no response to all questions; do not open for writing.
                  -p        Preen file systems: only fix safe inconsistencies.
                  -y        Assume a yes response to all questions.
                """);
        }

        static int HandleInfo(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("Usage: ufs2tool info <image-path>");
                return 1;
            }

            using var image = new Ufs2Image(args[1], readOnly: true);
            Console.WriteLine(image.GetInfo());
            return 0;
        }

        static int HandleLs(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("Usage: ufs2tool ls <image-path> [path]");
                return 1;
            }

            using var image = new Ufs2Image(args[1], readOnly: true);
            string fsPath = args.Length > 2 ? args[2] : "/";
            uint dirInode = image.ResolvePath(fsPath);
            var entries = image.ListDirectory(dirInode);

            Console.WriteLine($"Directory '{fsPath}' ({entries.Count} entries):");
            foreach (var entry in entries)
            {
                string typeStr = entry.FileType switch
                {
                    Ufs2Constants.DtDir => "DIR ",
                    Ufs2Constants.DtReg => "FILE",
                    Ufs2Constants.DtLnk => "LINK",
                    _ => "??? "
                };
                Console.WriteLine($"  {typeStr}  inode={entry.Inode,6}  {entry.Name}");
            }
            return 0;
        }

        /// <summary>
        /// Display detailed file/directory/symlink information from a UFS1/UFS2 filesystem image.
        ///
        /// Synopsis:
        ///   stat <image-path> <fs-path>
        /// </summary>
        static int HandleStat(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("Usage: ufs2tool stat <image-path> <fs-path>");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Show detailed file information:");
                Console.Error.WriteLine("    ufs2tool stat myimage.img /path/to/file.txt");
                Console.Error.WriteLine("    ufs2tool stat myimage.img /path/to/dir");
                Console.Error.WriteLine("    ufs2tool stat myimage.img /");
                return 1;
            }

            using var image = new Ufs2Image(args[1], readOnly: true);
            Console.WriteLine(image.GetStat(args[2]));
            return 0;
        }

        /// <summary>
        /// Search for files matching a name pattern in a UFS1/UFS2 filesystem image.
        ///
        /// Synopsis:
        ///   find <image-path> <name-pattern> [-type f|d|l] [-path start-path]
        ///
        /// Recursively searches the filesystem for entries whose name matches
        /// the given glob pattern (supporting * and ? wildcards).
        /// </summary>
        static int HandleFind(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("Usage: ufs2tool find <image-path> <name-pattern> [-type f|d|l] [-path start-path]");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Search for files by name pattern:");
                Console.Error.WriteLine("    ufs2tool find myimage.img \"*.txt\"");
                Console.Error.WriteLine("    ufs2tool find myimage.img \"game*\" -type f");
                Console.Error.WriteLine("    ufs2tool find myimage.img \"*\" -type d");
                Console.Error.WriteLine("    ufs2tool find myimage.img \"*.cfg\" -path /etc");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Pattern wildcards:");
                Console.Error.WriteLine("    *    matches any sequence of characters");
                Console.Error.WriteLine("    ?    matches any single character");
                return 1;
            }

            string imagePath = args[1];
            string namePattern = args[2];
            string? typeFilter = null;
            string startPath = "/";

            // Parse optional flags
            int i = 3;
            while (i < args.Length)
            {
                switch (args[i])
                {
                    case "-type":
                        if (i + 1 >= args.Length)
                        {
                            Console.Error.WriteLine("Error: -type requires a value (f, d, or l).");
                            return 1;
                        }
                        typeFilter = args[++i];
                        if (typeFilter != "f" && typeFilter != "d" && typeFilter != "l")
                        {
                            Console.Error.WriteLine($"Error: Invalid type filter '{typeFilter}'. Use 'f' (file), 'd' (directory), or 'l' (symlink).");
                            return 1;
                        }
                        break;

                    case "-path":
                        if (i + 1 >= args.Length)
                        {
                            Console.Error.WriteLine("Error: -path requires a value.");
                            return 1;
                        }
                        startPath = args[++i];
                        break;

                    default:
                        Console.Error.WriteLine($"Error: Unknown option '{args[i]}'.");
                        return 1;
                }
                i++;
            }

            using var image = new Ufs2Image(imagePath, readOnly: true);
            var results = image.Find(namePattern, startPath, typeFilter);

            if (results.Count == 0)
            {
                Console.WriteLine("No matches found.");
                return 0;
            }

            foreach (var result in results)
            {
                string typeStr = result.FileType switch
                {
                    Ufs2Constants.DtDir => "DIR ",
                    Ufs2Constants.DtReg => "FILE",
                    Ufs2Constants.DtLnk => "LINK",
                    _ => "??? "
                };
                Console.WriteLine($"  {typeStr}  {result.Size,10}  {result.Path}");
            }

            Console.WriteLine($"\n{results.Count} match(es) found.");
            return 0;
        }

        /// <summary>
        /// Display disk usage for files and directories in a UFS1/UFS2 filesystem image,
        /// similar to FreeBSD du(1).
        ///
        /// Synopsis:
        ///   du [-h] [-s] [-d depth] <image-path> [fs-path]
        ///
        /// Options:
        ///   -h           Human-readable sizes (e.g., 1K, 234M, 2G)
        ///   -s           Summary only (total for the specified path)
        ///   -d depth     Maximum directory depth to report
        /// </summary>
        static int HandleDu(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("Usage: ufs2tool du [-h] [-s] [-d depth] <image-path> [fs-path]");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Show disk usage for the entire filesystem:");
                Console.Error.WriteLine("    ufs2tool du myimage.img");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Show disk usage with human-readable sizes:");
                Console.Error.WriteLine("    ufs2tool du -h myimage.img");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Show summary only:");
                Console.Error.WriteLine("    ufs2tool du -s myimage.img");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Show disk usage for a specific directory:");
                Console.Error.WriteLine("    ufs2tool du myimage.img /subdir");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Limit depth:");
                Console.Error.WriteLine("    ufs2tool du -d 1 myimage.img");
                Console.Error.WriteLine();
                Console.Error.WriteLine("Options:");
                Console.Error.WriteLine("  -h           Human-readable sizes (e.g., 1K, 234M, 2G)");
                Console.Error.WriteLine("  -s           Summary only (total for specified path)");
                Console.Error.WriteLine("  -d depth     Maximum directory depth to report");
                return 1;
            }

            bool humanReadable = false;
            bool summaryOnly = false;
            int maxDepth = -1;
            var positional = new List<string>();

            int i = 1;
            while (i < args.Length)
            {
                switch (args[i])
                {
                    case "-h":
                        humanReadable = true;
                        break;
                    case "-s":
                        summaryOnly = true;
                        break;
                    case "-d":
                        if (i + 1 >= args.Length)
                        {
                            Console.Error.WriteLine("Error: -d requires a depth value.");
                            return 1;
                        }
                        if (!int.TryParse(args[++i], out maxDepth) || maxDepth < 0)
                        {
                            Console.Error.WriteLine($"Error: Invalid depth value '{args[i]}'.");
                            return 1;
                        }
                        break;
                    default:
                        positional.Add(args[i]);
                        break;
                }
                i++;
            }

            if (positional.Count < 1)
            {
                Console.Error.WriteLine("Error: Image path is required.");
                return 1;
            }

            string imagePath = positional[0];
            string fsPath = positional.Count > 1 ? positional[1] : "/";

            using var image = new Ufs2Image(imagePath, readOnly: true);
            var entries = image.DiskUsage(fsPath, maxDepth, summaryOnly);

            foreach (var entry in entries)
            {
                string sizeStr = humanReadable
                    ? FormatHumanReadable(entry.Blocks * 512)
                    : entry.Blocks.ToString();
                Console.WriteLine($"{sizeStr,10}\t{entry.Path}");
            }

            return 0;
        }

        /// <summary>
        /// Format a byte count as a human-readable string (e.g., "1.5K", "234M", "2.1G").
        /// </summary>
        private static string FormatHumanReadable(long bytes)
        {
            if (bytes < 1024) return $"{bytes}B";
            double value = bytes;
            string[] units = ["K", "M", "G", "T"];
            int unitIndex = -1;
            while (value >= 1024 && unitIndex < units.Length - 1)
            {
                value /= 1024;
                unitIndex++;
            }
            return value >= 10 ? $"{value:F0}{units[unitIndex]}" : $"{value:F1}{units[unitIndex]}";
        }

        /// <summary>
        /// Extract files from a UFS1/UFS2 filesystem image.
        ///
        /// Synopsis:
        ///   extract <image-path> <output-directory> [fs-path]
        ///
        /// If fs-path is omitted, extracts the entire filesystem.
        /// If fs-path is a directory, extracts it recursively.
        /// If fs-path is a file, extracts that single file.
        /// </summary>
        static int HandleExtract(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("Usage: ufs2tool extract <image-path> <output-directory> [fs-path]");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Extract entire filesystem:");
                Console.Error.WriteLine("    ufs2tool extract myimage.img ./output");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Extract a specific file or folder:");
                Console.Error.WriteLine("    ufs2tool extract myimage.img ./output /path/to/file_or_dir");
                return 1;
            }

            string imagePath = args[1];
            string outputDir = args[2];
            string fsPath = args.Length > 3 ? args[3] : "/";

            using var image = new Ufs2Image(imagePath, readOnly: true);

            image.Extract(fsPath, outputDir);

            Console.WriteLine($"Extracted '{fsPath}' to '{outputDir}'.");
            return 0;
        }

        /// <summary>
        /// Replace a file or directory in a UFS1/UFS2 filesystem image.
        /// If the target is a file, its content is replaced with the source file.
        /// If the target is a directory, matching files in the source directory
        /// replace their counterparts in the target directory recursively.
        /// </summary>
        static int HandleReplace(string[] args)
        {
            if (args.Length < 4)
            {
                Console.Error.WriteLine("Usage: ufs2tool replace <image-path> <fs-path> <source-path>");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Replace a single file:");
                Console.Error.WriteLine("    ufs2tool replace myimage.img /path/to/file.txt ./local/file.txt");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Replace matching files in a directory:");
                Console.Error.WriteLine("    ufs2tool replace myimage.img /path/to/dir ./local/dir");
                return 1;
            }

            string imagePath = args[1];
            string fsPath = args[2];
            string sourcePath = args[3];

            using var image = new Ufs2Image(imagePath, readOnly: false);

            image.Replace(fsPath, sourcePath);

            Console.WriteLine($"Replaced '{fsPath}' from '{sourcePath}'.");
            return 0;
        }

        /// <summary>
        /// Add a file or directory to a UFS1/UFS2 filesystem image.
        /// If the source is a file, it is added at the specified path.
        /// If the source is a directory, it is added recursively.
        /// </summary>
        static int HandleAdd(string[] args)
        {
            if (args.Length < 4)
            {
                Console.Error.WriteLine("Usage: ufs2tool add <image-path> <fs-path> <source-path>");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Add a single file:");
                Console.Error.WriteLine("    ufs2tool add myimage.img /path/to/file.txt ./local/file.txt");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Add a directory recursively:");
                Console.Error.WriteLine("    ufs2tool add myimage.img /path/to/newdir ./local/dir");
                return 1;
            }

            string imagePath = args[1];
            string fsPath = args[2];
            string sourcePath = args[3];

            using var image = new Ufs2Image(imagePath, readOnly: false);

            image.Add(fsPath, sourcePath);

            Console.WriteLine($"Added '{sourcePath}' to '{fsPath}'.");
            return 0;
        }

        /// <summary>
        /// Delete a file or directory from a UFS1/UFS2 filesystem image.
        /// If the target is a directory, all contents are deleted recursively.
        /// </summary>
        static int HandleDelete(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("Usage: ufs2tool delete <image-path> <fs-path>");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Delete a single file:");
                Console.Error.WriteLine("    ufs2tool delete myimage.img /path/to/file.txt");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Delete a directory recursively:");
                Console.Error.WriteLine("    ufs2tool delete myimage.img /path/to/dir");
                return 1;
            }

            string imagePath = args[1];
            string fsPath = args[2];

            using var image = new Ufs2Image(imagePath, readOnly: false);

            image.Delete(fsPath);

            Console.WriteLine($"Deleted '{fsPath}'.");
            return 0;
        }

        /// <summary>
        /// Rename a file or directory inside a UFS1/UFS2 filesystem image.
        /// </summary>
        static int HandleRename(string[] args)
        {
            if (args.Length < 4)
            {
                Console.Error.WriteLine("Usage: ufs2tool rename <image-path> <fs-path> <new-name>");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Rename a file:");
                Console.Error.WriteLine("    ufs2tool rename myimage.img /path/to/old.txt newname.txt");
                Console.Error.WriteLine();
                Console.Error.WriteLine("  Rename a directory:");
                Console.Error.WriteLine("    ufs2tool rename myimage.img /path/to/olddir newdir");
                return 1;
            }

            string imagePath = args[1];
            string fsPath = args[2];
            string newName = args[3];

            using var image = new Ufs2Image(imagePath, readOnly: false);

            image.Rename(fsPath, newName);

            Console.WriteLine($"Renamed '{fsPath}' to '{newName}'.");
            return 0;
        }

        /// <summary>
        /// Change permissions (mode) of a file or directory in a UFS1/UFS2 filesystem image.
        ///
        /// Synopsis:
        ///   chmod [-R] &lt;image-path&gt; &lt;mode&gt; [fs-path]
        ///
        /// Where:
        ///   mode    = Octal permission mode (e.g., 755, 644)
        ///   fs-path = Path in the filesystem (omit or use "/" with -R for entire image)
        ///   -R      = Apply recursively to entire image using mode for files and
        ///             mode+execute for directories (e.g., 644 files → 755 dirs)
        /// </summary>
        static int HandleChmod(string[] args)
        {
            bool recursive = false;
            var positional = new List<string>();

            int i = 1;
            while (i < args.Length)
            {
                if (args[i] == "-R")
                {
                    recursive = true;
                }
                else if (args[i] == "--help")
                {
                    PrintChmodUsage();
                    return 0;
                }
                else
                {
                    positional.Add(args[i]);
                }
                i++;
            }

            if (recursive)
            {
                // chmod -R <image-path> <file-mode> [dir-mode]
                if (positional.Count < 2)
                {
                    PrintChmodUsage();
                    return 1;
                }

                string imagePath = positional[0];
                if (!TryParseOctalMode(positional[1], out ushort fileMode))
                {
                    Console.Error.WriteLine($"Error: Invalid octal mode '{positional[1]}'.");
                    return 1;
                }

                ushort dirMode;
                if (positional.Count >= 3)
                {
                    if (!TryParseOctalMode(positional[2], out dirMode))
                    {
                        Console.Error.WriteLine($"Error: Invalid octal directory mode '{positional[2]}'.");
                        return 1;
                    }
                }
                else
                {
                    // Default: add execute bit to directories if set for user/group/other read
                    dirMode = AddExecuteBits(fileMode);
                }

                using var image = new Ufs2Image(imagePath, readOnly: false);
                image.ChmodAll(fileMode, dirMode);

                Console.WriteLine($"Changed permissions: files=0{Convert.ToString(fileMode, 8)}, dirs=0{Convert.ToString(dirMode, 8)} (entire image).");
                return 0;
            }
            else
            {
                // chmod <image-path> <mode> <fs-path>
                if (positional.Count < 3)
                {
                    PrintChmodUsage();
                    return 1;
                }

                string imagePath = positional[0];
                if (!TryParseOctalMode(positional[1], out ushort mode))
                {
                    Console.Error.WriteLine($"Error: Invalid octal mode '{positional[1]}'.");
                    return 1;
                }
                string fsPath = positional[2];

                using var image = new Ufs2Image(imagePath, readOnly: false);
                image.Chmod(fsPath, mode);

                Console.WriteLine($"Changed permissions of '{fsPath}' to 0{Convert.ToString(mode, 8)}.");
                return 0;
            }
        }

        /// <summary>
        /// Parse an octal mode string (e.g., "755", "0644") into a ushort.
        /// </summary>
        static bool TryParseOctalMode(string modeStr, out ushort mode)
        {
            mode = 0;
            try
            {
                int value = Convert.ToInt32(modeStr, 8);
                if (value < 0 || value > 0x0FFF) // Max permission bits (4095)
                    return false;
                mode = (ushort)value;
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Add execute bits to a file mode for directory use.
        /// If any read bit is set, the corresponding execute bit is added.
        /// E.g., 0644 → 0755 (user read+write → +exec, group/other read → +exec)
        /// </summary>
        static ushort AddExecuteBits(ushort fileMode)
        {
            ushort dirMode = fileMode;
            // If user has read (0400), add user execute (0100)
            if ((dirMode & 0x100) != 0) dirMode |= 0x040;
            // If group has read (0040), add group execute (0010)
            if ((dirMode & 0x020) != 0) dirMode |= 0x008;
            // If other has read (0004), add other execute (0001)
            if ((dirMode & 0x004) != 0) dirMode |= 0x001;
            return dirMode;
        }

        static void PrintChmodUsage()
        {
            Console.Error.WriteLine("""
                Usage: ufs2tool chmod [-R] <image-path> <mode> [fs-path | dir-mode]

                  Change permissions of a file or directory:
                    ufs2tool chmod myimage.img 755 /path/to/file_or_dir

                  Change permissions of the entire image recursively:
                    ufs2tool chmod -R myimage.img 644
                    (Files get 0644, directories get 0755 automatically)

                  Specify separate file and directory modes:
                    ufs2tool chmod -R myimage.img 644 755

                  mode     Octal permission mode (e.g., 755, 644, 0777)
                  fs-path  Path to file or directory in the filesystem
                  -R       Apply recursively to entire image
                """);
        }

        /// <summary>
        /// Show information about a device (for debugging / verification).
        /// </summary>
        static int HandleDevInfo(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("Usage: ufs2tool devinfo <device-path>");
                Console.Error.WriteLine(@"  Example: ufs2tool devinfo \\.\PhysicalDrive2");
                return 1;
            }

            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                Console.Error.WriteLine("Error: Device info is only supported on Windows.");
                return 1;
            }

            string devicePath = args[1];

            if (!DriveIO.IsDevicePath(devicePath))
            {
                Console.Error.WriteLine($"Error: '{devicePath}' is not a recognized device path.");
                return 1;
            }

            long size = DriveIO.GetDeviceSize(devicePath);
            int sector = DriveIO.GetSectorSize(devicePath);

            Console.WriteLine($"Device:      {devicePath}");
            Console.WriteLine($"Size:        {size:N0} bytes");
            Console.WriteLine($"             {size / 1024.0 / 1024.0:F2} MB");
            Console.WriteLine($"             {size / 1024.0 / 1024.0 / 1024.0:F2} GB");
            Console.WriteLine($"Sector size: {sector} bytes");
            Console.WriteLine($"Sectors:     {size / sector:N0}");

            return 0;
        }

        /// <summary>
        /// Mount a UFS1/UFS2 filesystem image as a Windows drive letter using Dokan.
        /// Modeled after FreeBSD mount_udf(8) / mount(8).
        ///
        /// Synopsis:
        ///   mount_udf [-o ro] [-v] special node
        ///
        /// Where:
        ///   special = path to UFS image file or device
        ///   node    = Windows drive letter (e.g., X:)
        ///   -o ro   = mount read-only (default)
        ///   -v      = verbose output
        /// </summary>
        static int HandleMountUdf(string[] args)
        {
            if (args.Length < 3 || args.Contains("--help"))
            {
                PrintMountUdfUsage();
                return 1;
            }

            if (!OperatingSystem.IsWindows())
            {
                Console.Error.WriteLine("Error: mount_udf is only supported on Windows.");
                Console.Error.WriteLine("       The Dokan driver must be installed.");
                Console.Error.WriteLine("       Download from: https://github.com/dokan-dev/dokany/releases");
                return 1;
            }

            bool readOnly = true;
            bool verbose = false;
            var positional = new List<string>();

            int i = 1;
            while (i < args.Length)
            {
                switch (args[i])
                {
                    case "-o":
                        if (i + 1 >= args.Length)
                        {
                            Console.Error.WriteLine("Error: -o requires a value (e.g., -o ro).");
                            return 1;
                        }
                        i++;
                        string opts = args[i];
                        foreach (string opt in opts.Split(','))
                        {
                            switch (opt.Trim().ToLower())
                            {
                                case "ro":
                                case "rdonly":
                                    readOnly = true;
                                    break;
                                case "rw":
                                    readOnly = false;
                                    break;
                                default:
                                    Console.Error.WriteLine($"Warning: Unknown mount option '{opt}' ignored.");
                                    break;
                            }
                        }
                        break;

                    case "-v":
                        verbose = true;
                        break;

                    default:
                        positional.Add(args[i]);
                        break;
                }
                i++;
            }

            if (positional.Count < 2)
            {
                Console.Error.WriteLine("Error: Both <image-path> and <drive-letter> are required.");
                PrintMountUdfUsage();
                return 1;
            }

            string imagePath = positional[0];
            string mountPoint = positional[1];

            // Validate image path
            if (!File.Exists(imagePath))
            {
                Console.Error.WriteLine($"Error: Image file '{imagePath}' not found.");
                return 1;
            }

            // Normalize mount point: accept "X:", "X:\", or just "X"
            if (mountPoint.Length == 1 && char.IsLetter(mountPoint[0]))
                mountPoint += @":\";
            else if (mountPoint.Length == 2 && mountPoint[1] == ':')
                mountPoint += @"\";
            else if (mountPoint.Length == 3 && mountPoint[1] == ':' && (mountPoint[2] == '\\' || mountPoint[2] == '/'))
                mountPoint = mountPoint[0] + @":\";

            if (verbose)
            {
                Console.WriteLine($"Image:       {imagePath}");
                Console.WriteLine($"Mount point: {mountPoint}");
                Console.WriteLine($"Read-only:   {readOnly}");
            }

            // Validate the UFS image before mounting
            try
            {
                using var testImage = new Ufs2Image(imagePath, readOnly: true);
                string fsType = testImage.Superblock.IsUfs1 ? "UFS1" : "UFS2";
                if (verbose)
                {
                    Console.WriteLine($"Filesystem:  {fsType}");
                    Console.WriteLine($"Block size:  {testImage.Superblock.BSize}");
                    Console.WriteLine($"Frag size:   {testImage.Superblock.FSize}");
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: Failed to read UFS image: {ex.Message}");
                return 1;
            }

            // Note: The mounted filesystem supports modifying, deleting, renaming and
            // truncating existing files and (empty) directories. Creating brand new
            // files or directories through the mount interface is not supported.
            if (!readOnly)
            {
                Console.WriteLine("Warning: Read-write mount enabled. Existing files can be modified or deleted.");
                Console.WriteLine("         Creating new files or directories is not supported.");
            }

            Console.WriteLine($"Mounting '{imagePath}' on {mountPoint}");
            Console.WriteLine("Press Ctrl+C to unmount and exit.");
            Console.WriteLine();

            try
            {
                using var dokanOps = new Ufs2DokanOperations(imagePath, readOnly);
                DokanNet.Logging.ILogger dokanLogger = verbose
                    ? new DokanNet.Logging.ConsoleLogger("[Dokan] ")
                    : new DokanNet.Logging.NullLogger();

                var mountOptions = DokanNet.DokanOptions.FixedDrive;
                if (readOnly)
                    mountOptions |= DokanNet.DokanOptions.WriteProtection;

                // DokanNet 2.3.x uses an instance-based API: a Dokan instance owns the
                // native runtime, and DokanInstanceBuilder configures and creates a
                // running file system that can be awaited until it is closed.
                using var dokan = new DokanNet.Dokan(dokanLogger);

                var dokanBuilder = new DokanNet.DokanInstanceBuilder(dokan)
                    .ConfigureLogger(() => dokanLogger)
                    .ConfigureOptions(options =>
                    {
                        options.Options = mountOptions;
                        options.MountPoint = mountPoint;
                        options.SingleThread = false;
                    });

                using var dokanInstance = dokanBuilder.Build(dokanOps);

                // Allow Ctrl+C to gracefully unmount instead of killing the process
                // mid-operation, which leaves the drive letter in a stuck state.
                ConsoleCancelEventHandler cancelHandler = (_, e) =>
                {
                    e.Cancel = true;
                    Console.WriteLine();
                    Console.WriteLine("Unmounting...");
                    try
                    {
                        if (OperatingSystem.IsWindows())
                            dokan.RemoveMountPoint(mountPoint);
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"Warning: RemoveMountPoint failed: {ex.Message}");
                    }
                };
                Console.CancelKeyPress += cancelHandler;
                try
                {
                    dokanInstance.WaitForFileSystemClosed(uint.MaxValue);
                }
                finally
                {
                    Console.CancelKeyPress -= cancelHandler;
                }

                Console.WriteLine("Filesystem unmounted.");
                return 0;
            }
            catch (DokanNet.DokanException ex)
            {
                Console.Error.WriteLine($"Error: Dokan mount failed: {ex.Message}");
                Console.Error.WriteLine();
                Console.Error.WriteLine("Ensure the Dokan driver is installed:");
                Console.Error.WriteLine("  https://github.com/dokan-dev/dokany/releases");
                return 1;
            }
        }

        /// <summary>
        /// Unmount a previously mounted UFS filesystem.
        /// Modeled after FreeBSD umount(8).
        ///
        /// Synopsis:
        ///   umount_udf <drive-letter>
        /// </summary>
        static int HandleUmountUdf(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("Usage: ufs2tool umount_udf <drive-letter>");
                Console.Error.WriteLine("  Example: ufs2tool umount_udf X:");
                return 1;
            }

            if (!OperatingSystem.IsWindows())
            {
                Console.Error.WriteLine("Error: umount_udf is only supported on Windows.");
                return 1;
            }

            string mountPoint = args[1];

            // Extract drive letter
            char driveLetter;
            if (mountPoint.Length >= 1 && char.IsLetter(mountPoint[0]))
                driveLetter = mountPoint[0];
            else
            {
                Console.Error.WriteLine($"Error: '{mountPoint}' is not a valid drive letter.");
                return 1;
            }

            try
            {
                // DokanNet 2.3.x: Unmount is now an instance method on Dokan.
                var dokanLogger = new DokanNet.Logging.NullLogger();
                using var dokan = new DokanNet.Dokan(dokanLogger);
                bool result = dokan.Unmount(driveLetter);
                if (result)
                {
                    Console.WriteLine($"Successfully unmounted {char.ToUpper(driveLetter)}:");
                    return 0;
                }
                else
                {
                    Console.Error.WriteLine($"Error: Failed to unmount {char.ToUpper(driveLetter)}:");
                    Console.Error.WriteLine("       The drive may not be mounted or is in use.");
                    return 1;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: Unmount failed: {ex.Message}");
                return 1;
            }
        }

        static void PrintMountUdfUsage()
        {
            Console.Error.WriteLine("""

                Usage:
                  ufs2tool mount_udf [-o options] [-v] <image-path> <drive-letter>

                Mount a UFS1/UFS2 filesystem image as a Windows drive letter.
                Requires the Dokan driver to be installed on the system.

                Options:
                  -o ro      Mount read-only (default)
                  -o rw      Mount read-write (modify existing files)
                  -v         Verbose output

                Examples:
                  ufs2tool mount_udf myimage.img X:
                  ufs2tool mount_udf -o ro myimage.img X:
                  ufs2tool mount_udf -v myimage.img Z:

                Unmount:
                  ufs2tool umount_udf X:
                  (or press Ctrl+C in the mount_udf terminal)

                Prerequisites:
                  Dokan driver must be installed:
                  https://github.com/dokan-dev/dokany/releases
                """);
        }

        static void PrintNewFsUsage()
        {
            Console.WriteLine("""

                Usage:
                  ufs2tool newfs [-EJNUjlnt] [-D input-directory] [-L volname] [-O format]
                                 [-S sector-size] [-a maxcontig] [-b block-size]
                                 [-c blocks-per-cg] [-d max-extent-size] [-e maxbpg]
                                 [-f frag-size] [-g avgfilesize] [-h avgfpdir]
                                 [-i bytes-per-inode] [-m free-space%] [-o optimization]
                                 [-p partition] [-s size] <device-path> [volume-name]
                  ufs2tool newfs [options] <image-path> <size-MB> [volume-name]
                  ufs2tool newfs [options] -D <input-directory> <image-path> [volume-name]

                Targets:
                  Device path    \\.\PhysicalDrive2, \\.\E:    Size auto-detected
                  Image file     myimage.img                   Size required (in MB) or auto from -D

                Boolean flags:
                  -E             Erase (zero) device before creating filesystem
                  -J             Enable gjournal provider
                  -N             Dry run — display parameters without creating filesystem
                  -U             Enable soft updates
                  -j             Enable soft updates journaling (implies -U)
                  -l             Enable multilabel MAC support
                  -n             Do not create .snap directory
                  -t             Enable TRIM/DISCARD flag in superblock

                Options with values:
                  -D directory   Input directory — populate image with directory contents.
                                 Image size is auto-calculated from on-disk block-aligned
                                 usage plus 10% overhead for filesystem metadata.
                                 All files including hidden files are copied.
                                 Soft updates are off by default unless -U is specified.
                  -L volname     Set volume label (max 32 chars)
                  -O format      Filesystem format: 1 (UFS1) or 2 (UFS2, default)
                  -S sector-size Override sector size (default: 512, must be power of 2)
                  -a maxcontig   Max contiguous blocks before forced rotation delay
                  -b block-size  Block size in bytes (default: 32768)
                                 Must be a power of 2, between 4096 and 65536.
                  -c blocks-per-cg  Blocks per cylinder group (default: auto)
                  -d max-extent  Maximum extent size for file allocation
                  -e maxbpg      Maximum blocks per file in a cylinder group
                  -f frag-size   Fragment size in bytes (default: 4096)
                                 Must be a power of 2, at least 512.
                                 Block size / frag size ratio must be 1, 2, 4, or 8.
                  -g avgfilesize Expected average file size in bytes (default: 16384)
                  -h avgfpdir    Expected average files per directory (default: 64)
                  -i bytes/inode Number of bytes per inode (controls inode density)
                  -m free-space  Minimum free space percentage (default: 8)
                  -o optimization  Optimization preference: "time" (default) or "space"
                  -p partition   Partition label (informational)
                  -s size        Filesystem size in 512-byte sectors (overrides auto-detect)

                Examples:
                  ufs2tool newfs \\.\PhysicalDrive2
                  ufs2tool newfs -O 1 -b 16384 -f 2048 \\.\E:
                  ufs2tool newfs -Uj -b 32768 -f 4096 \\.\PhysicalDrive2
                  ufs2tool newfs -N myimage.img 256
                  ufs2tool newfs -O 1 myimage.img 128
                  ufs2tool newfs -b 65536 -f 8192 -L MYVOLUME myimage.img 512
                  ufs2tool newfs -Ujt -m 5 -o space myimage.img 1024
                  ufs2tool newfs -D /path/to/my/files output.img
                  ufs2tool newfs -Uj -O 1 -D /path/to/my/files output.img MyVolume

                FreeBSD equivalents:
                  newfs -O 2 -b 32768 -f 4096 /dev/da0p2
                  newfs -O 1 -b 16384 -f 2048 /dev/ada1p1
                  newfs -U -j -t /dev/ada0p2
                """);
        }

        static void PrintMakeFsUsage()
        {
            Console.WriteLine("""

                Usage:
                  ufs2tool makefs [-DxZ] [-B endian] [-b free-blocks] [-f free-files]
                                  [-M minimum-size] [-m maximum-size] [-o fs-options]
                                  [-S sector-size] [-s image-size] [-T timestamp]
                                  [-t fs-type] image-file directory

                Create a file system image from a directory tree, replicating
                FreeBSD makefs(8) behavior.

                Options:
                  -B endian        Set byte order (le/be) — informational for UFS
                  -b free-blocks   Minimum free blocks (optional '%' suffix for percentage)
                  -f free-files    Minimum free files/inodes (optional '%' suffix for percentage)
                  -M minimum-size  Set minimum size of the image
                  -m maximum-size  Set maximum size of the image
                  -o fs-options    Comma-separated FFS options (see below)
                  -S sector-size   Set sector size (default: 512)
                  -s image-size    Set image size (equivalent to -M and -m combined)
                  -T timestamp     Set timestamp for all files (seconds from epoch)
                  -t fs-type       Filesystem type (only 'ffs' supported, the default)
                  -Z               Create sparse file

                FFS-specific options (-o key=value,...):
                  version          UFS version: 1 for FFS (default), 2 for UFS2
                  bsize            Block size (default: 32768)
                  fsize            Fragment size (default: 4096)
                  label            Volume label (max 32 chars)
                  softupdates      0 for disable (default), 1 for enable
                  density          Bytes per inode
                  minfree          Minimum free space percentage (default: 8)
                  optimization     'time' (default) or 'space'
                  avgfilesize      Expected average file size
                  avgfpdir         Expected number of files per directory
                  maxbpg           Maximum blocks per file in a cylinder group
                  extent           Maximum extent size
                  maxbpcg          Maximum total blocks in a cylinder group

                Size suffixes: b (×512), k (×1024), m (×1M), g (×1G), t (×1T), w (×4)
                Products with 'x': e.g., 512x1024 = 524288

                Examples:
                  ufs2tool makefs output.img /path/to/my/files
                  ufs2tool makefs -t ffs -o version=2 output.img /path/to/my/files
                  ufs2tool makefs -o bsize=32768,fsize=4096,label=MYVOLUME output.img /path/to/files
                  ufs2tool makefs -s 256m output.img /path/to/my/files
                  ufs2tool makefs -b 10% -f 10% output.img /path/to/my/files
                  ufs2tool makefs -M 128m -m 512m output.img /path/to/my/files
                  ufs2tool makefs -o softupdates=1,version=2 output.img /path/to/my/files

                FreeBSD equivalents:
                  makefs -t ffs image.img source_directory
                  makefs -t ffs -o version=2 image.img source_directory
                  makefs -t ffs -o version=2,softupdates=1 image.img source_directory
                """);
        }

        static void PrintTuneFsUsage()
        {
            Console.WriteLine("""

                Usage:
                  ufs2tool tunefs [-A] [-a enable | disable] [-e maxbpg] [-f avgfilesize]
                                  [-J enable | disable] [-j enable | disable] [-k metaspace]
                                  [-L volname] [-l enable | disable] [-m minfree]
                                  [-N enable | disable] [-n enable | disable]
                                  [-o space | time] [-p] [-s avgfpdir] [-t enable | disable]
                                  special

                Change layout parameters to an existing UFS1/UFS2 filesystem,
                replicating FreeBSD tunefs(8) behavior.

                Options:
                  -A               Write the updated superblock to all backup superblock
                                   locations (in addition to the primary).
                  -a enable|disable  Enable or disable POSIX.1e ACL support.
                  -e maxbpg        Maximum blocks per file in a cylinder group.
                  -f avgfilesize   Expected average file size (used for optimization).
                  -J enable|disable  Enable or disable gjournal.
                  -j enable|disable  Enable or disable soft updates journaling.
                                   Enabling also enables soft updates.
                  -k metaspace     Space (in frags) to hold for metadata blocks.
                  -L volname       Volume label (alphanumerics, dashes, underscores;
                                   max 31 characters).
                  -l enable|disable  Enable or disable multilabel MAC support.
                  -m minfree       Minimum percentage of free space (0-99).
                  -N enable|disable  Enable or disable NFSv4 ACL support.
                  -n enable|disable  Enable or disable soft updates.
                  -o space|time    Optimization preference.
                  -p               Print current tuneable values and exit.
                  -s avgfpdir      Expected number of files per directory.
                  -t enable|disable  Enable or disable TRIM/DISCARD support.

                Examples:
                  ufs2tool tunefs -p myimage.img
                  ufs2tool tunefs -L MYVOLUME myimage.img
                  ufs2tool tunefs -n enable -j enable myimage.img
                  ufs2tool tunefs -m 5 -o space myimage.img
                  ufs2tool tunefs -t enable myimage.img
                  ufs2tool tunefs -A -L NEWLABEL myimage.img

                FreeBSD equivalents:
                  tunefs -p /dev/ada0p2
                  tunefs -L MYVOLUME /dev/ada0p2
                  tunefs -n enable -j enable /dev/ada0p2
                """);
        }

        static void PrintUsage()
        {
            Console.WriteLine("""
                UFS2 Tool — FreeBSD UFS1/UFS2 Filesystem Manager for Windows

                Commands:
                  newfs   [options] <target> [size-MB] [volume-name]
                          Create a new UFS1 or UFS2 filesystem on a device or image file
                          Supports all FreeBSD newfs(8) options (except -T, -k, -r)
                  newfs   -D <input-directory> <image-path> [volume-name]
                          Create image from directory contents (size auto-calculated)
                  makefs  [-o fs-options] [-s image-size] image-file directory
                          Create image from directory tree (FreeBSD makefs(8) compatible).
                          Supports -o for FFS options (version, bsize, fsize, label,
                          softupdates, density, minfree, optimization, etc.)
                          Soft updates disabled by default (softupdates=0).
                  tunefs  [-A] [-a enable|disable] [-e maxbpg] [-f avgfilesize]
                          [-j enable|disable] [-J enable|disable] [-k metaspace]
                          [-L volname] [-l enable|disable] [-m minfree]
                          [-N enable|disable] [-n enable|disable] [-o space|time]
                          [-p] [-s avgfpdir] [-t enable|disable] special
                          Change layout parameters to an existing filesystem.
                          (FreeBSD tunefs(8) compatible)
                  growfs  [-Ny] [-s size] special
                          Expand an existing UFS1/UFS2 filesystem image.
                          (FreeBSD growfs(8) compatible)
                  fsck_ufs [-dfnpy] [-b block] filesystem
                          File system consistency check and interactive repair.
                          Also available as fsck_ffs.
                          (FreeBSD fsck_ffs(8)/fsck_ufs(8) compatible)
                  info    <image-path>
                          Show filesystem info (UFS1/UFS2)
                  ls      <image-path> [path]
                          List directory contents
                  extract <image-path> <output-directory> [fs-path]
                          Extract files from a UFS1/UFS2 filesystem image.
                          If fs-path is omitted, extracts the entire filesystem.
                          If fs-path points to a directory, extracts it recursively.
                          If fs-path points to a file, extracts that single file.
                  replace <image-path> <fs-path> <source-path>
                          Replace a file or directory in a UFS1/UFS2 filesystem image.
                          If fs-path points to a file, replaces its content with source-path.
                          If fs-path points to a directory, replaces matching files
                          from source-path recursively.
                  add     <image-path> <fs-path> <source-path>
                          Add a file or directory to a UFS1/UFS2 filesystem image.
                          If source-path is a file, adds it at fs-path.
                          If source-path is a directory, adds it recursively at fs-path.
                  delete  <image-path> <fs-path>
                          Delete a file or directory from a UFS1/UFS2 filesystem image.
                          If fs-path is a directory, deletes all contents recursively.
                  rename  <image-path> <fs-path> <new-name>
                          Rename a file or directory in a UFS1/UFS2 filesystem image.
                          The entry stays in the same parent directory.
                  chmod   [-R] <image-path> <mode> [fs-path]
                          Change permissions of a file or directory in a UFS image.
                          With -R, apply to entire image (files and directories).
                  stat    <image-path> <fs-path>
                          Show detailed file, directory, or symlink information.
                  find    <image-path> <name-pattern> [-type f|d|l] [-path start-path]
                          Search for files by name pattern. Supports * and ? wildcards.
                          -type f (files), d (directories), l (symlinks).
                          -path to start search from a subdirectory.
                  du      [-h] [-s] [-d depth] <image-path> [fs-path]
                          Display disk usage statistics for files and directories.
                          -h for human-readable sizes, -s for summary only,
                          -d to limit directory depth.
                          (Modeled after FreeBSD du(1))
                  devinfo <device-path>
                          Show device size and sector information
                  mount_udf [-o options] [-v] <image-path> <drive-letter>
                          Mount a UFS1/UFS2 image as a Windows drive using Dokan.
                          Requires the Dokan driver. Supports read-only and read-write access.
                          (Modeled after FreeBSD mount_udf(8) / mount(8))
                  umount_udf <drive-letter>
                          Unmount a previously mounted UFS drive.

                Target can be a device (\\.\PhysicalDrive2) or an image file (myimage.img).
                Device targets auto-detect size; image targets require size in MB or -D.

                Examples:
                  ufs2tool newfs \\.\PhysicalDrive2
                  ufs2tool newfs -O 1 -b 16384 -f 2048 myimage.img 128
                  ufs2tool newfs -Uj -b 32768 -f 4096 myimage.img 256 MYVOLUME
                  ufs2tool newfs -N myimage.img 256
                  ufs2tool newfs -D /path/to/my/files output.img
                  ufs2tool newfs -O 1 -D /path/to/my/files output.img MyVolume
                  ufs2tool makefs output.img /path/to/my/files
                  ufs2tool makefs -t ffs -o version=2 output.img /path/to/my/files
                  ufs2tool makefs -o bsize=32768,label=MYVOLUME output.img /path/to/files
                  ufs2tool tunefs -p myimage.img
                  ufs2tool tunefs -L MYVOLUME myimage.img
                  ufs2tool tunefs -n enable -j enable myimage.img
                  ufs2tool growfs -y myimage.img
                  ufs2tool growfs -y -s 512m myimage.img
                  ufs2tool growfs -N myimage.img
                  ufs2tool fsck_ufs myimage.img
                  ufs2tool fsck_ufs -p myimage.img
                  ufs2tool fsck_ufs -nf myimage.img
                  ufs2tool info myimage.img
                  ufs2tool ls myimage.img
                  ufs2tool extract myimage.img ./output
                  ufs2tool extract myimage.img ./output /subdir
                  ufs2tool extract myimage.img ./output /subdir/file.txt
                  ufs2tool replace myimage.img /path/to/file.txt ./local/file.txt
                  ufs2tool replace myimage.img /path/to/dir ./local/dir
                  ufs2tool add myimage.img /newfile.txt ./local/file.txt
                  ufs2tool add myimage.img /newdir ./local/dir
                  ufs2tool delete myimage.img /path/to/file.txt
                  ufs2tool delete myimage.img /path/to/dir
                  ufs2tool rename myimage.img /path/to/old.txt newname.txt
                  ufs2tool rename myimage.img /path/to/olddir newdir
                  ufs2tool chmod myimage.img 755 /path/to/dir
                  ufs2tool chmod -R myimage.img 644
                  ufs2tool chmod -R myimage.img 644 755
                  ufs2tool stat myimage.img /path/to/file.txt
                  ufs2tool stat myimage.img /
                  ufs2tool find myimage.img "*.txt"
                  ufs2tool find myimage.img "game*" -type f
                  ufs2tool find myimage.img "*" -type d -path /subdir
                  ufs2tool du myimage.img
                  ufs2tool du -h myimage.img /subdir
                  ufs2tool du -s myimage.img
                  ufs2tool du -d 1 myimage.img
                  ufs2tool devinfo \\.\PhysicalDrive2
                  ufs2tool mount_udf myimage.img X:
                  ufs2tool mount_udf -v myimage.img Z:
                  ufs2tool umount_udf X:

                Note: Device operations require Administrator privileges.
                      mount_udf requires the Dokan driver to be installed.

                For full newfs options: ufs2tool newfs --help
                For full tunefs options: ufs2tool tunefs --help
                For full growfs options: ufs2tool growfs --help
                For full fsck_ufs options: ufs2tool fsck_ufs --help
                For full mount_udf options: ufs2tool mount_udf --help
                For full chmod options: ufs2tool chmod --help
                """);
        }

        static int PrintUsageAndReturn()
        {
            PrintUsage();
            return 1;
        }
    }
}
