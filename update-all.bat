@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Refresh every map in maps\ from its live source server, then rebuild data\.
rem  Source is chosen by filename prefix (see the log below):
rem      "f ..."  ->  OpenGeofiction (fictional)
rem      "r ..."  ->  OpenStreetMap   (real)
rem  Same area as before (a true refresh). To enlarge one map, use extend.py.
rem ---------------------------------------------------------------------------

python update.py
echo.
pause
