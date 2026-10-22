# Window management for PC Commander (Windows). Prints JSON on stdout.
#   -Action list
#   -Action control -Match <title or process> -Op focus|minimize|maximize|restore|close|move [-X -Y -W -H]
#   -Action launch -Name <app, path or Start-menu name> [-Arguments <args>]
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Match = '', [string]$Op = '', [string]$Name = '', [string]$Arguments = '',
  [int]$X = -1, [int]$Y = -1, [int]$W = -1, [int]$H = -1
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PcWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> TopLevel() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && GetWindow(h, 4) == IntPtr.Zero) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(GetWindowTextLength(h) + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  public static void Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // ALT tap lifts the foreground lock
    BringWindowToTop(h); SetForegroundWindow(h);
  }
}
'@

function Describe($h) {
  $procId = [uint32]0; [void][PcWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $proc = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }
  $r = New-Object PcWin+RECT; [void][PcWin]::GetWindowRect($h, [ref]$r)
  $state = if ([PcWin]::IsIconic($h)) { 'minimized' } elseif ([PcWin]::IsZoomed($h)) { 'maximized' } else { 'normal' }
  [ordered]@{ title = [PcWin]::Title($h); process = $proc; pid = [int]$procId; state = $state; x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top; handle = [int64]$h }
}

switch ($Action) {
  'list' {
    $all = @([PcWin]::TopLevel() | ForEach-Object { Describe $_ } | Where-Object { $_.title -notin @('Program Manager', 'Windows Input Experience') })
    ConvertTo-Json -InputObject $all -Depth 3 -Compress
  }
  'control' {
    $m = $Match.ToLower()
    $wins = @([PcWin]::TopLevel() | ForEach-Object { Describe $_ } | Where-Object { $_.title.ToLower().Contains($m) -or $_.process.ToLower() -eq $m -or $_.process.ToLower() -eq ($m -replace '\.exe$', '') })
    # Best match first: a Store app's outer frame (its inner window only floats free while minimized),
    # then an exact title, then the rest in z-order.
    $i = 0; foreach ($item in $wins) { $item.order = $i++ }   # (names are case-insensitive: never reuse $x/$y/$w/$h here)
    $wins = @($wins | Sort-Object -Property @{ Expression = { if ($_.process -eq 'ApplicationFrameHost') { 0 } else { 1 } } }, @{ Expression = { if ($_.title.ToLower() -eq $m) { 0 } else { 1 } } }, @{ Expression = { $_.order } })
    if (-not $wins.Count) { throw "No open window matches '$Match'. Call list_windows to see the open windows." }
    $win = $wins[0]; $hwnd = [IntPtr]$win.handle
    switch ($Op) {
      'focus'    { [PcWin]::Focus($hwnd) }
      'minimize' { [void][PcWin]::ShowWindow($hwnd, 6) }
      'maximize' { [void][PcWin]::ShowWindow($hwnd, 3) }
      'restore'  { [void][PcWin]::ShowWindow($hwnd, 9) }
      'close'    { [void][PcWin]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
      'move'     {
        if ([PcWin]::IsIconic($hwnd) -or [PcWin]::IsZoomed($hwnd)) { [void][PcWin]::ShowWindow($hwnd, 9) }
        $nx = if ($X -ge 0) { $X } else { $win.x }; $ny = if ($Y -ge 0) { $Y } else { $win.y }
        $nw = if ($W -gt 0) { $W } else { $win.width }; $nh = if ($H -gt 0) { $H } else { $win.height }
        [void][PcWin]::MoveWindow($hwnd, $nx, $ny, $nw, $nh, $true)
      }
      default { throw "Unknown window operation '$Op'." }
    }
    Start-Sleep -Milliseconds 250
    $after = if ($Op -eq 'close') { $null } else { Describe $hwnd }
    ConvertTo-Json -InputObject ([ordered]@{ window = $win.title; process = $win.process; op = $Op; matches = $wins.Count; now = $after }) -Depth 3 -Compress
  }
  'launch' {
    $target = $Name.Trim()
    $how = 'start'
    try {
      if ($Arguments) { Start-Process -FilePath $target -ArgumentList $Arguments } else { Start-Process -FilePath $target }
    } catch {
      # not an exe or path: look the name up in the Start menu (covers Store apps)
      $app = Get-StartApps | Where-Object { $_.Name -like "*$target*" } | Select-Object -First 1
      if (-not $app) { throw "Could not find an app called '$target' (not a program, path or Start-menu entry)." }
      Start-Process -FilePath "shell:AppsFolder\$($app.AppID)"
      $target = $app.Name; $how = 'start-menu'
    }
    ConvertTo-Json -InputObject ([ordered]@{ launched = $target; via = $how }) -Compress
  }
  default { throw "Unknown action '$Action'." }
}
