#!/usr/bin/env bash
# Does an sdk-mode SWIPE bust the cached prefix? — STOP CLAIMING, MEASURE, over the curl harness.
# A swipe re-seeds a FRESH session (new sessionId) from canon. The static character prefix is
# byte-identical to the original send's, and Anthropic's cache is content-addressed (1h TTL) — so
# the swipe SHOULD still read it. This boots a server, creates a chat with a BIG character prefix
# (well over the cache floor), runs send → swipe → send, and reads cacheRead/cacheCreation per turn
# from /api/_debug. Needs a cached-sized prefix or the numbers are all 0.
#
#   bash scripts/sdk-cache-probe.sh
# Auth: host `claude login`. Real sub turns.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"; TOKEN="${DEBUG_TOKEN:-cacheprobe}"; DB="/tmp/neo-cache-probe.db"; B="localhost:${PORT}"
rm -f "${DB}"*

DEBUG_TOKEN="$TOKEN" PORT="$PORT" DATABASE_URL="file:${DB}" LOG_LEVEL=info \
  pnpm exec tsx src/server/index.ts > /tmp/neo-cache-probe.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; rm -f "${DB}"*' EXIT
for _ in $(seq 1 60); do curl -sf -m1 "$B/api/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
echo "server up on :$PORT"

mut() { curl -s -X POST -H 'content-type: application/json' -d "$2" "$B/api/trpc/$1"; }

# Create a chat with a BIG character description (→ a large cacheable static system prefix).
CHAT=$(python3 - "$B" <<'PY'
import json,sys,urllib.request
desc = "Aria is the warm, sharp-tongued keeper of the Gilded Griffin tavern. " + \
       ("She remembers every regular, pours a generous measure, never forgets a slight, and speaks in vivid sensory prose. " * 70)
body = json.dumps({"title":"Cache","characterName":"Aria","characterDescription":desc}).encode()
req = urllib.request.Request(f"http://{sys.argv[1]}/api/trpc/chat.create", body, {"content-type":"application/json"})
print(json.load(urllib.request.urlopen(req))["result"]["data"]["chatId"])
PY
)
echo "chatId=$CHAT (big character prefix)"

echo "── send (turn 1, fresh) ──";  mut chat.send "{\"chatId\":\"$CHAT\",\"expectedSeq\":0,\"content\":\"Hello Aria.\"}" >/dev/null
echo "── swipe (re-seeds a fresh session, regenerates) ──"; mut chat.swipe "{\"chatId\":\"$CHAT\",\"expectedSeq\":2}" >/dev/null
echo "── send (turn 2, resumes the post-swipe session) ──"; mut chat.send "{\"chatId\":\"$CHAT\",\"expectedSeq\":2,\"content\":\"Tell me a short tale.\"}" >/dev/null

echo "── cache tokens per turn (from /api/_debug — claude: turn complete) ──"
curl -s -H "x-debug-token: $TOKEN" "$B/api/_debug/logs?q=claude:%20turn%20complete&limit=40" | python3 -c "
import sys,json
logs=[l for l in json.load(sys.stdin)['logs'] if l.get('msg')=='claude: turn complete']
logs=list(reversed(logs))  # oldest first
for i,l in enumerate(logs,1):
    print(f'  turn {i}: tokensIn={l.get(\"tokensIn\")} cacheRead={l.get(\"cacheReadTokens\")} cacheCreate(5m={l.get(\"cacheCreation5mTokens\")},1h={l.get(\"cacheCreation1hTokens\")})')
print()
print('  → swipe is cache-CHEAP if its turn + the post-swipe send show cacheRead>0 (the static prefix survived the re-seed).')
print('  → swipe BUSTS cache if those turns show cacheRead=0 + cacheCreation re-paying the whole prefix.')
"
