@echo off

@REM prod build (no minify)
@REM esbuild main_worker.ts --bundle --minify --outfile=main_worker.txt  --log-level=warning --sourcemap=inline
@REM esbuild main.ts --bundle --minify --outdir=.  --log-level=warning --sourcemap=inline

@REM debug build
esbuild main_worker.ts --bundle --outfile=main_worker.txt  --log-level=warning --sourcemap=inline
esbuild main.ts --bundle --outdir=.  --log-level=warning --sourcemap=inline
cl /nologo /P /EP /C index_template.html /Fiindex.html
