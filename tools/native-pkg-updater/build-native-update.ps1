param(
    [Parameter(Mandatory=$true)][string]$SourceFolder,
    [string]$Executable,
    [switch]$GenerateUnsignedNptitle,
    [Parameter(Mandatory=$true)][string]$OutputPackage,
    [Parameter(Mandatory=$true)][string]$ReferencePackage,
    [Parameter(Mandatory=$true)][ValidatePattern('^\d{2}\.\d{3}\.\d{3}$')][string]$BaseContentVersion,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Z]{4}\d{5}$')][string]$TitleId,
    [string]$ToolkitDirectory = $env:PS5_PKG_TOOLKIT_DIR,
    [ValidateRange(-4, 9)][int]$CompressionLevel = 9,
    [string]$Python = "python",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$serverDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\server"))
$updateCli = Join-Path $PSScriptRoot "native-update.mjs"
$requirements = & node "--env-file-if-exists=$serverDirectory\.env" $updateCli prerequisites `
    --source $SourceFolder --title-id $TitleId
if ($LASTEXITCODE -ne 0) { throw "Native title prerequisites failed; no package was built." }
$requirements = $requirements | ConvertFrom-Json
foreach ($warning in $requirements.warnings) { Write-Warning "$($warning.code): $($warning.message)" }
if (-not $requirements.ready) { throw ($requirements.missing -join " ") }
if ([string]::IsNullOrWhiteSpace($ToolkitDirectory)) {
    throw "Set PS5_PKG_TOOLKIT_DIR to the local PS5 package toolkit directory."
}

$toolkit = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($ToolkitDirectory))
$builder = Join-Path $toolkit "build-from-folder.ps1"
$projectGenerator = Join-Path $toolkit "scripts\create-gp5-from-folder.py"
$publisher = Join-Path $toolkit "toolchain\prospero-pub-cmd.exe"
$publisherLibrary = Join-Path $toolkit "toolchain\libScePubTools.dll"
$converter = Join-Path $toolkit "toolchain\ext\sc2.exe"
foreach ($required in @($builder, $projectGenerator, $publisher, $publisherLibrary, $converter)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required package tool is missing: $required"
    }
}

$output = [IO.Path]::GetFullPath($OutputPackage)
$reference = [IO.Path]::GetFullPath($ReferencePackage)
if (-not (Test-Path -LiteralPath $reference -PathType Leaf)) {
    throw "ReferencePackage does not exist or is not a file: $reference"
}
$outputDirectory = [IO.Path]::GetDirectoryName($output)
if ([string]::IsNullOrWhiteSpace($outputDirectory)) { $outputDirectory = (Get-Location).Path }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$buildLogDirectory = Join-Path $outputDirectory (([IO.Path]::GetFileNameWithoutExtension($output)) + "-build-logs")
New-Item -ItemType Directory -Force -Path $buildLogDirectory | Out-Null
$referenceStdoutLog = Join-Path $buildLogDirectory "00-reference-preflight.stdout.log"
$referenceStderrLog = Join-Path $buildLogDirectory "00-reference-preflight.stderr.log"
$referenceArgs = @(
    "img_file_list", "--passcode", ("0" * 32), "${reference}:sce_sys/param.json")
$referenceStartArgs = $referenceArgs | ForEach-Object {
    if ([string]$_ -match '[\s"]') { '"' + ([string]$_).Replace('"', '\"') + '"' } else { [string]$_ }
}
$referenceProcess = Start-Process -FilePath $publisher -ArgumentList $referenceStartArgs `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $referenceStdoutLog `
    -RedirectStandardError $referenceStderrLog
try {
    [int]$referenceExitCode = $referenceProcess.ExitCode
} finally {
    $referenceProcess.Dispose()
}
if ($referenceExitCode -ne 0) {
    $noPassStdoutLog = Join-Path $buildLogDirectory "00-reference-no-passcode.stdout.log"
    $noPassStderrLog = Join-Path $buildLogDirectory "00-reference-no-passcode.stderr.log"
    $noPassArgs = @("img_file_list", "--no_passcode", "${reference}:sce_sys/param.json") |
        ForEach-Object {
            if ([string]$_ -match '[\s"]') { '"' + ([string]$_).Replace('"', '\"') + '"' } else { [string]$_ }
        }
    $noPassProcess = Start-Process -FilePath $publisher -ArgumentList $noPassArgs `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $noPassStdoutLog `
        -RedirectStandardError $noPassStderrLog
    try {
        [int]$noPassExitCode = $noPassProcess.ExitCode
    } finally {
        $noPassProcess.Dispose()
    }
    if ($noPassExitCode -eq 0) {
        $message = @(
            "REFERENCE_PLAINTEXT_NATIVE_UPDATE_UNSUPPORTED:"
            "The reference package is readable only with --no_passcode."
            "The SDK publisher cannot use that profile as a delta reference."
            "This installed base requires a full replacement."
            "See $noPassStdoutLog and $noPassStderrLog."
        ) -join " "
        throw $message
    }
    $referenceDiagnostic = @(
        Get-Content -LiteralPath $referenceStderrLog -ErrorAction SilentlyContinue
        Get-Content -LiteralPath $referenceStdoutLog -ErrorAction SilentlyContinue
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 20
    $referenceSummary = $referenceDiagnostic -join "`n"
    if ([string]::IsNullOrWhiteSpace($referenceSummary)) {
        $referenceSummary = "The publisher returned exit code $referenceExitCode without a diagnostic."
    }
    $message = @(
        "REFERENCE_NOT_PASSCODE_READABLE:"
        "The SDK cannot read sce_sys/param.json from the reference package."
        "See $referenceStdoutLog and $referenceStderrLog."
    ) -join " "
    throw "$message`n$referenceSummary"
}
$remastered = "$output.remastered.pkg"
$delta = "$output.delta.pkg"
$builderSource = [IO.Path]::GetFullPath($SourceFolder).TrimEnd(
    [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$iconSource = Join-Path $builderSource "sce_sys\icon0.png"
$staging = $null
$builderExitCode = $null
try {
    if (-not [string]::IsNullOrWhiteSpace($Executable) -or $GenerateUnsignedNptitle) {
        $executablePath = $null
        if (-not [string]::IsNullOrWhiteSpace($Executable)) {
            $executablePath = [IO.Path]::GetFullPath($Executable)
            $executableInfo = Get-Item -LiteralPath $executablePath -Force -ErrorAction Stop
            if ($executableInfo.PSIsContainer -or
                ($executableInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Executable must be a regular file: $executablePath"
            }
            $stream = [IO.File]::OpenRead($executablePath)
            try {
                $magic = New-Object byte[] 4
                if ($stream.Read($magic, 0, 4) -ne 4 -or
                    $magic[0] -ne 0x7f -or $magic[1] -ne 0x45 -or
                    $magic[2] -ne 0x4c -or $magic[3] -ne 0x46) {
                    throw "Executable must be a raw ELF file: $executablePath"
                }
            } finally { $stream.Dispose() }
        }

        $stagingParent = [IO.Path]::GetDirectoryName($builderSource)
        if ([string]::IsNullOrWhiteSpace($stagingParent)) {
            throw "Executable override requires a source folder below a writable parent directory."
        }
        $staging = Join-Path $stagingParent (".native-update-stage-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $staging | Out-Null
        $sourcePrefix = $builderSource + [IO.Path]::DirectorySeparatorChar
        foreach ($directory in Get-ChildItem -LiteralPath $builderSource -Directory -Recurse -Force) {
            if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Executable staging does not accept linked directories: $($directory.FullName)"
            }
            $relative = $directory.FullName.Substring($sourcePrefix.Length)
            New-Item -ItemType Directory -Path (Join-Path $staging $relative) | Out-Null
        }
        foreach ($file in Get-ChildItem -LiteralPath $builderSource -File -Recurse -Force) {
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Executable staging does not accept linked files: $($file.FullName)"
            }
            $relative = $file.FullName.Substring($sourcePrefix.Length)
            $portable = $relative.Replace('\', '/')
            if ($executablePath -and $portable -ieq 'eboot.bin') { continue }
            if ($GenerateUnsignedNptitle -and $portable -ieq 'sce_sys/nptitle.dat') { continue }
            New-Item -ItemType HardLink -Path (Join-Path $staging $relative) -Target $file.FullName | Out-Null
        }
        if ($executablePath) {
            Copy-Item -LiteralPath $executablePath -Destination (Join-Path $staging "eboot.bin")
        }
        if ($GenerateUnsignedNptitle) {
            $nptitle = New-Object byte[] 160
            [Text.Encoding]::ASCII.GetBytes("NPTD").CopyTo($nptitle, 0)
            $nptitle[7] = 0x80
            [Text.Encoding]::ASCII.GetBytes("${TitleId}_00").CopyTo($nptitle, 16)
            [IO.File]::WriteAllBytes((Join-Path $staging "sce_sys\nptitle.dat"), $nptitle)
        }
        $builderSource = $staging
    }

    $builderArgs = @{
        SourceFolder = $builderSource
        OutputPackage = $output
        ReferencePackage = $reference
        CompressionLevel = $CompressionLevel
        Python = $Python
        Force = $Force
    }
    & $builder @builderArgs
    $builderExitCode = $LASTEXITCODE
} finally {
    if ($staging) {
        $resolvedStaging = [IO.Path]::GetFullPath($staging)
        $expectedPrefix = [IO.Path]::GetFullPath($stagingParent).TrimEnd(
            [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) +
            [IO.Path]::DirectorySeparatorChar
        $stagingName = [IO.Path]::GetFileName($resolvedStaging)
        $insideParent = $resolvedStaging.StartsWith(
            $expectedPrefix, [StringComparison]::OrdinalIgnoreCase)
        $isManagedStage = $stagingName.StartsWith(
            ".native-update-stage-", [StringComparison]::Ordinal)
        if (-not $insideParent -or -not $isManagedStage) {
            throw "Refusing to remove unexpected executable staging path: $resolvedStaging"
        }
        if (Test-Path -LiteralPath $resolvedStaging) {
            Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
        }
    }
}
if ($builderExitCode -ne 0) { throw "Package builder failed with exit code $builderExitCode" }
foreach ($created in @($output, $remastered)) {
    if (-not (Test-Path -LiteralPath $created -PathType Leaf)) {
        throw "Package builder did not create: $created"
    }
}

$validationArgs = @(
    "img_verify", "--passcode", ("0" * 32), "--format_check", "on",
    "--integrity_check", "off", "--no_progress_bar", $remastered)
$validation = @(
    & $publisher @validationArgs 2>&1 | ForEach-Object { $_.ToString() })
$validationLog = "$output.validation.log"
[IO.File]::WriteAllText($validationLog, ($validation -join "`n") + "`n", (New-Object Text.UTF8Encoding $false))

$integrityArgs = @(
    "img_verify", "--passcode", ("0" * 32), "--format_check", "off",
    "--integrity_check", "on", "--no_progress_bar", $remastered)
$integrity = @(
    & $publisher @integrityArgs 2>&1 | ForEach-Object { $_.ToString() })
$integrityExit = $LASTEXITCODE
$integrityLog = "$output.integrity.log"
[IO.File]::WriteAllText($integrityLog, ($integrity -join "`n") + "`n", (New-Object Text.UTF8Encoding $false))
if ($integrityExit -ne 0) {
    $errors = ($integrity | Where-Object { $_ -match '^\[Error\]' }) -join "`n"
    if (-not $errors) { $errors = ($integrity | Select-Object -Last 20) -join "`n" }
    throw "Package integrity validation failed (exit $integrityExit). See $integrityLog`n$errors"
}

$layout = (& $publisher img_info $output 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect patch layout.`n$layout" }
function Read-LayoutValue([string]$name) {
    $match = [regex]::Match($layout, "(?m)^$([regex]::Escape($name))\s*:\s*0x[0-9a-fA-F]+\s+\((\d+)\)\s*$")
    if (-not $match.Success) { throw "Patch layout does not report $name." }
    return [Int64]::Parse($match.Groups[1].Value)
}

$scOffset = Read-LayoutValue "SC Offset"
$scSize = Read-LayoutValue "SC Size"
$siOffset = Read-LayoutValue "SI Offset"
$siSize = Read-LayoutValue "SI Size"
$patchSize = (Get-Item -LiteralPath $output).Length
if ($scSize -le 0 -or $siSize -le 0 -or $scOffset + $scSize -ne $siOffset -or $siOffset + $siSize -ne $patchSize) {
    throw "Patch has invalid SC/SI geometry."
}

$temporary = Join-Path ([IO.Path]::GetDirectoryName($output)) (".native-delta-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $subcontainer = Join-Path $temporary "subcontainer.sc"
    $supplemental = Join-Path $temporary "supplemental.si"
    $candidate = Join-Path $temporary "delta.pkg"
    $extract = @'
from pathlib import Path
import sys

source = Path(sys.argv[1])
with source.open("rb") as stream:
    for destination, offset, size in ((sys.argv[2], int(sys.argv[3]), int(sys.argv[4])),
                                      (sys.argv[5], int(sys.argv[6]), int(sys.argv[7]))):
        stream.seek(offset)
        data = stream.read(size)
        if len(data) != size:
            raise SystemExit("short patch region")
        Path(destination).write_bytes(data)
'@
    $extract | & $Python - $output $subcontainer $scOffset $scSize $supplemental $siOffset $siSize
    if ($LASTEXITCODE -ne 0) { throw "Unable to extract patch SC/SI regions." }

    & $converter --delta-patch-convert --subcontainer $subcontainer --supplemental $supplemental --output $candidate
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Delta-distribution conversion failed."
    }

    $checkArgs = @(
        (Join-Path $PSScriptRoot "check-native-update.mjs"),
        $remastered, $BaseContentVersion, $candidate,
        "--title-id", $TitleId, "--icon", $iconSource)
    & node @checkArgs
    if ($LASTEXITCODE -ne 0) { throw "Native update release gate failed." }

    if ((Test-Path -LiteralPath $delta) -and -not $Force) {
        throw "Delta output already exists: $delta (use -Force to replace it)"
    }
    Move-Item -LiteralPath $candidate -Destination $delta -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}

Write-Host "Created PS5 patch: $output"
Write-Host "Created remastered package: $remastered"
Write-Host "Created delta distribution: $delta"
Write-Host "Native update release gate passed."
