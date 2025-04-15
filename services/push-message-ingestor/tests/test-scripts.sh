# Test scripts for push-message-ingestor service
# Usage: ./test-scripts-fixed.sh <base_url>
# Example: ./test-scripts-fixed.sh http://localhost:8787

# Check if base URL is provided
if [ -z "$1" ]; then
  echo "Error: Base URL is required"
  echo "Usage: ./test-scripts-fixed.sh <base_url>"
  echo "Example: ./test-scripts-fixed.sh http://localhost:8787"
  exit 1
fi

BASE_URL=$1
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

echo "=== Testing push-message-ingestor service at $BASE_URL ==="
echo ""

# Test 1: Base endpoint
echo "=== Test 1: Base endpoint ==="
echo "GET /"
curl -s "$BASE_URL/" | jq
echo ""
echo ""

# Test 2: Health check endpoint
echo "=== Test 2: Health check endpoint ==="
echo "GET /health"
curl -s "$BASE_URL/health" | jq
echo ""
echo ""

# Test 3.1: Valid message payload
echo "=== Test 3.1: Valid message payload ==="
echo "POST /publish/telegram/messages"
curl -s -X POST "$BASE_URL/publish/telegram/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "id": "msg123",
        "timestamp": "'"$TIMESTAMP"'",
        "platform": "telegram",
        "content": "Hello, this is a test message",
        "metadata": {
          "chatId": "chat123",
          "messageId": "telegramMsg123",
          "fromUserId": "user123",
          "fromUsername": "testuser"
        }
      }
    ]
  }' | jq
echo ""
echo ""

# Test 3.2: Invalid message payload (missing required fields)
echo "=== Test 3.2: Invalid message payload (missing required fields) ==="
echo "POST /publish/telegram/messages"
curl -s -X POST "$BASE_URL/publish/telegram/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "id": "msg123",
        "timestamp": "'"$TIMESTAMP"'",
        "platform": "telegram",
        "content": "Hello, this is a test message",
        "metadata": {
          "fromUserId": "user123",
          "fromUsername": "testuser"
        }
      }
    ]
  }' | jq
echo ""
echo ""

# Test 3.3: Empty message array
echo "=== Test 3.3: Empty message array ==="
echo "POST /publish/telegram/messages"
curl -s -X POST "$BASE_URL/publish/telegram/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": []
  }' | jq
echo ""
echo ""

# Test 3.4: Multiple messages in a single request
echo "=== Test 3.4: Multiple messages in a single request ==="
echo "POST /publish/telegram/messages"
curl -s -X POST "$BASE_URL/publish/telegram/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "id": "msg123",
        "timestamp": "'"$TIMESTAMP"'",
        "platform": "telegram",
        "content": "Hello, this is message 1",
        "metadata": {
          "chatId": "chat123",
          "messageId": "telegramMsg123",
          "fromUserId": "user123",
          "fromUsername": "testuser"
        }
      },
      {
        "id": "msg124",
        "timestamp": "'"$TIMESTAMP"'",
        "platform": "telegram",
        "content": "Hello, this is message 2",
        "metadata": {
          "chatId": "chat123",
          "messageId": "telegramMsg124",
          "fromUserId": "user123",
          "fromUsername": "testuser"
        }
      }
    ]
  }' | jq
echo ""
echo ""

# Test 3.5: Mixed valid and invalid messages
echo "=== Test 3.5: Mixed valid and invalid messages ==="
echo "POST /publish/telegram/messages"
curl -s -X POST "$BASE_URL/publish/telegram/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "id": "msg123",
        "timestamp": "'"$TIMESTAMP"'",
        "platform": "telegram",
        "content": "Hello, this is a valid message",
        "metadata": {
          "chatId": "chat123",
          "messageId": "telegramMsg123",
          "fromUserId": "user123",
          "fromUsername": "testuser"
        }
      },
      {
        "id": "msg124",
        "timestamp": "'"$TIMESTAMP"'",
        "platform": "telegram",
        "content": "Hello, this is an invalid message",
        "metadata": {
          "fromUserId": "user123",
          "fromUsername": "testuser"
        }
      }
    ]
  }' | jq
echo ""
echo ""

echo "=== All tests completed ==="
