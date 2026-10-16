param([string]$Directory = 'target/release')
$ErrorActionPreference = 'Stop'
$artifact = Get-ChildItem $Directory -Filter 'koma*.msi' | Select-Object -First 1
if (!$artifact) { throw 'No Koma MSI was built' }
$extract = Join-Path ([IO.Path]::GetTempPath()) ('koma-msi-terminal-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $extract | Out-Null
try {
    $process = Start-Process msiexec.exe -ArgumentList "/a `"$($artifact.FullName)`" /qn TARGETDIR=`"$extract`"" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'MSI administrative extraction failed' }
    $executables = @(Get-ChildItem $extract -Filter koma.exe -Recurse)
    if ($executables.Count -ne 1) { throw 'MSI must contain exactly one koma.exe' }
    $expected = (Get-FileHash (Join-Path $Directory 'koma.exe') -Algorithm SHA256).Hash
    $actual = (Get-FileHash $executables[0].FullName -Algorithm SHA256).Hash
    if ($expected -ne $actual) { throw 'MSI executable differs from the verified executable' }
} finally {
    Remove-Item $extract -Recurse -Force
}
