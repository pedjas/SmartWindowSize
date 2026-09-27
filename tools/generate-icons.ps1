Add-Type -AssemblyName System.Drawing


function New-RoundedRectanglePath {
  param([System.Drawing.RectangleF]$Rectangle, [single]$Radius)

  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}


function Draw-InwardArrow {
  param([System.Drawing.Graphics]$Graphics, [System.Drawing.PointF]$Start, [System.Drawing.PointF]$End, [System.Drawing.Color]$Color)

  $pen = [System.Drawing.Pen]::new($Color, 9)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $Graphics.DrawLine($pen, $Start, $End)
  $pen.Dispose()

  $dx = $End.X - $Start.X
  $dy = $End.Y - $Start.Y
  $length = [Math]::Sqrt($dx * $dx + $dy * $dy)
  $ux = $dx / $length
  $uy = $dy / $length
  $side = 8
  $back = 12
  $left = [System.Drawing.PointF]::new($End.X - $ux * $back - $uy * $side, $End.Y - $uy * $back + $ux * $side)
  $right = [System.Drawing.PointF]::new($End.X - $ux * $back + $uy * $side, $End.Y - $uy * $back - $ux * $side)
  $brush = [System.Drawing.SolidBrush]::new($Color)
  $Graphics.FillPolygon($brush, @($End, $left, $right))
  $brush.Dispose()
}


function New-IconBitmap {
  param([ValidateSet('active', 'inactive', 'error')][string]$State)

  $bitmap = [System.Drawing.Bitmap]::new(128, 128, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $outerColor = if ($State -eq 'inactive') { [System.Drawing.Color]::FromArgb(255, 105, 105, 105) } else { [System.Drawing.Color]::FromArgb(255, 0, 132, 255) }
  $chromeColor = if ($State -eq 'inactive') { [System.Drawing.Color]::FromArgb(255, 188, 188, 188) } else { [System.Drawing.Color]::FromArgb(255, 168, 216, 255) }
  $arrowColor = [System.Drawing.Color]::FromArgb(255, 35, 57, 82)
  $outerPath = New-RoundedRectanglePath ([System.Drawing.RectangleF]::new(8, 10, 112, 108)) 16
  $graphics.FillPath([System.Drawing.SolidBrush]::new($outerColor), $outerPath)
  $outerPath.Dispose()
  $innerPath = New-RoundedRectanglePath ([System.Drawing.RectangleF]::new(13, 33, 102, 80)) 6
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::White), $innerPath)
  $innerPath.Dispose()

  foreach ($x in @(25, 39, 53)) {
    $graphics.FillEllipse([System.Drawing.SolidBrush]::new($chromeColor), $x - 4, 20, 8, 8)
  }

  Draw-InwardArrow $graphics ([System.Drawing.PointF]::new(40, 45)) ([System.Drawing.PointF]::new(53, 58)) $arrowColor
  Draw-InwardArrow $graphics ([System.Drawing.PointF]::new(88, 45)) ([System.Drawing.PointF]::new(75, 58)) $arrowColor
  Draw-InwardArrow $graphics ([System.Drawing.PointF]::new(40, 98)) ([System.Drawing.PointF]::new(53, 85)) $arrowColor
  Draw-InwardArrow $graphics ([System.Drawing.PointF]::new(88, 98)) ([System.Drawing.PointF]::new(75, 85)) $arrowColor

  if ($State -eq 'error') {
    $graphics.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 220, 38, 38)), 103, 7, 20, 20)
    $font = [System.Drawing.Font]::new('Segoe UI', 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString('!', $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(103, 6, 20, 21), $format)
    $format.Dispose()
    $font.Dispose()
  }

  $graphics.Dispose()
  return $bitmap
}


$iconDirectory = Join-Path $PSScriptRoot '..\icons'
foreach ($state in @('active', 'inactive', 'error')) {
  $master = New-IconBitmap $state
  foreach ($size in @(16, 32, 48, 128)) {
    $output = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($output)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.DrawImage($master, 0, 0, $size, $size)
    $graphics.Dispose()
    $output.Save((Join-Path $iconDirectory "$state-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $output.Dispose()
  }
  $master.Dispose()
}
