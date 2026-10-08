using LibProsperoPkg.PKG;

namespace PS5Library.Worker;

public static class PackageAssets
{
    const int MaximumArtworkBytes = 16 * 1024 * 1024;
    static readonly byte[] PngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    public static object Extract(string input, string output)
    {
        _ = InputInspector.Inspect(input);
        var package = ProsperoPkgReader.Read(input);
        if (package.Fih is null) throw new WorkerError("CORRUPT_INPUT");
        Directory.CreateDirectory(output);
        var found = new Dictionary<string, string>();
        using var stream = File.OpenRead(input);
        foreach (var (id, name) in new[] { (ProsperoEntryId.Icon0Png, "icon"), (ProsperoEntryId.Pic0Png, "hero") })
        {
            var entry = package.Entries.FirstOrDefault(value => value.Id == id);
            if (entry is null || entry.Encrypted || entry.DataSize is 0 or > MaximumArtworkBytes) continue;
            var offset = checked((long)package.Fih.EmbeddedCntOffset + entry.DataOffset);
            if (offset < 0 || offset + entry.DataSize > stream.Length) throw new WorkerError("CORRUPT_INPUT", "Package artwork is outside the package.");
            var bytes = new byte[entry.DataSize];
            stream.Position = offset;
            stream.ReadExactly(bytes);
            if (!bytes.AsSpan().StartsWith(PngMagic)) continue;
            var destination = Path.Combine(output, name + ".png");
            File.WriteAllBytes(destination, bytes);
            found[name] = destination;
        }
        return found;
    }
}
