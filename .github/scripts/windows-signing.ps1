<#
Authenticode signing for Windows builds through Azure Artifact Signing.

  setup        Fetch the pinned Artifact Signing dlib, write its metadata.json and a
               Tauri config overlay whose bundle.windows.signCommand calls `sign`.
               Emits `args=--config <overlay>` as a step output.
  sign <file>  Run by the Tauri bundler for each binary, NSIS plugin, uninstaller,
               installer, and MSI, before it creates the updater .sig files.
  verify       Fail unless the installers and main binary have a valid, timestamped
               Authenticode signature.

Authentication uses GitHub OIDC with an Entra federated credential, so no client
secret exists. GitHub's OIDC assertion expires about five minutes after issue and
the Rust build takes longer, so `sign` requests a fresh token for every file.
#>
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet('setup', 'sign', 'verify')]
  [string]$Action,

  [Parameter(Position = 1)]
  [string]$File
)

$ErrorActionPreference = 'Stop'

# Microsoft.ArtifactSigning.Client from nuget.org; the hash pins the exact package.
$DlibVersion = '1.0.128'
$DlibSha256 = '74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b'
$TimestampUrl = 'http://timestamp.acs.microsoft.com'

$WorkDir = Join-Path $env:RUNNER_TEMP 'artifact-signing'
$Dlib = Join-Path $WorkDir 'bin/x64/Azure.CodeSigning.Dlib.dll'
$Metadata = Join-Path $WorkDir 'metadata.json'

function Assert-Env([string[]]$Names) {
  $missing = $Names | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
  if ($missing) {
    throw "Missing Windows signing configuration: $($missing -join ', '). " +
      "The job needs the windows-signing environment and 'id-token: write'."
  }
}

function Get-SignTool {
  # The dlib needs a recent SDK signtool (Microsoft rejects the 20348 SDK); take the newest.
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
    Where-Object { $_.Directory.Parent.Name -match '^\d+(\.\d+){3}$' } |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
  if (-not $signtool) { throw 'signtool.exe not found in the Windows SDK' }
  $signtool.FullName
}

function Invoke-Setup {
  Assert-Env @(
    'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ARTIFACT_SIGNING_ENDPOINT',
    'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE',
    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'
  )
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

  $package = Join-Path $WorkDir 'client.zip'
  Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.ArtifactSigning.Client/$DlibVersion" -OutFile $package
  $hash = (Get-FileHash -Path $package -Algorithm SHA256).Hash
  if ($hash -ne $DlibSha256) { throw "Artifact Signing client hash mismatch: $hash" }
  Expand-Archive -Path $package -DestinationPath $WorkDir -Force
  if (-not (Test-Path $Dlib)) { throw "Azure.CodeSigning.Dlib.dll missing from the client package" }

  # Only the workload identity credential (AZURE_FEDERATED_TOKEN_FILE) may authenticate.
  @{
    Endpoint               = $env:ARTIFACT_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:ARTIFACT_SIGNING_ACCOUNT
    CertificateProfileName = $env:ARTIFACT_SIGNING_PROFILE
    CorrelationId          = "$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
    ExcludeCredentials     = @(
      'ManagedIdentityCredential', 'SharedTokenCacheCredential', 'VisualStudioCredential',
      'VisualStudioCodeCredential', 'AzureCliCredential', 'AzurePowerShellCredential',
      'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'
    )
  } | ConvertTo-Json | Set-Content -Path $Metadata

  # Absolute forward-slash paths survive tauri-action's argument parsing and NSIS's
  # !uninstfinalize, which runs the sign command from another directory.
  $script = $PSCommandPath -replace '\\', '/'
  $overlay = (Join-Path $WorkDir 'tauri.signing.conf.json') -replace '\\', '/'
  @{
    bundle = @{
      windows = @{
        signCommand = @{
          cmd  = 'pwsh'
          args = @('-NoProfile', '-NonInteractive', '-File', $script, 'sign', '%1')
        }
      }
    }
  } | ConvertTo-Json -Depth 5 | Set-Content -Path $overlay

  Write-Host "Signing with $env:ARTIFACT_SIGNING_ACCOUNT/$env:ARTIFACT_SIGNING_PROFILE via $(Get-SignTool)"
  "args=--config $overlay" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}

function Invoke-Sign([string]$Path) {
  if (-not $Path) { throw 'sign requires a file path' }
  Assert-Env @('AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')

  $tokenFile = Join-Path $WorkDir "oidc-$([guid]::NewGuid()).jwt"
  try {
    $response = Invoke-RestMethod `
      -Uri "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=api://AzureADTokenExchange" `
      -Headers @{ Authorization = "Bearer $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN" }
    Set-Content -Path $tokenFile -Value $response.value -NoNewline
    $env:AZURE_FEDERATED_TOKEN_FILE = $tokenFile

    & (Get-SignTool) sign /v /fd SHA256 /tr $TimestampUrl /td SHA256 /dlib $Dlib /dmdf $Metadata $Path
    if ($LASTEXITCODE -ne 0) { throw "signtool exited with $LASTEXITCODE for $Path" }
  }
  finally {
    Remove-Item -Path $tokenFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Verify {
  $files = @(Get-ChildItem -Path @(
      'target/*/release/bundle/nsis/*.exe',
      'target/*/release/bundle/msi/*.msi',
      'target/*/release/Wealthfolio.exe'
    ) -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { throw 'No Windows build outputs found under target/*/release' }

  $unsigned = @()
  foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -FilePath $file.FullName
    $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { 'none' }
    $timestamped = [bool]$signature.TimeStamperCertificate
    Write-Host "$($file.Name): $($signature.Status), timestamped: $timestamped, signer: $signer"
    if ($signature.Status -ne 'Valid' -or -not $timestamped) { $unsigned += $file.Name }
  }
  if ($unsigned) { throw "Not validly signed and timestamped: $($unsigned -join ', ')" }
}

switch ($Action) {
  'setup' { Invoke-Setup }
  'sign' { Invoke-Sign $File }
  'verify' { Invoke-Verify }
}
