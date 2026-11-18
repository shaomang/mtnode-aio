; ============================================================================
; MTNode NSIS 更新流程探针 —— 一次性验证工具
;   不是打包产物，也不进 test/ 自动跑清单；按需跑 run-probe.ps1。
;
; 做什么：把本项目 installer.nsh 的三只宏（customInstallMode / customFinishPage /
;   customInstall）连同 electron-builder 生成的 flag 宏（isUpdated 等，原文见
;   node_modules/app-builder-lib/out/targets/nsis/NsisScriptGenerator.js:29-40，
;   flags 列表见 NsisTarget.js:579）放进一只最小 MUI2 安装器真跑。
;   页序照抄 assistedInstaller.nsh（assisted + allowToChangeInstallationDirectory:true）；
;   section 只往 %TEMP%\mtnode-nsis-probe 写文件：不写注册表、不建快捷方式、不碰系统目录。
;
; 记录口径：
;   · <probe>\pages.log            —— 每页真正显示时追加一行；没有 SHOW 行 = 该页被跳过
;   · <probe>\startapp-called.txt  —— StartApp 被调用时由 fake-app.cmd 写入（代替真的拉起应用）
;   · 进程是否自己退出 / 退出码     —— 由 run-probe.ps1 记录
; ============================================================================
Unicode true

; —— 路径：run-probe.ps1 用 /D 覆盖；未传时用本机默认值，便于手工 makensis ——
!ifndef NSIS_TEMPLATES
  !define NSIS_TEMPLATES "E:\dev\tools\pipeline-console\node_modules\app-builder-lib\templates\nsis"
!endif
!ifndef NSIS_PLUGINS
  !define NSIS_PLUGINS "C:\Users\shaom\AppData\Local\electron-builder\Cache\nsis-resources-3.4.1\nsis-resources-3.4.1-2jx2y\plugins\x86-unicode"
!endif
!ifndef PROJECT_INSTALLER_NSH
  !define PROJECT_INSTALLER_NSH "E:\dev\tools\pipeline-console\installer.nsh"
!endif
!ifndef PROBE_ROOT
  !define PROBE_ROOT "$TEMP\mtnode-nsis-probe"
!endif

!define APP_FILENAME "MTNodeProbe"
; 注意：不能自己 !define INSTALL_SECTION_ID —— 它是 Section 语句的输出（NSIS 把节索引写进这个名）。
; electron-builder 按 build.json 的 nsis 配置额外 define 的几个（NsisTarget.js:439-448）：
;   oneClick:false + perMachine:false → INSTALL_MODE_PER_ALL_USERS_REQUIRED 有、INSTALL_MODE_PER_ALL_USERS 无
;   allowToChangeInstallationDirectory:true → allowToChangeInstallationDirectory
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define allowToChangeInstallationDirectory
!define APP_64
; 一定不存在的注册表键：customInstallMode / multiUser.nsh 只会「读」它（读到空 = 无既有安装）
!define INSTALL_REGISTRY_KEY "Software\MTNode-NsisProbe-DoesNotExist"
!define UNINSTALL_REGISTRY_KEY "Software\MTNode-NsisProbe-DoesNotExist"

!addincludedir "${NSIS_TEMPLATES}"
!addincludedir "${NSIS_TEMPLATES}\include"
!addplugindir /x86-unicode "${NSIS_PLUGINS}"

; 注意：electron-builder 是「脚本走 stdin + cwd = nsisTemplatesDir」，所以模板里裸写
; !include "multiUser.nsh" 命中 electron-builder 自带那只；本探针从文件路径编译，裸写会
; 命中 NSIS 自带的 Include\MultiUser.nsh（完全另一套宏，也就是 UAC_IsInnerInstance 未定义
; 的那种编译错），故这几只一律写绝对路径。
!include "MUI2.nsh"
!include "x64.nsh"    ; multiUser.nsh 的 setInstallModePerAllUsers 用 ${RunningX64}（模板里由 common.nsh 带入）
!include "${NSIS_TEMPLATES}\include\StdUtils.nsh"
!include "${NSIS_TEMPLATES}\include\StrContains.nsh"
!include "${NSIS_TEMPLATES}\multiUser.nsh"
!include "${NSIS_TEMPLATES}\multiUserUi.nsh"
!include "${__FILEDIR__}\probe-langs.nsh"

