#!/bin/bash
cd "$(dirname "$0")"

echo "========================================="
echo "  Pingnet — Dev Build"
echo "========================================="
echo ""

# Check for required tools
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org"
  read -p "Press Enter to close..."
  exit 1
fi

if ! command -v cargo &>/dev/null; then
  echo "❌ Rust/Cargo not found. Install from https://rustup.rs"
  read -p "Press Enter to close..."
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "❌ npm not found."
  read -p "Press Enter to close..."
  exit 1
fi

echo "✅ Node $(node --version)"
echo "✅ Cargo $(cargo --version)"
echo ""
echo "📦 Installing npm dependencies..."
npm install

echo ""
echo "🔪 Clearing port 1420..."
lsof -ti:1420 | xargs kill -9 2>/dev/null || true
sleep 1

echo "🚀 Starting Tauri dev server..."
echo ""
echo "   ⚠️  If this is your first run since adding SSH:"
echo "   The ssh2 crate compiles OpenSSL from source (~3–5 min first time)."
echo "   Subsequent builds will be much faster."
echo ""
npm run tauri dev
