#!/bin/bash
# Stop the Character Tavern server running inside WSL.
set -u
if pkill -f 'experimental-strip-types src/server.ts'; then
  echo "Character Tavern stopped in WSL."
else
  echo "No running Character Tavern in WSL."
fi