; ============================================================================
; electron-builder 生成的 flag 宏（原文照抄 NsisScriptGenerator.flags：
;   !macro _<Var> _a _b _t _f / ${StdUtils.TestParameter} $R9 "<flag>" /
;   StrCmp "$R9" "true" `${_t}` `${_f}` / !macroend / !define <Var> `"" <Var> ""`）
; ============================================================================
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`

!macro _isForceRun _a _b _t _f
  ${StdUtils.TestParameter} $R9 "force-run"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForceRun `"" isForceRun ""`

!macro _isKeepShortcuts _a _b _t _f
  ${StdUtils.TestParameter} $R9 "keep-shortcuts"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isKeepShortcuts `"" isKeepShortcuts ""`

!macro _isNoDesktopShortcut _a _b _t _f
  ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isNoDesktopShortcut `"" isNoDesktopShortcut ""`

!macro _isDeleteAppData _a _b _t _f
  ${StdUtils.TestParameter} $R9 "delete-app-data"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isDeleteAppData `"" isDeleteAppData ""`

!macro _isForAllUsers _a _b _t _f
  ${StdUtils.TestParameter} $R9 "allusers"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForAllUsers `"" isForAllUsers ""`

!macro _isForCurrentUser _a _b _t _f
  ${StdUtils.TestParameter} $R9 "currentuser"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForCurrentUser `"" isForCurrentUser ""`

; ============================================================================
; 被验证的真身：项目 installer.nsh（customInit / customInstallMode /
; customFinishPage / customInstall 全在里面，原样 include，不复制、不改写）
; ============================================================================
!include "${PROJECT_INSTALLER_NSH}"

; ============================================================================
; 探针自身的记录设施
; ============================================================================
Name "MTNode 更新探针"
Caption "MTNode 更新探针"
!ifdef PROBE_NOABORT
  OutFile "${__FILEDIR__}\build\probe-noabort.exe"
!else
  OutFile "${__FILEDIR__}\build\probe.exe"
!endif
RequestExecutionLevel user
ShowInstDetails show
Var launchLink

Function probeLogLine ; $1 = 要写的行
  ; 注意：这只 NSIS 3.04 的 FileOpen "a" 不会真的定位到文件尾 —— 隔离试验里连续写三行，
  ; 结果是三行都从偏移 0 压过去、只剩残缺内容；必须再 FileSeek 到 END 才是追加。
  FileOpen $0 "${PROBE_ROOT}\pages.log" a
  FileSeek $0 0 END
  FileWrite $0 "$1$\r$\n"
  FileClose $0
FunctionEnd

!macro probeLog text
  StrCpy $1 "${text}"
  Call probeLogLine
!macroend

Function probeShowInstallMode
  !insertmacro probeLog "PAGE 安装模式页 SHOW"
FunctionEnd

Function probeShowDirectory
  !insertmacro probeLog "PAGE 目录页 SHOW"
FunctionEnd

Function probeShowInstFiles
  !insertmacro probeLog "PAGE 进度页 SHOW"
FunctionEnd

Function probeShowFinish
  !insertmacro probeLog "PAGE 完成页 SHOW"
FunctionEnd

; ============================================================================
; 页序：照抄 assistedInstaller.nsh（assisted + allowToChangeInstallationDirectory:true）
;   每页挂 SHOW 钩子记日志；跳页逻辑仍由被测宏自己决定（这里只做记录，不干预）
; ============================================================================

; ① 安装模式页 —— 更新时由 customInstallMode 逼定 $isForce*Install，
;    multiUserUi.nsh 的 PRE 随后 Abort 掉这一页
!define MUI_PAGE_CUSTOMFUNCTION_SHOW probeShowInstallMode
!insertmacro PAGE_INSTALL_MODE

; ② 目录页 —— 更新时由 skipPageIfUpdated 跳过
;    （宏本体复制自模板 common.nsh:110-121，assistedInstaller.nsh 就是这么用的）
!macro probeSkipPageIfUpdated
  !define UniqueID ${__LINE__}
  Function skipPageIfUpdated_${UniqueID}
    ${if} ${isUpdated}
      Abort
    ${endif}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE skipPageIfUpdated_${UniqueID}
  !undef UniqueID
!macroend
!insertmacro probeSkipPageIfUpdated
!define MUI_PAGE_CUSTOMFUNCTION_SHOW probeShowDirectory
!insertmacro MUI_PAGE_DIRECTORY

; ③ 进度页（MUI_INSTFILESPAGE_PROGRESSBAR colored 已由 installer.nsh 定义）
!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre
Function instFilesPre
  ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
  ${If} $0 == ""
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${endIf}
  ; 探针专用兜底（真身没有这一行）：不管安装模式页 / 注册表 / /D 算出什么路径，
  ; 安装目标一律压回 %TEMP%，保证这只假安装器永远碰不到系统目录。
  StrCpy $INSTDIR "${PROBE_ROOT}\MTNodeProbe"
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_SHOW probeShowInstFiles
!insertmacro MUI_PAGE_INSTFILES

; ④ 完成页
!define MUI_PAGE_CUSTOMFUNCTION_SHOW probeShowFinish
!ifdef PROBE_NOABORT
  ; 对照变体：不装 customFinishPage，改用 assistedInstaller.nsh 的 !else 分支原文
  ; =「如果不 Abort 跳页、只靠 SetAutoClose，会是什么样」
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!else
  !insertmacro customFinishPage
!endif

!insertmacro MUI_LANGUAGE English

Function .onInit
  CreateDirectory "${PROBE_ROOT}"

  ${GetParameters} $R2
  StrCpy $1 "onInit params=[$R2]"
  Call probeLogLine
  ${If} ${isUpdated}
    StrCpy $1 "onInit isUpdated=1"
  ${Else}
    StrCpy $1 "onInit isUpdated=0"
  ${EndIf}
  Call probeLogLine

  ; 真身 .onInit 走 assistedInstaller.nsh 的 initMultiUser。本探针不带 /allusers|/currentuser、
  ; 注册表里也没有既有安装，initMultiUser 必然落到 ${else} → setInstallModePerUser 那一支；
  ; 这里直接调那一支（+ 两个 has* 变量置 0），效果等价，又不必把 assistedInstaller.nsh
  ; 整只 include 进来（否则它会自己再插一遍页序）。
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "0"
  !insertmacro setInstallModePerUser

  ; 探针不插 customInit：那只宏只决定 $INSTDIR（还会指到 %LOCALAPPDATA%\Programs），
  ; 与页序无关；本探针限定只写临时目录，故统一由 /D 把 $INSTDIR 钉在 %TEMP% 下。
  StrCpy $launchLink "${PROBE_ROOT}\fake-app.cmd"
  StrCpy $1 "onInit INSTDIR=$INSTDIR installMode=$installMode launchLink=$launchLink"
  Call probeLogLine
FunctionEnd

Section "install" INSTALL_SECTION_ID
  StrCpy $1 "SECTION enter INSTDIR=$INSTDIR"
  Call probeLogLine

  SetOutPath $INSTDIR
  FileOpen $0 "$INSTDIR\probe-a.txt" w
  FileWrite $0 "probe-a$\r$\n"
  FileClose $0
  FileOpen $0 "$INSTDIR\probe-b.txt" w
  FileWrite $0 "probe-b$\r$\n"
  FileClose $0
  FileOpen $0 "$INSTDIR\probe-c.txt" w
  FileWrite $0 "probe-c$\r$\n"
  FileClose $0
  ; 让进度页停留一会儿，便于肉眼确认「只剩进度页」
  Sleep 1500

  ; customInstall 在 electron-builder 里的位置：installSection.nsh:81-83（铺完文件之后）
  StrCpy $1 "SECTION before customInstall"
  Call probeLogLine
  !insertmacro customInstall
  StrCpy $1 "SECTION exit"
  Call probeLogLine
SectionEnd
