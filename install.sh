#!/bin/bash

# =============================================================================
# Cave DDoS Shield - VPS Installer with Public IP Detection
# =============================================================================

clear

echo "════════════════════════════════════════════════════════════════"
echo "         🏔️  CAVE DDoS SHIELD - VPS INSTALLER  🏔️"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Detect Public IP
echo "📌 Step 1: Detecting server IP..."
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s ipinfo.io/ip 2>/dev/null || curl -s icanhazip.com 2>/dev/null)

if [ -n "$PUBLIC_IP" ]; then
    echo "   ✅ Public IP: $PUBLIC_IP"
else
    PUBLIC_IP="YOUR_SERVER_IP"
    echo "   ⚠️  Could not detect public IP"
fi

# Check Node.js
echo ""
echo "📌 Step 2: Checking Node.js..."
if command -v node &> /dev/null; then
    echo "   ✅ Node.js $(node -v) is installed"
else
    echo "   ❌ Node.js not found!"
    echo ""
    echo "   Installing Node.js automatically..."
    
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        if [[ "$ID" == "ubuntu" || "$ID" == "debian" ]]; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - &> /dev/null
            sudo apt-get install -y nodejs &> /dev/null
        elif [[ "$ID" == "centos" || "$ID" == "rhel" || "$ID" == "fedora" ]]; then
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - &> /dev/null
            sudo yum install -y nodejs &> /dev/null
        else
            echo "   ❌ Please install Node.js manually: https://nodejs.org/"
            exit 1
        fi
    fi
    echo "   ✅ Node.js installed!"
fi

echo ""
echo "📌 Step 3: Installing dependencies..."
echo "   This may take a minute..."

# Check if package.json exists
if [ ! -f "package.json" ]; then
    cat > package.json << 'EOF'
{
  "name": "cave-ddos-shield",
  "version": "2.1.0",
  "description": "Advanced DDoS protection system with cave theme",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
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
fi

# Install build tools if needed
if ! command -v make &> /dev/null; then
    echo "   Installing build tools..."
    sudo apt-get update -qq &> /dev/null
    sudo apt-get install -y build-essential python3 -qq &> /dev/null
fi

npm install --silent 2>/dev/null
echo "   ✅ Packages installed"

echo ""
echo "📌 Step 4: Creating configuration..."
JWT_SECRET=$(cat /dev/urandom 2>/dev/null | tr -dc 'a-zA-Z0-9' | fold -w 48 | head -n 1 || echo "cave-secret-$(date +%s)")

cat > .env << EOF
PORT=1920
JWT_SECRET=$JWT_SECRET
NODE_ENV=production
PUBLIC_IP=$PUBLIC_IP
EOF
echo "   ✅ Configuration created"

echo ""
echo "📌 Step 5: Setting up firewall..."
# Open port 1920
if command -v ufw &> /dev/null; then
    sudo ufw allow 1920/tcp &> /dev/null
    echo "   ✅ Firewall rule added (UFW)"
elif command -v firewall-cmd &> /dev/null; then
    sudo firewall-cmd --permanent --add-port=1920/tcp &> /dev/null
    sudo firewall-cmd --reload &> /dev/null
    echo "   ✅ Firewall rule added (FirewallD)"
elif command -v iptables &> /dev/null; then
    sudo iptables -I INPUT -p tcp --dport 1920 -j ACCEPT
    echo "   ✅ Firewall rule added (iptables)"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "                    ✅ INSTALLATION COMPLETE!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "🚀 To start the dashboard:"
echo "   cd $SCRIPT_DIR"
echo "   npm start"
echo ""
echo "📱 Access from anywhere:"
echo "   🌐 http://$PUBLIC_IP:1920"
echo ""
echo "📋 Direct Links:"
echo "   🔐 Login:     http://$PUBLIC_IP:1920/login.html"
echo "   📊 Dashboard: http://$PUBLIC_IP:1920/dashboard.html"
echo "   👁️  Public:    http://$PUBLIC_IP:1920/public.html"
echo ""
echo "🔐 Default login:"
echo "   Username: admin"
echo "   Password: admin123"
echo ""
echo "⚠️  IMPORTANT: Change the default password immediately!"
echo ""
echo "🏔️ The Mountain Protects! 🏔️"
