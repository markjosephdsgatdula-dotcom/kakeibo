# Regenerates the PNG app icons in ../icons. Run: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$size, [string]$file, [bool]$maskable) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $green = [System.Drawing.ColorTranslator]::FromHtml('#10b981')
  $dark  = [System.Drawing.ColorTranslator]::FromHtml('#047857')
  if ($maskable) {
    $g.Clear($green)
  } else {
    $g.Clear([System.Drawing.Color]::Transparent)
    $r = [int]($size * 0.22); $d = $r * 2; $s = $size - 1
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($s - $d, 0, $d, $d, 270, 90)
    $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90); $path.AddArc(0, $s - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush $green), $path)
  }
  # Ledger book: white page with ruled lines and a coin
  $scale = if ($maskable) { 0.62 } else { 0.78 }
  $w = $size * $scale * 0.72; $h = $size * $scale * 0.86
  $x = ($size - $w) / 2; $y = ($size - $h) / 2
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillRectangle($white, [single]$x, [single]$y, [single]$w, [single]$h)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $dark), [single]$x, [single]$y, [single]($w * 0.12), [single]$h)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#a7f3d0')), ([single]($size * 0.018))
  for ($i = 1; $i -le 4; $i++) {
    $ly = $y + $h * (0.2 + 0.14 * $i)
    $g.DrawLine($pen, [single]($x + $w * 0.22), [single]$ly, [single]($x + $w * 0.88), [single]$ly)
  }
  $c = $size * $scale * 0.34
  $cx = $x + $w - $c * 0.55; $cy = $y + $h * 0.06 - $c * 0.25
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#fbbf24'))), [single]$cx, [single]$cy, [single]$c, [single]$c)
  $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#d97706')), ([single]($size * 0.02))), [single]$cx, [single]$cy, [single]$c, [single]$c)
  $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

# Android notification badge: white silhouette on transparent (Android tints it).
function New-Badge([int]$size, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $w = $size * 0.56; $h = $size * 0.7; $x = $size * 0.16; $y = $size * 0.18
  $g.FillRectangle($white, [single]$x, [single]$y, [single]$w, [single]$h)
  $g.CompositingMode = 'SourceCopy'
  $clear = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Transparent)
  for ($i = 1; $i -le 3; $i++) {
    $g.FillRectangle($clear, [single]($x + $w * 0.22), [single]($y + $h * (0.25 + 0.18 * $i)), [single]($w * 0.62), [single]($size * 0.05))
  }
  $c = $size * 0.36
  $g.FillEllipse($clear, [single]($size * 0.56), [single]($size * 0.04), [single]($c + $size * 0.08), [single]($c + $size * 0.08))
  $g.CompositingMode = 'SourceOver'
  $g.FillEllipse($white, [single]($size * 0.6), [single]($size * 0.08), [single]$c, [single]$c)
  $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Badge 96 'badge-96.png'
New-Icon 192 'icon-192.png' $false
New-Icon 512 'icon-512.png' $false
New-Icon 512 'icon-maskable-512.png' $true
New-Icon 180 'apple-touch-icon.png' $true
Get-ChildItem $out | Select-Object Name, Length
