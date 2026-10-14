$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PulseInput {
 [StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint type; public UNION data;}
 [StructLayout(LayoutKind.Explicit)] public struct UNION {[FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key;}
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE {public int x,y; public uint data,flags,time; public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct KEY {public ushort vk,scan; public uint flags,time; public UIntPtr extra;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public static void Key(ushort vk,ushort scan,uint flags) {var value=new INPUT {type=1};value.data.key=new KEY {vk=vk,scan=scan,flags=flags};Send(value);}
 public static void Mouse(uint flags,int data=0) {var value=new INPUT {type=0};value.data.mouse=new MOUSE {flags=flags,data=unchecked((uint)data)};Send(value);}
 static void Send(INPUT value) {if(SendInput(1,new[]{value},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("INPUT_BLOCKED_OR_UIPI");}
}
'@
[PulseInput]::SetProcessDPIAware() | Out-Null
$script:elements = @{}
$script:screen = [Windows.Forms.Screen]::PrimaryScreen
$script:held = [Collections.Generic.List[UInt16]]::new()
function Release-Input {
 foreach ($key in $script:held) { try { [PulseInput]::Key($key,0,2) } catch {} }
 $script:held.Clear()
 try { [PulseInput]::Mouse(4); [PulseInput]::Mouse(16) } catch {}
}
function Geometry { $b=$script:screen.Bounds; return "$($script:screen.DeviceName):$($b.X):$($b.Y):$($b.Width):$($b.Height):$([PulseInput]::GetForegroundWindow())" }
function Move-Point($point) {
 if ($null -eq $point -or $point.x -lt 0 -or $point.x -gt 1 -or $point.y -lt 0 -or $point.y -gt 1) { throw 'INVALID_POINT' }
 $b=$script:screen.Bounds
 if (-not [PulseInput]::SetCursorPos([int]($b.X+$point.x*($b.Width-1)),[int]($b.Y+$point.y*($b.Height-1)))) { throw 'INPUT_BLOCKED' }
}
function Walk-Element($element,$depth,$lines) {
 if ($depth -gt 8 -or $script:elements.Count -ge 250) { return }
 try {
  $id="e$($script:elements.Count)"; $script:elements[$id]=$element
  $current=$element.Current
  $lines.Add("[$id] $($current.ControlType.ProgrammaticName) $($current.Name)")
  $children=$element.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  foreach ($child in $children) { Walk-Element $child ($depth+1) $lines }
 } catch {}
}
function Observe {
 $b=$script:screen.Bounds
 $bitmap=[Drawing.Bitmap]::new($b.Width,$b.Height)
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 try {
  $graphics.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size)
  $scale=[Math]::Min(1,1600/[Math]::Max($b.Width,$b.Height))
  $small=[Drawing.Bitmap]::new($bitmap,[int]($b.Width*$scale),[int]($b.Height*$scale))
  $stream=[IO.MemoryStream]::new()
  try { $small.Save($stream,[Drawing.Imaging.ImageFormat]::Jpeg); $data=[Convert]::ToBase64String($stream.ToArray()) } finally { $stream.Dispose();$small.Dispose() }
 } finally { $graphics.Dispose();$bitmap.Dispose() }
 $script:elements=@{};$lines=[Collections.Generic.List[string]]::new()
 $focused=[Windows.Automation.AutomationElement]::FocusedElement
 if ($focused) { Walk-Element $focused 0 $lines }
 return @{width=[int]($b.Width*$scale);height=[int]($b.Height*$scale);geometry=(Geometry);text=($lines -join "`n");image=@{mediaType='image/jpeg';data=$data}}
}
function Call-Desktop($method,$p) {
 if ($p.displayId) { $selected=[Windows.Forms.Screen]::AllScreens | Where-Object DeviceName -eq $p.displayId; if (-not $selected) { throw 'DISPLAY_NOT_AVAILABLE' };$script:screen=$selected }
 switch ($method) {
  { $_ -in 'hello','doctor' } { return @{protocolVersion=1;platform='win32';screenCapture=[Environment]::UserInteractive;input=[Environment]::UserInteractive;accessibility=$true} }
  'release' { Release-Input;return @{released=$true} }
  'displays' { return @([Windows.Forms.Screen]::AllScreens | ForEach-Object { @{id=$_.DeviceName;x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height} }) }
  'windows' { return @([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object { @{id="$($_.Current.NativeWindowHandle)";title=$_.Current.Name} }) }
  'selectWindow' { if (-not [PulseInput]::SetForegroundWindow([IntPtr][long]$p.windowId)) { throw 'WINDOW_FOCUS_DENIED' };return @{selected=$true} }
  'observe' { return Observe }
  'act' {
   if ($p.geometry -ne (Geometry)) { throw 'STALE_GEOMETRY' }
   $a=$p.action
   try {
    switch ($a.type) {
     'click' { Move-Point $a.point;for($i=0;$i -lt $a.count;$i++){if($a.button -eq 'right'){[PulseInput]::Mouse(8);[PulseInput]::Mouse(16)}else{[PulseInput]::Mouse(2);[PulseInput]::Mouse(4)}} }
     'drag' { Move-Point $a.from;[PulseInput]::Mouse(2);for($i=1;$i -le 20;$i++){Move-Point @{x=($a.from.x+($a.to.x-$a.from.x)*$i/20);y=($a.from.y+($a.to.y-$a.from.y)*$i/20)};Start-Sleep -Milliseconds 10};[PulseInput]::Mouse(4) }
     'scroll' { Move-Point $a.point;if($a.dy){[PulseInput]::Mouse(2048,(-[int]$a.dy))};if($a.dx){[PulseInput]::Mouse(4096,[int]$a.dx)} }
     'type' { foreach($char in $a.text.ToCharArray()){[PulseInput]::Key(0,[UInt16]$char,4);[PulseInput]::Key(0,[UInt16]$char,6)} }
     'key' {
      $map=@{Meta=91;Command=91;Control=17;Ctrl=17;Alt=18;Shift=16;Enter=13;Return=13;Tab=9;Escape=27;Backspace=8;Delete=46;ArrowLeft=37;ArrowUp=38;ArrowRight=39;ArrowDown=40;Space=32;Home=36;End=35;PageUp=33;PageDown=34}
      foreach($name in $a.keys){if($map.ContainsKey($name)){$key=[UInt16]$map[$name]}elseif($name.Length -eq 1){$key=[UInt16][char]$name.ToUpperInvariant()}else{throw 'UNSUPPORTED_KEY'};$script:held.Add($key);[PulseInput]::Key($key,0,0)}
     }
     'element' {
      $element=$script:elements[$a.ref];if(-not $element){throw 'STALE_ELEMENT'}
      if($a.operation -eq 'click'){$element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()}
      elseif($a.operation -eq 'fill'){$element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue([string]$a.value)}
      else{throw 'ELEMENT_OPERATION_UNSUPPORTED'}
     }
     default { throw 'UNSUPPORTED_ACTION' }
    }
   } finally { Release-Input }
   $script:elements=@{};return @{applied=$true}
  }
  default { throw 'UNKNOWN_METHOD' }
 }
}
try {
 while ($null -ne ($line=[Console]::ReadLine())) {
  $id=$null
  try { if($line.Length -gt 65536){throw 'REQUEST_TOO_LARGE'};$request=$line | ConvertFrom-Json;$id=$request.id;$result=Call-Desktop $request.method $request.params;$response=@{jsonrpc='2.0';id=$id;result=$result} }
  catch { Release-Input;$response=@{jsonrpc='2.0';id=$id;error=@{message=$_.Exception.Message}} }
  [Console]::WriteLine(($response | ConvertTo-Json -Depth 30 -Compress))
 }
} finally { Release-Input }
