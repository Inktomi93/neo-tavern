#!/usr/bin/env bash
# Live swipe/edit verification over the curl debug harness — STOP CLAIMING, MEASURE.
# Boots an isolated server (fresh temp DB, spare port, DEBUG_TOKEN), then drives the real flow:
#   create (with greeting) → send (real sub turn) → swipe (real regen) → selectVariant → editMessage
# reading back tRPC results + /api/_debug after each, then tears down.
#
#   bash scripts/swipe-edit-probe.sh
# Auth: host `claude login` (Max sub) — swipe/send do REAL generations. Costs a few sub turns.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8799}"
TOKEN="${DEBUG_TOKEN:-swipeprobe}"
DB="/tmp/neo-swipe-probe.db"
B="localhost:${PORT}"
rm -f "${DB}"*

echo "── booting isolated server on :${PORT} (temp DB) ──"
DEBUG_TOKEN="$TOKEN" PORT="$PORT" DATABASE_URL="file:${DB}" LOG_LEVEL=info \
  pnpm exec tsx src/server/index.ts > /tmp/neo-swipe-probe.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; rm -f "${DB}"*' EXIT

for _ in $(seq 1 60); do curl -sf -m1 "$B/api/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf -m1 "$B/api/healthz" >/dev/null 2>&1 || { echo "server never came up"; tail -20 /tmp/neo-swipe-probe.log; exit 1; }
echo "  up."

# tRPC helpers (non-batched). Mutations = POST with the input as the JSON body.
mut() { curl -s -X POST -H 'content-type: application/json' -d "$2" "$B/api/trpc/$1"; }
qry() { curl -s "$B/api/trpc/$1?input=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$2")"; }
data() { python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['result']['data'], indent=0))"; }

echo "── 1. create a chat with a greeting ──"
CHAT=$(mut chat.create '{"title":"Probe","characterName":"Aria","characterDescription":"a warm tavern keeper","firstMessage":"*Aria waves* Welcome to the Gilded Griffin!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['data']['chatId'])")
echo "  chatId=$CHAT"
echo "  messages after create:"; qry chat.messages "{\"chatId\":\"$CHAT\"}" | python3 -c "import sys,json;[print('   seq',m['seq'],m['role'],repr(m['content'][:40]),'variants=',m['variantCount']) for m in json.load(sys.stdin)['result']['data']]"

echo "── 2. send a user message (real sub turn) ──"
mut chat.send "{\"chatId\":\"$CHAT\",\"expectedSeq\":1,\"content\":\"Hi Aria! What's on tap tonight?\"}" >/dev/null
qry chat.messages "{\"chatId\":\"$CHAT\"}" | python3 -c "import sys,json;[print('   seq',m['seq'],m['role'],repr(m['content'][:50]),'variants=',m['variantCount']) for m in json.load(sys.stdin)['result']['data']]"

echo "── 3. SWIPE the last assistant turn (real regen → new variant) ──"
mut chat.swipe "{\"chatId\":\"$CHAT\",\"expectedSeq\":3}" >/dev/null
qry chat.messages "{\"chatId\":\"$CHAT\"}" | python3 -c "import sys,json
ms=json.load(sys.stdin)['result']['data']
tip=ms[-1]
print('   tip seq',tip['seq'],'activeVariantIdx=',tip['activeVariantIdx'],'variantCount=',tip['variantCount'])
print('   active text:',repr(tip['content'][:70]))"

echo "── 4. selectVariant back to idx 0 (no model call) ──"
TIPID=$(qry chat.messages "{\"chatId\":\"$CHAT\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['data'][-1]['id'])")
mut chat.selectVariant "{\"chatId\":\"$CHAT\",\"messageId\":\"$TIPID\",\"variantIdx\":0}" | python3 -c "import sys,json
tip=json.load(sys.stdin)['result']['data'][-1]
print('   after select idx0: activeVariantIdx=',tip['activeVariantIdx'],'text=',repr(tip['content'][:70]))"

echo "── 5. editMessage (edit the user message in place) ──"
USERID=$(qry chat.messages "{\"chatId\":\"$CHAT\"}" | python3 -c "import sys,json;print([m for m in json.load(sys.stdin)['result']['data'] if m['role']=='user'][0]['id'])")
mut chat.editMessage "{\"chatId\":\"$CHAT\",\"messageId\":\"$USERID\",\"content\":\"Hi Aria! [edited] What do you recommend?\"}" | python3 -c "import sys,json
u=[m for m in json.load(sys.stdin)['result']['data'] if m['role']=='user'][0]
print('   edited user msg:',repr(u['content'][:50]))"

echo "── 6. /api/_debug: the chat operations that fired (metadata only) ──"
curl -s -H "x-debug-token: $TOKEN" "$B/api/_debug/logs?q=chat:&limit=40" | python3 -c "import sys,json;[print('   ',l.get('msg')) for l in json.load(sys.stdin)['logs'] if l.get('msg','').startswith('chat:')]" | sort | uniq -c
echo "── errors during the run (should be none) ──"
curl -s -H "x-debug-token: $TOKEN" "$B/api/_debug/errors?limit=10" | python3 -c "import sys,json;d=json.load(sys.stdin);print('   error count:',d['count'])"
echo "done."
