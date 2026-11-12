@echo off
REM Demo app Flutter tren dien thoai Sharp SH-M19 qua cap USB-C, chieu len cua so may tinh de chia se qua Google Meet.
REM Cach dung: cam cap USB-C, mo khoa dien thoai, chay file nay (bam doi). Cua so "MachVon - dien thoai" hien ra: chia se cua so do trong Google Meet.
setlocal
set ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe
set SCRCPY=%USERPROFILE%\scrcpy\scrcpy-win64-v5.0.1\scrcpy.exe
set SERIAL=356660110224186

echo [1/3] Noi cong demo cho dien thoai (47311 API, 47312 dang nhap thu)...
"%ADB%" -s %SERIAL% reverse tcp:47311 tcp:47311
"%ADB%" -s %SERIAL% reverse tcp:47312 tcp:47312

echo [2/3] Mo ung dung Mach Von tren dien thoai...
"%ADB%" -s %SERIAL% shell monkey -p vn.machvon.app -c android.intent.category.LAUNCHER 1 >nul 2>&1

echo [3/3] Chieu man hinh dien thoai len may tinh (dong cua so de dung)...
REM --stay-awake: man hinh khong tat khi dang sac; --no-audio: khong chuyen tieng; --max-size: gioi han do phan giai cho muot qua Meet.
"%SCRCPY%" -s %SERIAL% --window-title "MachVon - dien thoai" --stay-awake --no-audio --max-size 1280
endlocal
