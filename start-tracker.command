#!/bin/bash

cd "$(dirname "$0")" || exit 1

if curl -sf http://127.0.0.1:8787/api/state >/dev/null 2>&1; then
  open "http://127.0.0.1:8787"
  exit 0
fi

node server.js &
SERVER_PID=$!

sleep 1
open "http://127.0.0.1:8787"

wait "$SERVER_PID"
