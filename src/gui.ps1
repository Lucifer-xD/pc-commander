param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$X = -1, [int]$Y = -1,
  [string]$Button = 'left',
  [string]$Text = '',
  [int]$Amount = 3
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class U {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@

function Click([string]$btn) {
  switch ($btn) {
    'left'   { [U]::mouse_event(0x02,0,0,0,0); [U]::mouse_event(0x04,0,0,0,0) }
    'right'  { [U]::mouse_event(0x08,0,0,0,0); [U]::mouse_event(0x10,0,0,0,0) }
    'middle' { [U]::mouse_event(0x20,0,0,0,0); [U]::mouse_event(0x40,0,0,0,0) }
  }
}

switch ($Action) {
  'move'   { [void][U]::SetCursorPos($X, $Y) }
  'click'  { if ($X -ge 0) { [void][U]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 60 }; Click $Button }
  'double' { if ($X -ge 0) { [void][U]::SetCursorPos($X, $Y); Start-Sleep -Milliseconds 60 }; Click 'left'; Start-Sleep -Milliseconds 90; Click 'left' }
  'type'   { [System.Windows.Forms.SendKeys]::SendWait($Text) }
  'keys'   { [System.Windows.Forms.SendKeys]::SendWait($Text) }
  'scroll' { [U]::mouse_event(0x0800, 0, 0, [uint32]([int]($Amount * 120)), 0) }
  'where'  { $p = New-Object U+POINT; [void][U]::GetCursorPos([ref]$p); "$($p.X),$($p.Y)" }
}
