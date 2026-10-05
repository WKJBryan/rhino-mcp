# Capture the real Rhino window (PrintWindow) — ground truth for visual QA.
# CaptureToBitmap/ViewCaptureToFile return stale frames on Rhino 9 WIP.
param(
  [string]$OutPath = "C:\Users\bryan\XiaomiMiMoProjects\rhino-mcp\captures\window_$(Get-Date -Format yyyyMMdd_HHmmss).png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class RhinoWinCapture {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static Bitmap Cap(IntPtr hWnd) {
    RECT r; GetWindowRect(hWnd, out r);
    int w = r.Right - r.Left; int h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0) return null;
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      PrintWindow(hWnd, hdc, 2); // PW_RENDERFULLCONTENT
      g.ReleaseHdc(hdc);
    }
    return bmp;
  }
}
"@

$p = Get-Process -Name Rhino -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Error "Rhino not running"; exit 1 }
$h = $p.MainWindowHandle
if ($h -eq 0) { Write-Error "No Rhino main window"; exit 1 }

[RhinoWinCapture]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 350
$bmp = [RhinoWinCapture]::Cap($h)
if (-not $bmp) { Write-Error "PrintWindow failed"; exit 1 }
$dir = Split-Path $OutPath -Parent
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$info = @{ path = $OutPath; width = $bmp.Width; height = $bmp.Height; pid = $p.Id; hwnd = $h }
$bmp.Dispose()
$info | ConvertTo-Json -Compress
