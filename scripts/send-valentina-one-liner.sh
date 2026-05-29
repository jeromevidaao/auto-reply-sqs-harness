#!/bin/bash
# One-liner friendly way to send the reply once you have a working token

TOKEN="${HOSPITABLE_BEARER_TOKEN:-$1}"

if [ -z "$TOKEN" ]; then
  echo "Usage:"
  echo "  HOSPITABLE_BEARER_TOKEN=your-token-here ./send-valentina-one-liner.sh"
  echo "  or"
  echo "  ./send-valentina-one-liner.sh your-token-here"
  exit 1
fi

curl -s -X POST \
  "https://public.api.hospitable.com/v2/conversations/54a01055-447d-4461-bfe8-5efc76d5dcb2/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "You'\''re welcome! If you have any other questions before or during your stay, just let us know. Safe travels!"}' \
  | cat

echo ""
echo "Check the thread: https://my.hospitable.com/inbox/thread/54a01055-447d-4461-bfe8-5efc76d5dcb2"
