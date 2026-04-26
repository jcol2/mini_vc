@echo off

@REM https://stackoverflow.com/questions/57498386/sslkeylogfile-environment-variable-doesnt-populate-any-text-file
@REM https://wiki.wireshark.org/TLS#tls-decryption

set SSLKEYLOGFILE=%~dp0\sslkeylogfile.log
start firefox https://127.0.0.1:5500/tools/client.html
start firefox https://127.0.0.1:5501/