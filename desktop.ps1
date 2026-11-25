# Small desktop helper for the Task Runner assistant: screenshot, click, type, keys, scroll.
# Called by server.js. Prints one line of JSON.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Out = '',
  [int]$Width = 1280,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Button = 'left',
  [switch]$Double,
  [string]$Text = '',
  [int]$Amount = 3
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Desk {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);

  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  // Visible top-level windows with a title, front-most first, as "pid|title".
  public static string[] ListWindows() {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new System.Text.StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0 || t == "Program Manager") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(pid + "|" + t);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  // Finds the first visible window whose title contains the text and brings it to the front.
  public static string Focus(string part) {
    IntPtr found = IntPtr.Zero; string title = "";
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new System.Text.StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; title = t; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return null;
    if (IsIconic(found)) ShowWindow(found, 9);
    // Windows only lets the program the user last used change focus; a tap of Alt lifts that block.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(found);
    return title;
  }
}
"@
[void][Desk]::SetProcessDPIAware()

function Get-ActiveTitle {
  $sb = New-Object System.Text.StringBuilder 512
  [void][Desk]::GetWindowText([Desk]::GetForegroundWindow(), $sb, 512)
  return $sb.ToString()
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

switch ($Action) {
  'screenshot' {
    $bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmp.Size)
    $w = [Math]::Min($Width, $screen.Width)
    $h = [int]([Math]::Round($screen.Height * $w / $screen.Width))
    $small = New-Object System.Drawing.Bitmap $w, $h
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $w, $h)
    $small.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose()
    @{ ok = $true; width = $w; height = $h; screenWidth = $screen.Width; screenHeight = $screen.Height; window = (Get-ActiveTitle) } | ConvertTo-Json -Compress
  }
  'click' {
    [void][Desk]::SetCursorPos($screen.X + $X, $screen.Y + $Y)
    Start-Sleep -Milliseconds 60
    $down = 0x0002; $up = 0x0004
    if ($Button -eq 'right') { $down = 0x0008; $up = 0x0010 }
    $times = 1; if ($Double) { $times = 2 }
    for ($i = 0; $i -lt $times; $i++) {
      [Desk]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [Desk]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
    }
    Start-Sleep -Milliseconds 300
    @{ ok = $true; window = (Get-ActiveTitle) } | ConvertTo-Json -Compress
  }
  'type' {
    # Escape the characters SendKeys treats as commands.
    $escaped = ($Text.ToCharArray() | ForEach-Object {
      $c = [string]$_
      if ('+^%~(){}[]'.Contains($c)) { '{' + $c + '}' } elseif ($c -eq "`n") { '{ENTER}' } elseif ($c -eq "`r") { '' } else { $c }
    }) -join ''
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    @{ ok = $true; window = (Get-ActiveTitle) } | ConvertTo-Json -Compress
  }
  'keys' {
    # $Text is already in SendKeys form, built by server.js (for example ^s or %{TAB}).
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Start-Sleep -Milliseconds 300
    @{ ok = $true; window = (Get-ActiveTitle) } | ConvertTo-Json -Compress
  }
  'scroll' {
    [void][Desk]::SetCursorPos($screen.X + $X, $screen.Y + $Y)
    [Desk]::mouse_event(0x0800, 0, 0, (-120 * $Amount), [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  'windows' {
    # Visible top-level windows with a title, front-most first, plus their program name.
    # Built by hand: ConvertTo-Json in Windows PowerShell 5.1 mangles arrays nested in objects.
    Add-Type -AssemblyName System.Web
    $enc = { param($s) '"' + [System.Web.HttpUtility]::JavaScriptStringEncode([string]$s) + '"' }
    $names = @{}
    foreach ($p in Get-Process) { $names[[string]$p.Id] = $p.ProcessName }
    $items = foreach ($line in [Desk]::ListWindows()) {
      $parts = $line.Split([char]'|', 2)
      '{"title":' + (& $enc $parts[1]) + ',"app":' + (& $enc $names[$parts[0]]) + '}'
    }
    '{"ok":true,"active":' + (& $enc (Get-ActiveTitle)) + ',"windows":[' + (@($items) -join ',') + ']}'
  }
  'launch' {
    # Start an installed app by (part of) its Start menu name, like "FL Studio" or "Discord".
    $q = $Text.Trim()
    $apps = @(Get-StartApps)
    $hit = $apps | Where-Object { $_.Name -ieq $q } | Select-Object -First 1
    if (-not $hit) { $hit = $apps | Where-Object { $_.Name -like "$q*" } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
    if (-not $hit) { $hit = $apps | Where-Object { $_.Name -like "*$q*" } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
    if (-not $hit) {
      $words = $q -split '\s+' | Where-Object { $_.Length -gt 2 }
      $near = @($apps | Where-Object { $n = $_.Name; ($words | Where-Object { $n -like "*$_*" }).Count -gt 0 } | Select-Object -First 6 -ExpandProperty Name)
      Add-Type -AssemblyName System.Web
      $list = ($near | ForEach-Object { '"' + [System.Web.HttpUtility]::JavaScriptStringEncode($_) + '"' }) -join ','
      '{"ok":false,"near":[' + $list + ']}'
      break
    }
    Start-Process explorer.exe "shell:AppsFolder\$($hit.AppID)"
    @{ ok = $true; name = $hit.Name } | ConvertTo-Json -Compress
  }
  'focus' {
    $title = [Desk]::Focus($Text)
    Start-Sleep -Milliseconds 300
    @{ ok = [bool]$title; matched = $title; window = (Get-ActiveTitle) } | ConvertTo-Json -Compress
  }
  default { throw "Unknown action $Action" }
}
