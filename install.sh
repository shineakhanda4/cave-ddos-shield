#!/bin/bash

# =============================================================================
# Cave DDoS Shield 
# =============================================================================

clear

echo "════════════════════════════════════════════════════════════════"
echo "         🏔️  CAVE DDoS SHIELD - SIMPLE INSTALLER  🏔️"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Check Node.js
echo "📌 Step 1: Checking Node.js..."
if command -v node &> /dev/null; then
    echo "   ✅ Node.js $(node -v) is installed"
else
    echo "   ❌ Node.js not found!"
    echo ""
    echo "   Please install Node.js from: https://nodejs.org"
    echo "   (Download the LTS version and install it)"
    echo ""
    exit 1
fi

# Install dependencies
echo ""
echo "📌 Step 2: Installing dependencies..."
npm install

# Create .env file
echo ""
echo "📌 Step 3: Creating configuration..."
echo "PORT=1920" > .env
echo "JWT_SECRET=cave-secret-key-$(date +%s)" >> .env

# Done
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "                    ✅ INSTALLATION COMPLETE!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "🚀 To start the dashboard:"
echo "   npm start"
echo ""
echo "📱 Then open in your browser:"
echo "   http://localhost:1920"
echo ""
echo "🔐 Default login:"
echo "   Username: admin"
echo "   Password: admin123"
echo ""
echo "🏔️ The Mountain Protects! 🏔️"
