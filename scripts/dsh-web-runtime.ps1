# Resolve and identify the runtime used by the source Web launcher and its supervisor.
function Resolve-DshNodeRuntime {
  $explicit = $env:DSH_NODE_BIN
  if (-not [string]::IsNullOrWhiteSpace($explicit)) {
    if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) {
      throw "DSH_NODE_BIN does not point at a file: $explicit"
    }
    return (Get-Item -LiteralPath $explicit).FullName
  }
  $candidates = @()
  foreach ($programFiles in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
      $candidates += (Join-Path $programFiles 'nodejs\node.exe')
    }
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $onPath) { throw 'No Node.js runtime found on PATH and no absolute install detected. Set DSH_NODE_BIN.' }
  return $onPath.Source
}

# Match the actual source CLI invocation, not a Node filename or text inside an eval argument.
function Get-DshWebHostProcesses {
  param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$Port
  )
  if (-not ('DshWebRuntimeCommandLine' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DshWebRuntimeCommandLine {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string[] Parse(string commandLine) {
    int count;
    IntPtr pointer=CommandLineToArgvW(commandLine,out count);
    if(pointer==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var arguments=new string[count];
      for(int index=0;index<count;index++)arguments[index]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,index*IntPtr.Size));
      return arguments;
    } finally { LocalFree(pointer); }
  }
}
'@
  }
  $node = [IO.Path]::GetFullPath($NodePath)
  # A Windows filename cannot contain double quotes; this also accepts apostrophes.
  $filter = 'Name = "{0}"' -f [IO.Path]::GetFileName($node)
  Get-CimInstance Win32_Process -Filter $filter | Where-Object {
    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath) -or [string]::IsNullOrWhiteSpace($_.CommandLine)) { return $false }
    if (-not [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $node, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $arguments = [DshWebRuntimeCommandLine]::Parse($_.CommandLine)
    # ensure-dsh-web starts Node with one --import argument, then the source entry and web command.
    if ($arguments.Count -lt 6 -or $arguments[1] -cne '--import' -or
        $arguments[3] -notmatch '(?:^|[\\/])apps[\\/]cli[\\/]src[\\/]bin\.ts$' -or $arguments[4] -cne 'web') { return $false }
    $hostPort = $null
    for ($index=5; $index -lt $arguments.Count; $index++) {
      if ($arguments[$index] -ceq '--port' -and ($index+1) -lt $arguments.Count) { $hostPort = $arguments[++$index]; continue }
      if ($arguments[$index] -cmatch '^--port=(.+)$') { $hostPort = $Matches[1] }
    }
    return $hostPort -ceq [string]$Port
  }
}
