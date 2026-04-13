@echo off

pushd %~dp0\dst

cl /WX /W3 /Zi /Od /nologo ..\main.c /link ..\msquic.lib /INCREMENTAL:NO

del *.obj
popd