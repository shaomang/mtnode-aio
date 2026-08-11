; 自定义安装器脚本（assisted 向导模式）：
; 1. 默认安装到 %LOCALAPPDATA%\Programs\MTNodeAIO（合适的默认文件夹名，用户可在向导中更改）
; 2. 安装完成后自动打开应用（由 MUI_FINISHPAGE_RUN 勾选框控制，默认勾选）
!macro customInit
  ; 覆盖默认目录名为干净的 ASCII 文件夹名（electron-builder 默认用 productName）
  StrCpy $INSTDIR "$LocalAppData\Programs\MTNodeAIO"
!macroend
