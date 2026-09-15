using System.Text.Json;
namespace PS5Library.Worker;
public static class Pipeline
{
    public static BuildResult Build(string input,string output,string method,Identity? expected=null,string? releaseId=null,string? profileId=null,string? expectedHash=null,long? expectedSize=null)
    {
        input=Path.GetFullPath(input); output=Path.GetFullPath(output);
        if(output==input || output.StartsWith(input.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,OperatingSystem.IsWindows()?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal)) throw new WorkerError("UNSAFE_PATH");
        if(profileId is not null) throw new WorkerError("PROFILE_NOT_APPLIED","Use the verified backport preparation step; profile IDs are not decorative metadata.");
        Progress.Stage("Inspecting input",0);
        var before=InputInspector.Inspect(input,expected);
        if(before.Format!="folder" || before.Identity is null) throw new WorkerError("UNSUPPORTED_INPUT","Builder accepts an inspected prepared folder.");
        IPackageBuilder builder=method switch { "FPKG"=>new ProsperoPackageBuilderAdapter(),"SHADOWMOUNT"=>new UFS2ImageBuilderAdapter(),_=>throw new WorkerError("UNSUPPORTED_METHOD") };
        var size=Files.Enumerate(input).Sum(file=>new FileInfo(file).Length);
        if(expectedSize is not null && size!=expectedSize) throw new WorkerError("CORRUPT_INPUT","Source size differs from the manifest and reserved quota.");
        Directory.CreateDirectory(output);
        if(new DriveInfo(Path.GetPathRoot(output)!).AvailableFreeSpace < checked(size*4+64*1024*1024)) throw new WorkerError("INSUFFICIENT_SPACE");
        Progress.Stage("Verifying source",1);
        var inputHash=Files.TreeHash(input);
        if(expectedHash is not null && inputHash!=expectedHash) throw new WorkerError("CORRUPT_INPUT","Source tree hash differs from the selected release.");
        var stage=Path.Combine(output,".staging",Guid.NewGuid().ToString());
        var copy=Path.Combine(stage,"source"); var build=Path.Combine(stage,"build"); Directory.CreateDirectory(build);
        Progress.Stage("Copying to staging",2);
        Files.CopyTree(input,copy);
        if(Files.TreeHash(copy)!=inputHash) throw new WorkerError("SOURCE_CHANGED");
        Progress.Stage("Building package",3);
        var result=builder.Build(copy,build,before.Identity);
        Progress.Stage("Inspecting output",4);
        var inspection=InputInspector.Inspect(result,before.Identity);
        if(Files.TreeHash(input)!=inputHash) throw new WorkerError("SOURCE_CHANGED");
        Progress.Stage("Verifying output",5);
        var hash=Files.Hash(result); var final=Path.Combine(output,hash+"."+builder.Format);
        Progress.Stage("Publishing package",6);
        if(!File.Exists(final)) File.Move(result,final);
        else if(Files.Hash(final)!=hash) throw new WorkerError("CORRUPT_INPUT");
        var provenance=new BuildResult(final,builder.Format,hash,new FileInfo(final).Length,inputHash,builder.Version,releaseId,profileId,DateTimeOffset.UtcNow,inspection);
        File.WriteAllText(final+".json",JsonSerializer.Serialize(provenance,Program.JsonOptions));
        Directory.Delete(stage,true);
        Progress.Stage("Verified on server",7);
        return provenance;
    }
}
