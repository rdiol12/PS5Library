using LibProsperoPkg;
using UFS2Tool;
namespace PS5Library.Worker;
public sealed class ProsperoPackageBuilderAdapter : IPackageBuilder
{
    public string Version=>"LibProsperoPKG 2.6.0 / 748eabf1b7d17819528cabf367d8e27109d8fce3";
    public string Format=>"pkg";
    public string Build(string staging,string output,Identity identity)
    {
        var result=ProsperoPackageBuilder.Build(new ProsperoBuildOptions { SourceFolder=staging,OutputFolder=output,TitleId=identity.TitleId,ContentId=identity.ContentId,Version=identity.Version,Title=identity.Title,GenerateParamJsonIfMissing=false,LicenseFree=true,OutputFormat=ProsperoOutputFormat.DebugImage },Console.Error.WriteLine);
        foreach(var warning in result.Warnings) Console.Error.WriteLine(warning);
        return result.OutputPath;
    }
}
public sealed class UFS2ImageBuilderAdapter : IPackageBuilder
{
    public string Version=>"UFS2Tool 4.1.0 / b5307a60d5b4e3a68ba680e0e33cfadf05017c77";
    public string Format=>"ffpkg";
    public string Build(string staging,string output,Identity identity)
    {
        var filename=Path.Combine(output,identity.TitleId+".ffpkg");
        new Ufs2ImageCreator { FilesystemFormat=2,InputDirectory=staging,VolumeName=identity.TitleId }.MakeFsImage(filename,staging,freeblockpc:5,minimumSize:32*1024*1024);
        return filename;
    }
}
