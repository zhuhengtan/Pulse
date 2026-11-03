; Use the bundled native process plugin instead of a PowerShell/tasklist pipeline.
; Only 603 means absent; enumeration errors must never be reported as a busy app.
!macro customCheckAppRunning
  Push $R0
  ${Do}
    nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    DetailPrint "Pulse process check: $R0"
    ${If} $R0 == 603
      ${Break}
    ${ElseIf} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "检测到 ${APP_EXECUTABLE_FILENAME} 正在运行。请保存工作并退出 Pulse，然后重试。$\r$\n${APP_EXECUTABLE_FILENAME} is running. Save your work and quit Pulse, then retry." /SD IDCANCEL IDRETRY +3
      SetErrorLevel 2
      Quit
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONSTOP "无法检查进程，错误代码：$R0。安装尚未继续。$\r$\nProcess inspection failed (code $R0). Installation has not continued." /SD IDCANCEL IDRETRY +3
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${Loop}
  nsProcess::_Unload
  Pop $R0
!macroend
