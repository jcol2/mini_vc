@echo off

pushd %~dp0\dst

cl /WX /W4 /wd4100 /wd4057 /wd4189 /Zi /Od /nologo /I ".." ..\main.c /link ..\msquic.lib /INCREMENTAL:NO

del *.obj
popd