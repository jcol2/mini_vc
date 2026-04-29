@echo off

setlocal enabledelayedexpansion
@REM read first line
for /f "usebackq delims=" %%A in ("%~dp0\certs\fingerprint.hex") do (
 set "cert_fingerprint=%%A"
 goto :fingerprint_done
)
:fingerprint_done

@REM prod build (no minify)
@REM esbuild main_worker.ts --bundle --minify --outfile=main_worker.txt  --log-level=warning --sourcemap=inline
@REM esbuild main.ts --bundle --minify --outdir=.  --log-level=warning --sourcemap=inline

@REM debug build
esbuild main_worker.ts --bundle --outfile=main_worker.txt  --log-level=warning --sourcemap=inline --define:CertFingerprint=\"%cert_fingerprint%\"
esbuild main.ts --bundle --outdir=.  --log-level=warning --sourcemap=inline
cl /nologo /P /EP /C index_template.html /Fiindex.html

endlocal