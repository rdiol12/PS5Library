// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Sparse publisher AFID/FIDX assignment preservation.
#nullable enable
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace LibProsperoPkg.PFS;

/// <summary>Reads and writes exact path-to-AFID assignments for publisher PPR-PFS images.</summary>
public static class ProsperoAfidMap
{
    /// <summary>
    /// Extracts every real AFID slot from an already-decrypted PPR-PFS image. Empty <c>-1</c>
    /// slots are preserved implicitly by gaps between the returned numeric assignments.
    /// </summary>
    public static IReadOnlyDictionary<string, uint> FromPfs(PfsReader reader)
    {
        ArgumentNullException.ThrowIfNull(reader);
        PfsReader.File table = reader.GetSuperRoot().Get("afid_to_ino_table") as PfsReader.File
            ?? throw new InvalidDataException(
                "The PFS super-root has no afid_to_ino_table file.");
        byte[] data = table.ReadAllBytes();
        if (data.Length < 12 || data.Length % 4 != 0)
            throw new InvalidDataException(
                $"afid_to_ino_table has invalid size 0x{data.Length:X}.");
        int count = BinaryPrimitives.ReadInt32LittleEndian(data);
        if (count < 2 || count > data.Length / 4 - 1)
            throw new InvalidDataException(
                $"afid_to_ino_table declares invalid entry count {count}.");

        Dictionary<uint, PfsReader.File> byInode = reader.GetAllFiles()
            .ToDictionary(file => file.ino);
        var result = new Dictionary<string, uint>(StringComparer.Ordinal);
        for (int afid = 0; afid < count - 2; afid++)
        {
            int inode = BinaryPrimitives.ReadInt32LittleEndian(
                data.AsSpan(checked((afid + 1) * 4), 4));
            if (inode < 0)
                continue;
            if (!byInode.TryGetValue(checked((uint)inode), out PfsReader.File? file))
                throw new InvalidDataException(
                    $"AFID {afid} references inode {inode}, which is absent from the user tree.");
            string path = NormalizeExtractedPath(file.FullName);
            if (!result.TryAdd(path, checked((uint)afid)))
                throw new InvalidDataException(
                    $"AFID table resolves duplicate path '{path}'.");
        }
        return result;
    }

    /// <summary>Loads a UTF-8 TSV map written by <see cref="Save"/>.</summary>
    public static IReadOnlyDictionary<string, uint> Load(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var result = new Dictionary<string, uint>(StringComparer.Ordinal);
        foreach (string sourceLine in File.ReadLines(path, Encoding.UTF8))
        {
            string line = sourceLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
                continue;
            int separator = line.IndexOf('\t');
            if (separator <= 0 || separator == line.Length - 1 ||
                !uint.TryParse(line.AsSpan(0, separator), out uint afid))
            {
                throw new InvalidDataException(
                    $"Invalid AFID map line: '{sourceLine}'. Expected <decimal-afid><TAB><path>.");
            }
            string normalized = NormalizeInputPath(line[(separator + 1)..]);
            if (!result.TryAdd(normalized, afid))
                throw new InvalidDataException(
                    $"AFID map contains duplicate path '{normalized}'.");
        }
        if (result.Values.Distinct().Count() != result.Count)
            throw new InvalidDataException("AFID map assigns one slot to multiple paths.");
        return result;
    }

    /// <summary>Saves a stable UTF-8 TSV map ordered by AFID and then path.</summary>
    public static void Save(
        string path,
        IReadOnlyDictionary<string, uint> assignments)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentNullException.ThrowIfNull(assignments);
        var rows = new List<(string Path, uint Afid)>(assignments.Count);
        var normalizedPaths = new HashSet<string>(StringComparer.Ordinal);
        var afids = new HashSet<uint>();
        foreach ((string sourcePath, uint afid) in assignments)
        {
            string normalized = NormalizeInputPath(sourcePath);
            if (normalized.Contains('\t') || normalized.Contains('\r') ||
                normalized.Contains('\n'))
            {
                throw new InvalidDataException(
                    $"AFID path cannot be represented in TSV: '{sourcePath}'.");
            }
            if (!normalizedPaths.Add(normalized))
                throw new InvalidDataException(
                    $"AFID map contains duplicate normalized path '{normalized}'.");
            if (!afids.Add(afid))
                throw new InvalidDataException(
                    $"AFID map assigns slot {afid} to multiple paths.");
            rows.Add((normalized, afid));
        }

        string fullPath = Path.GetFullPath(path);
        Directory.CreateDirectory(
            Path.GetDirectoryName(fullPath) ?? Directory.GetCurrentDirectory());
        using var output = new StreamWriter(
            fullPath, append: false, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        output.WriteLine("# LibProsperoPkg AFID map v1");
        foreach ((string normalized, uint afid) in rows
                     .OrderBy(row => row.Afid)
                     .ThenBy(row => row.Path, StringComparer.Ordinal))
        {
            output.Write(afid);
            output.Write('\t');
            output.WriteLine(normalized);
        }
    }

    private static string NormalizeExtractedPath(string path)
    {
        string normalized = path.Replace('\\', '/');
        if (normalized.Equals("/uroot", StringComparison.Ordinal))
            return "/";
        if (normalized.StartsWith("/uroot/", StringComparison.Ordinal))
            normalized = normalized["/uroot".Length..];
        return NormalizeInputPath(normalized);
    }

    private static string NormalizeInputPath(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string normalized = path.Trim().Replace('\\', '/');
        return normalized.StartsWith('/') ? normalized : "/" + normalized;
    }
}
