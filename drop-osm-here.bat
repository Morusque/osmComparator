@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Drop one or more .osm files onto this .bat to add/update them in the tool:
rem  each file is copied into maps\ and data\ is rebuilt. Dropping a file whose
rem  name already exists in maps\ updates that map. With no file dropped, it
rem  just rebuilds data\ from whatever is already in maps\.
rem
rem  (Later: extend/merge a dropped map with extra data under some conditions.)
rem ---------------------------------------------------------------------------

if "%~1"=="" (
    echo No file dropped - just rebuilding data\ from maps\ ...
    echo.
    python prepare.py
    goto done
)

echo Adding dropped .osm file^(s^) to maps\ ...
for %%F in (%*) do (
    if /I "%%~xF"==".osm" (
        if /I "%%~fF"=="%~dp0maps\%%~nxF" (
            echo   "%%~nxF" is already in maps\ - will just rebuild it
        ) else (
            echo   copying "%%~nxF"
            copy /Y "%%~fF" "maps\%%~nxF" >nul
        )
    ) else (
        echo   skipping "%%~nxF" ^(not a .osm file^)
    )
)

echo.
echo Rebuilding data\ from maps\ ...
echo.
python prepare.py

:done
echo.
echo Done. Reload the browser ^(serve.py picks up the change automatically^).
echo.
pause
