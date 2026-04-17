#!/bin/bash

# =============================================================================
# Cave DDoS Shield - One-Command VPS Installer
# Repository: https://github.com/shineakhanda4/cave-ddos-shield
# =============================================================================

clear

echo "════════════════════════════════════════════════════════════════"
echo "         🏔️  CAVE DDoS SHIELD - AUTO INSTALLER  🏔️"
echo "════════════════════════════════════════════════════════════════"
echo ""

REPO_URL="https://github.com/shineakhanda4/cave-ddos-shield.git"
INSTALL_DIR="/opt/cave-shield"

# Detect Public IP
echo "📌 Step 1: Detecting server public IP..."
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || curl -s --max-time 5 icanhazip.com 2>/dev/null)

if [ -n "$PUBLIC_IP" ]; then
    echo "   ✅ Public IP: $PUBLIC_IP"
else
    PUBLIC_IP="YOUR_SERVER_IP"
    echo "   ⚠️  Could not detect public IP"
fi

# Check and install Git
echo ""
echo "📌 Step 2: Checking Git..."
if command -v git &> /dev/null; then
    echo "   ✅ Git is installed"
else
    echo "   Installing Git..."
    sudo apt-get update -y > /dev/null 2>&1
    sudo apt-get install -y git > /dev/null 2>&1
    echo "   ✅ Git installed"
fi

# Check Node.js
echo ""
echo "📌 Step 3: Checking Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    echo "   ✅ Node.js $NODE_VERSION is installed"
else
    echo "   Installing Node.js..."
    
    # Detect OS
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
    else
        OS="unknown"
    fi
    
    if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
        sudo apt-get update -y
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "fedora" || "$OS" == "rocky" || "$OS" == "almalinux" ]]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs
    else
        echo "   ❌ Please install Node.js manually: https://nodejs.org/"
        exit 1
    fi
    echo "   ✅ Node.js installed!"
fi

# Clone repository
echo ""
echo "📌 Step 4: Cloning Cave DDoS Shield..."
if [ -d "$INSTALL_DIR" ]; then
    echo "   Directory already exists. Updating..."
    cd "$INSTALL_DIR"
    git pull origin main > /dev/null 2>&1
    echo "   ✅ Repository updated"
else
    echo "   Cloning from GitHub..."
    sudo mkdir -p /opt
    sudo git clone "$REPO_URL" "$INSTALL_DIR" > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo "   ✅ Repository cloned"
    else
        echo "   ⚠️  Could not clone. Creating fresh installation..."
        sudo mkdir -p "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
fi

# Set permissions
sudo chown -R $USER:$USER "$INSTALL_DIR" 2>/dev/null
cd "$INSTALL_DIR"

# Create package.json if missing
echo ""
echo "📌 Step 5: Setting up package.json..."
if [ ! -f "package.json" ]; then
    echo "   Creating package.json..."
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
    echo "   ✅ package.json created"
else
    echo "   ✅ package.json exists"
fi

# Install build tools
echo ""
echo "📌 Step 6: Installing build dependencies..."
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [[ "$ID" == "ubuntu" || "$ID" == "debian" ]]; then
        sudo apt-get update -y > /dev/null 2>&1
        sudo apt-get install -y build-essential python3 > /dev/null 2>&1
    elif [[ "$ID" == "centos" || "$ID" == "rhel" || "$ID" == "fedora" || "$ID" == "rocky" || "$ID" == "almalinux" ]]; then
        sudo yum groupinstall -y "Development Tools" > /dev/null 2>&1
        sudo yum install -y python3 > /dev/null 2>&1
    fi
fi
echo "   ✅ Build tools ready"

# Install npm packages
echo ""
echo "📌 Step 7: Installing npm packages (1-2 minutes)..."
npm install --silent 2>/dev/null

if [ -d "node_modules" ]; then
    echo "   ✅ Packages installed"
else
    echo "   Retrying installation..."
    npm install --force 2>&1 | tail -3
    echo "   ✅ Packages installed"
fi

# Create .env file
echo ""
echo "📌 Step 8: Creating configuration..."
if [ ! -f ".env" ]; then
    JWT_SECRET="cave-secret-$(date +%s)-$(head -c 16 /dev/urandom 2>/dev/null | base64 | tr -dc 'a-zA-Z0-9' 2>/dev/null || echo 'random')"
    
    cat > .env << EOF
PORT=1920
JWT_SECRET=${JWT_SECRET}
NODE_ENV=production
PUBLIC_IP=${PUBLIC_IP}
EOF
    echo "   ✅ Configuration created"
else
    echo "   ✅ Configuration exists"
fi

# Open firewall
echo ""
echo "📌 Step 9: Configuring firewall..."
if command -v ufw > /dev/null 2>&1; then
    sudo ufw allow 1920/tcp > /dev/null 2>&1
    echo "   ✅ Port 1920 opened (UFW)"
elif command -v firewall-cmd > /dev/null 2>&1; then
    sudo firewall-cmd --permanent --add-port=1920/tcp > /dev/null 2>&1
    sudo firewall-cmd --reload > /dev/null 2>&1
    echo "   ✅ Port 1920 opened (FirewallD)"
elif command -v iptables > /dev/null 2>&1; then
    sudo iptables -I INPUT -p tcp --dport 1920 -j ACCEPT > /dev/null 2>&1
    echo "   ✅ Port 1920 opened (iptables)"
fi

# Check application files
echo ""
echo "📌 Step 10: Verifying installation..."
FILES_MISSING=0
for FILE in app.js login.html dashboard.html public.html settings.html change-password.html; do
    if [ ! -f "$FILE" ]; then
        echo "   ⚠️  Missing: $FILE"
        FILES_MISSING=1
    fi
done

if [ $FILES_MISSING -eq 0 ]; then
    echo "   ✅ All files present"
else
    echo "   ⚠️  Some files are missing. Please check the repository."
fi

# Final message
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "                    ✅ INSTALLATION COMPLETE!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📂 Installation Directory: $INSTALL_DIR"
echo ""
echo "🚀 Start the dashboard:"
echo "   cd $INSTALL_DIR"
echo "   npm start"
echo ""
echo "   OR run in background:"
echo "   cd $INSTALL_DIR && nohup npm start > cave.log 2>&1 &"
echo ""
echo "📱 Access your dashboard:"
echo "   🌐 http://$PUBLIC_IP:1920"
echo ""
echo "📋 Direct Links:"
echo "   🔐 Login:     http://$PUBLIC_IP:1920/login.html"
echo "   📊 Dashboard: http://$PUBLIC_IP:1920/dashboard.html"
echo "   👁️  Public:    http://$PUBLIC_IP:1920/public.html"
echo "   ⚙️  Settings:  http://$PUBLIC_IP:1920/settings.html"
echo ""
echo "🔐 Default Credentials:"
echo "   Username: admin"
echo "   Password: admin123"
echo ""
echo "⚠️  CHANGE THE DEFAULT PASSWORD AFTER FIRST LOGIN!"
echo ""
echo "📝 Useful Commands:"
echo "   Stop:      pkill -f 'node app.js'"
echo "   View logs: tail -f $INSTALL_DIR/cave.log"
echo "   Update:    cd $INSTALL_DIR && git pull && npm install"
echo ""
echo "🏔️ The Mountain Protects! 🏔️"
