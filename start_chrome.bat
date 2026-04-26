@echo off

@REM https://stackoverflow.com/questions/57498386/sslkeylogfile-environment-variable-doesnt-populate-any-text-file
@REM https://wiki.wireshark.org/TLS#tls-decryption

@REM start chrome --enable-features=EnableWebTransportDraft07

set SSLKEYLOGFILE=%~dp0\sslkeylogfile.log
start chrome https://127.0.0.1:5500/tools/client.html
start chrome https://127.0.0.1:5501/
