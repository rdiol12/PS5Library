using System.Diagnostics;
using System.Text.Json;

namespace PS5Library.Worker;

public static class AutoBackport
{
    public static bool Enabled { get; set; }

    public static BackportProfile? Prepare(
        string input,
        string method,
        BackportProfile? requested,
        string? expectedBase,
        string? archiveHash = null
    )
    {
        if (method != "FPKG")
            return null;
        if (!Enabled)
        {
            Progress.Creator("DISABLED");
            return null;
        }
        if (
            Directory
                .EnumerateFileSystemEntries(input)
                .Any(p =>
                    Path.GetFileName(p).Equals("backport", StringComparison.OrdinalIgnoreCase)
                )
        )
        {
            Progress.Creator("SKIPPED_EXISTING");
            return null;
        }
        if (requested is not null && requested.TargetFirmware != "4.50")
            throw new WorkerError(
                "BACKPORT_TARGET_UNVERIFIED",
                "Experimental creator currently supports firmware 4.50 only."
            );
        var script = Environment.GetEnvironmentVariable("BACKPORT_CREATOR_SCRIPT");
        var root = Environment.GetEnvironmentVariable("BACKPORT_CREATOR_OUTPUT_ROOT");
        if (
            string.IsNullOrWhiteSpace(script)
            || !Path.IsPathFullyQualified(script)
            || !File.Exists(script)
            || string.IsNullOrWhiteSpace(root)
            || !Path.IsPathFullyQualified(root)
        )
            throw new WorkerError(
                "BACKPORT_CREATOR_UNAVAILABLE",
                "Configure the experimental backport creator on the package worker, or disable it in Runtime configuration."
            );
        var output = Path.Combine(root, Guid.NewGuid().ToString());
        var start = new ProcessStartInfo(
            Environment.GetEnvironmentVariable("BACKPORT_CREATOR_PYTHON") ?? "python"
        )
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in new[] { script, input, output })
            start.ArgumentList.Add(arg);
        if (expectedBase is not null)
        {
            start.ArgumentList.Add("--expected-base");
            start.ArgumentList.Add(expectedBase);
        }
        Progress.Creator("CREATING");
        using var child =
            Process.Start(start) ?? throw new WorkerError("BACKPORT_CREATOR_UNAVAILABLE");
        var stdout = child.StandardOutput.ReadToEndAsync();
        var stderr = Task.Run(async () =>
        {
            while (await child.StandardError.ReadLineAsync() is { } line)
                Console.Error.WriteLine(line);
        });
        if (!child.WaitForExit(30 * 60 * 1000))
        {
            child.Kill(entireProcessTree: true);
            Progress.Creator("FAILED");
            throw new WorkerError(
                "BACKPORT_CREATOR_FAILED",
                "Experimental backport creation timed out."
            );
        }
        stderr.GetAwaiter().GetResult();
        var text = stdout.GetAwaiter().GetResult();
        if (text.Length > 4 * 1024 * 1024)
            throw new WorkerError(
                "BACKPORT_CREATOR_FAILED",
                "Creator response exceeded its limit."
            );
        using var response = JsonDocument.Parse(text);
        var result = response.RootElement;
        var state = result.GetProperty("state").GetString();
        if (state == "NEEDS_REVIEW")
        {
            Progress.Creator("NEEDS_REVIEW");
            throw new WorkerError(
                "BACKPORT_REVIEW_REQUIRED",
                "Experimental analysis found unresolved compatibility requirements. Review the creator report before building."
            );
        }
        if (child.ExitCode != 0 || state is not ("CREATED" or "NOT_REQUIRED" or "SKIPPED_EXISTING"))
        {
            Progress.Creator("FAILED");
            throw new WorkerError(
                "BACKPORT_CREATOR_FAILED",
                result.TryGetProperty("message", out var message)
                    ? message.GetString()!
                    : "Experimental backport creation failed."
            );
        }
        if (state != "CREATED")
        {
            Progress.Creator(state);
            return null;
        }
        var profile =
            result.GetProperty("profile").Deserialize<BackportProfile>(Program.JsonOptions)
            ?? throw new WorkerError("BACKPORT_CREATOR_FAILED");
        if (
            profile.TargetFirmware != "4.50"
            || profile.InstallationMethod != "FPKG"
            || profile.Delivery != "OVERLAY"
            || profile.TestedState != "UNTESTED"
        )
            throw new WorkerError("PROFILE_MISMATCH");
        profile = profile with
        {
            Runtime = requested?.Runtime ?? profile.Runtime,
            InputHashes = archiveHash is null
                ? profile.InputHashes
                : profile.InputHashes.Append(archiveHash).Distinct().ToArray(),
        };
        var identity =
            InputInspector.Inspect(input).Identity ?? throw new WorkerError("PROFILE_MISMATCH");
        Backports.Validate(profile, input, Files.TreeHash(input), identity, method);
        Progress.Creator("CREATED", profile);
        return profile;
    }
}
