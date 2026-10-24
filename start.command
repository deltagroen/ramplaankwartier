#!/bin/bash
# Start een lokale webserver voor de viewer en opent hem in de browser (macOS/Linux).
# De viewer moet via http:// worden geopend; direct dubbelklikken op index.html werkt niet (browserbeveiliging).
cd "$(dirname "$0")/viewer"
PORT=8765
URL="http://localhost:$PORT/"
( sleep 1; open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null ) &
echo "Viewer draait op $URL  (sluit dit venster of druk Ctrl+C om te stoppen)"
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v npx >/dev/null 2>&1; then
  npx --yes serve -l "$PORT" .
else
  echo "Geen python3 of node gevonden. Installeer Python (python.org) en start opnieuw."; read -r
fi
