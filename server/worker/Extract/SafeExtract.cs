using System.IO.Compression;
namespace PS5Library.Worker;
public static class SafeExtract
{
    public static void Zip(string input,string output,long maximumBytes)
    {
        using var zip=ZipFile.OpenRead(input); long size=0;
        if(zip.Entries.Count>100000) throw new WorkerError("INPUT_TOO_LARGE");
        var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var entry in zip.Entries)
        {
            var name=entry.FullName.TrimEnd('/'); _=Files.SafeRelative(output,name);
            if(!names.Add(name) || ((entry.ExternalAttributes>>16)&0xf000)==0xa000) throw new WorkerError("UNSAFE_PATH");
            size=checked(size+entry.Length); if(size>maximumBytes) throw new WorkerError("QUOTA_EXCEEDED");
        }
        if(Directory.Exists(output)) throw new WorkerError("OUTPUT_EXISTS");
        Directory.CreateDirectory(output);
        foreach(var entry in zip.Entries)
        {
            var file=Files.SafeRelative(output,entry.FullName.TrimEnd('/'));
            if(entry.FullName.EndsWith('/')) { Directory.CreateDirectory(file); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            using var source=entry.Open(); using var dest=new FileStream(file,FileMode.CreateNew,FileAccess.Write);
            var buffer=new byte[1024*1024]; long copied=0; int read;
            while((read=source.Read(buffer))>0) { copied+=read; if(copied>entry.Length) throw new WorkerError("CORRUPT_INPUT"); dest.Write(buffer,0,read); }
            if(copied!=entry.Length) throw new WorkerError("INCOMPLETE_INPUT"); dest.Flush(true);
        }
    }
}
