@echo off

setlocal enabledelayedexpansion
@REM read first line
for /f "usebackq delims=" %%A in ("%~dp0\certs\thumbprint.hex") do (
 set "cert_thumbprint=%%A"
 goto :thumbprint_done
)
:thumbprint_done

pushd %~dp0\dst

cl /WX /W4 /wd4100 /wd4057 /wd4189 /Zi /Od /nologo /I ".." /DCertThumbprint=\"%cert_thumbprint%\" ..\main.c /link ..\msquic.lib /INCREMENTAL:NO

del *.obj
popd

endlocal