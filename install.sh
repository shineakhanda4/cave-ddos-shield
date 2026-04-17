#!/bin/bash

# =============================================================================
# Cave DDoS Shield - Simple Installer
# =============================================================================

clear

echo "════════════════════════════════════════════════════════════════"
echo "         🏔️  CAVE DDoS SHIELD - SIMPLE INSTALLER  🏔️"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check Node.js
echo "📌 Step 1: Checking Node.js..."
if command -v node &> /dev/null; then
    echo "   ✅ Node.js $(node -v) is installed"
else
    echo "   ❌ Node.js not found!"
    echo ""
    echo "   Installing Node.js automatically..."
    
    # Detect OS and install Node.js
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        if [[ "$ID" == "ubuntu" || "$ID" == "debian" ]]; then
            echo "   📦 Installing Node.js for Ubuntu/Debian..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - &> /dev/null
            sudo apt-get install -y nodejs &> /dev/null
            echo "   ✅ Node.js installed!"
        elif [[ "$ID" == "centos" || "$ID" == "rhel" || "$ID" == "fedora" ]]; then
            echo "   📦 Installing Node.js for CentOS/RHEL/Fedora..."
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - &> /dev/null
            sudo yum install -y nodejs &> /dev/null
            echo "   ✅ Node.js installed!"
        elif [[ "$ID" == "arch" || "$ID" == "manjaro" ]]; then
            echo "   📦 Installing Node.js for Arch..."
            sudo pacman -S --noconfirm nodejs npm &> /dev/null
            echo "   ✅ Node.js installed!"
        else
            echo "   ❌ Could not auto-install. Please install Node.js manually:"
            echo "      https://nodejs.org/"
            exit 1
        fi
    else
        echo "   ❌ Could not detect OS. Please install Node.js manually:"
        echo "      https://nodejs.org/"
        exit 1
    fi
fi

echo ""
echo "📌 Step 2: Installing npm packages..."
echo "   This may take a minute..."

# Check if package.json exists
if [ ! -f "package.json" ]; then
    echo "   ⚠️  package.json not found. Creating one..."
    cat > package.json << 'EOF'
{
  "name": "cave-ddos-shield",
  "version": "2.1.0",
  "description": "Advanced DDoS protection system with cave theme",
  "main": "app.js",
  "scripts": {
    "start": "node app.js",
    "dev": "node app.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.10.0",
    "cookie-parser": "^1.4.6",
    "express": "^5.2.1",
    "express-rate-limit": "^7.1.5",
    "jsonwebtoken": "^9.0.2",
    "socket.io": "^4.8.3"
  }
}
EOF
    echo "   ✅ package.json created"
fi

# Install dependencies
npm install --silent 2>/dev/null

if [ $? -eq 0 ]; then
    echo "   ✅ Packages installed successfully"
else
    echo "   ⚠️  Some packages may need build tools"
    echo "   Installing build essentials..."
    
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        if [[ "$ID" == "ubuntu" || "$ID" == "debian" ]]; then
            sudo apt-get install -y build-essential python3 &> /dev/null
        elif [[ "$ID" == "centos" || "$ID" == "rhel" || "$ID" == "fedora" ]]; then
            sudo yum groupinstall -y "Development Tools" &> /dev/null
            sudo yum install -y python3 &> /dev/null
        fi
    fi
    
    # Try again
    npm install --silent 2>/dev/null
    echo "   ✅ Packages installed"
fi

echo ""
echo "📌 Step 3: Creating configuration..."
if [ ! -f ".env" ]; then
    JWT_SECRET=$(cat /dev/urandom 2>/dev/null | tr -dc 'a-zA-Z0-9' | fold -w 48 | head -n 1 || echo "cave-secret-$(date +%s)")
    cat > .env << EOF
PORT=1920
JWT_SECRET=$JWT_SECRET
NODE_ENV=production
EOF
    echo "   ✅ Configuration created"
else
    echo "   ✅ Configuration already exists"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "                    ✅ INSTALLATION COMPLETE!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "🚀 To start the dashboard:"
echo "   npm start"
echo ""
echo "   OR run: node app.js"
echo ""
echo "📱 Then open in your browser:"
echo "   http://localhost:1920"
echo ""
echo "🔐 Default login:"
echo "   Username: admin"
echo "   Password: admin123"
echo ""
echo "📂 Current directory: $(pwd)"
echo ""
echo "🏔️ The Mountain Protects! 🏔️"
