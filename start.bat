@echo off
REM Start een lokale webserver voor de viewer en opent hem in de browser (Windows).
cd /d "%~dp0viewer"
set PORT=8765
start "" "http://localhost:%PORT%/"
where python >nul 2>nul && (python -m http.server %PORT% --bind 127.0.0.1 & goto :eof)
where py >nul 2>nul && (py -m http.server %PORT% --bind 127.0.0.1 & goto :eof)
where npx >nul 2>nul && (npx --yes serve -l %PORT% . & goto :eof)
echo Geen Python of Node gevonden. Installeer Python via python.org en start opnieuw.
pause
