@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Programs installed after this window (or the app that opened it) started are missing
rem from its PATH, so add the usual install locations of Node.js and ffmpeg ourselves.
set "PATH=%ProgramFiles%\nodejs;%PATH%"
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*") do for /d %%E in ("%%~D\ffmpeg-*") do set "PATH=%%~E\bin;%PATH%"

where node >nul 2>nul || (echo Node.js bulunamadı. Kurulu olduğundan emin ol. & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo ffmpeg bulunamadı. Kurulu olduğundan emin ol. & pause & exit /b 1)
if not exist "worker\.venv\Scripts\python.exe" (echo worker\.venv yok. README'deki worker kurulumunu yap. & pause & exit /b 1)

if not exist "node_modules" (
  echo Paketler kuruluyor...
  call npm install || (pause & exit /b 1)
)
if not exist "web\dist\index.html" (
  echo Arayüz derleniyor...
  call npm run build || (pause & exit /b 1)
)

echo counteroke başlıyor: sunucu ve worker ayrı pencerelerde açılacak.
start "counteroke sunucu" cmd /k npm start
start "counteroke worker" cmd /k worker\.venv\Scripts\python.exe -u worker\worker.py
timeout /t 3 /nobreak >nul
start "" http://localhost:3100
