#!/bin/bash

# Qalox Backend - Start with Documentation
# This script starts the development server and automatically opens Swagger UI in the browser

echo "🚀 Starting Qalox Backend Server with Documentation..."
echo ""
echo "Configuration:"
echo "  ✅ ENABLE_DOCS=true (Documentation enabled)"
echo "  📍 Server: http://localhost:3000"
echo "  📚 Docs: http://localhost:3000/docs"
echo ""

# Enable documentation
export ENABLE_DOCS="true"
export NODE_ENV="development"

# Wait for server to start, then open docs
(
  sleep 3
  echo "📖 Opening Swagger UI in browser..."

  # Detect OS and open browser accordingly
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    open "http://localhost:3000/docs"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    xdg-open "http://localhost:3000/docs" 2>/dev/null || echo "Please open http://localhost:3000/docs manually"
  elif [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "msys" ]]; then
    # Windows
    start "http://localhost:3000/docs"
  else
    echo "Please open http://localhost:3000/docs manually"
  fi
) &

# Start the development server
npm run dev
