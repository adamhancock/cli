#!/bin/bash

# Test script to verify OpenCode events are being sent to workstream daemon

echo "🧪 Testing OpenCode → Workstream Event Flow"
echo "============================================"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check prerequisites
echo -e "${BLUE}📋 Checking prerequisites...${NC}"

# Check Redis
if ! redis-cli ping > /dev/null 2>&1; then
    echo -e "${RED}❌ Redis is not running${NC}"
    echo "   Start with: brew services start redis"
    exit 1
fi
echo -e "${GREEN}✓ Redis is running${NC}"

# Check if daemon is running
if ! pgrep -f "workstream-daemon" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Workstream daemon is not running${NC}"
    echo "   Start with: cd packages/workstream-daemon && npm start"
    echo ""
    echo "   Starting daemon in background..."
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$SCRIPT_DIR/../workstream-daemon"
    nohup npm start > /tmp/workstream-daemon.log 2>&1 &
    sleep 3
    echo -e "${GREEN}✓ Daemon started${NC}"
else
    echo -e "${GREEN}✓ Workstream daemon is running${NC}"
fi

echo ""
echo -e "${BLUE}📡 Subscribing to OpenCode events...${NC}"
echo "   (Press Ctrl+C to stop)"
echo ""

# Subscribe to workstream:opencode channel
redis-cli SUBSCRIBE workstream:opencode &
SUBSCRIBE_PID=$!

# Wait a moment for subscription to register
sleep 1

echo ""
echo -e "${BLUE}🚀 Publishing test events...${NC}"
echo ""

# Test 1: Session created
echo -e "${YELLOW}Test 1: Session Created${NC}"
redis-cli PUBLISH workstream:opencode '{
  "type": "opencode_session_created",
  "path": "/tmp/test-project",
  "sessionId": "test-session-123",
  "projectName": "test-project",
  "timestamp": '$(date +%s000)'
}'
sleep 1

# Test 2: Tool execution (bash)
echo -e "${YELLOW}Test 2: Bash Command${NC}"
redis-cli PUBLISH workstream:opencode '{
  "type": "opencode_tool_bash",
  "path": "/tmp/test-project",
  "sessionId": "test-session-123",
  "tool": "bash",
  "args": {"command": "ls -la"},
  "success": true,
  "timestamp": '$(date +%s000)'
}'
sleep 1

# Test 3: File edited
echo -e "${YELLOW}Test 3: File Edited${NC}"
redis-cli PUBLISH workstream:opencode '{
  "type": "opencode_file_edited",
  "path": "/tmp/test-project",
  "sessionId": "test-session-123",
  "filePath": "/tmp/test-project/src/index.ts",
  "timestamp": '$(date +%s000)'
}'
sleep 1

# Test 4: Safety warning
echo -e "${YELLOW}Test 4: Safety Warning${NC}"
redis-cli PUBLISH workstream:opencode '{
  "type": "opencode_safety_warning",
  "path": "/tmp/test-project",
  "sessionId": "test-session-123",
  "rule": "protected-branch",
  "tool": "write",
  "message": "You are on protected branch main",
  "timestamp": '$(date +%s000)'
}'
sleep 1

# Test 5: Session idle
echo -e "${YELLOW}Test 5: Session Idle${NC}"
redis-cli PUBLISH workstream:opencode '{
  "type": "opencode_session_idle",
  "path": "/tmp/test-project",
  "sessionId": "test-session-123",
  "idleTime": 300,
  "timestamp": '$(date +%s000)'
}'
sleep 1

echo ""
echo -e "${GREEN}✅ Test events published!${NC}"
echo ""
echo -e "${BLUE}📊 Check daemon logs:${NC}"
echo "   tail -f /tmp/workstream-daemon.log"
echo ""
echo -e "${BLUE}📊 Check event store:${NC}"
echo "   redis-cli KEYS 'workstream:opencode:session:*'"
echo "   redis-cli GET 'workstream:opencode:session:test-session-123'"
echo ""
echo -e "${BLUE}📊 Check events in database:${NC}"
echo "   sqlite3 ~/.workstream/events.db 'SELECT * FROM events WHERE channel=\"workstream:opencode\" ORDER BY timestamp DESC LIMIT 10'"
echo ""

# Stop subscription after 3 seconds
sleep 3
kill $SUBSCRIBE_PID 2>/dev/null

echo -e "${GREEN}✅ Test complete!${NC}"
