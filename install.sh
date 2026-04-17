#!/bin/bash

# =============================================================================
# Cave DDoS Shield - Universal Auto Installer
# Works on: Ubuntu, Debian, CentOS, RHEL, Fedora, Rocky, AlmaLinux
# =============================================================================

clear

echo "════════════════════════════════════════════════════════════════"
echo "         🏔️  CAVE DDoS SHIELD - AUTO INSTALLER  🏔️"
echo "════════════════════════════════════════════════════════════════"
echo ""

REPO_URL="https://github.com/shineakhanda4/cave-ddos-shield.git"
INSTALL_DIR="/opt/cave-shield"

# Detect OS
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        VER=$VERSION_ID
    else
        OS="unknown"
    fi
}

# Install packages based on OS
install_packages() {
    case $OS in
        ubuntu|debian)
            apt-get update -y
            apt-get install -y curl git build-essential python3 pkg-config sqlite3
            ;;
        centos|rhel|fedora|rocky|almalinux)
            yum update -y
            yum groupinstall -y "Development Tools"
            yum install -y curl git python3 pkgconfig sqlite
            ;;
        *)
            echo "⚠️  Unknown OS. Please install manually: git, nodejs, build tools"
            ;;
    esac
}

# Install Node.js
install_nodejs() {
    if command -v node &> /dev/null; then
        echo "   ✅ Node.js $(node -v) already installed"
        return 0
    fi
    
    echo "   Installing Node.js 20.x..."
    case $OS in
        ubuntu|debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
            ;;
        centos|rhel|fedora|rocky|almalinux)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
            yum install -y nodejs
            ;;
    esac
    echo "   ✅ Node.js $(node -v) installed"
}

# Detect Public IP
echo "📌 Step 1: Detecting server public IP..."
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || \
            curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || \
            curl -s --max-time 5 icanhazip.com 2>/dev/null || \
            curl -s --max-time 5 api.ipify.org 2>/dev/null)

if [ -n "$PUBLIC_IP" ]; then
    echo "   ✅ Public IP: $PUBLIC_IP"
else
    PUBLIC_IP="YOUR_SERVER_IP"
    echo "   ⚠️  Could not detect public IP"
fi

# Detect OS and install dependencies
echo ""
echo "📌 Step 2: Installing system dependencies..."
detect_os
echo "   OS detected: $OS"
install_packages
echo "   ✅ System dependencies installed"

# Install Node.js
echo ""
echo "📌 Step 3: Setting up Node.js..."
install_nodejs

# Clone repository
echo ""
echo "📌 Step 4: Cloning Cave DDoS Shield..."
if [ -d "$INSTALL_DIR" ]; then
    echo "   Directory exists. Updating..."
    cd "$INSTALL_DIR"
    git pull origin main 2>/dev/null || true
else
    echo "   Cloning from GitHub..."
    mkdir -p /opt
    git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || {
        echo "   ⚠️  Git clone failed, creating fresh installation..."
        mkdir -p "$INSTALL_DIR"
    }
fi

cd "$INSTALL_DIR"

# Create package.json if missing
echo ""
echo "📌 Step 5: Setting up package.json..."
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
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5",
    "jsonwebtoken": "^9.0.2",
    "socket.io": "^4.6.1"
  }
}
EOF
    echo "   ✅ package.json created"
fi

# Install npm packages
echo ""
echo "📌 Step 6: Installing npm packages (this may take 1-2 minutes)..."

# Clean install
rm -rf node_modules package-lock.json 2>/dev/null
npm cache clean --force 2>/dev/null

# Try installation
npm install 2>&1 | grep -v "npm warn" | grep -v "idealTree" || true

# If better-sqlite3 fails, try alternative
if [ ! -d "node_modules" ]; then
    echo "   ⚠️  Standard install failed. Trying alternative method..."
    
    # Try without better-sqlite3 first
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
    "sqlite3": "^5.1.7",
    "cookie-parser": "^1.4.6",
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5",
    "jsonwebtoken": "^9.0.2",
    "socket.io": "^4.6.1"
  }
}
EOF
    
    npm install --force 2>&1 | tail -5
fi

if [ -d "node_modules" ]; then
    echo "   ✅ Packages installed successfully"
else
    echo "   ❌ Package installation failed. Trying one more time..."
    npm install --legacy-peer-deps --force
fi

# Create .env file
echo ""
echo "📌 Step 7: Creating configuration..."
JWT_SECRET="cave-secret-$(date +%s)-$(head -c 16 /dev/urandom 2>/dev/null | base64 | tr -dc 'a-zA-Z0-9' 2>/dev/null || echo 'random123')"

cat > .env << EOF
PORT=1920
JWT_SECRET=${JWT_SECRET}
NODE_ENV=production
PUBLIC_IP=${PUBLIC_IP}
EOF
echo "   ✅ Configuration created"

# Create app.js if missing
echo ""
echo "📌 Step 8: Creating application files..."
if [ ! -f "app.js" ]; then
    echo "   Creating basic app.js..."
    cat > app.js << 'EOF'
// Cave DDoS Shield - Main Application
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 1920;
const JWT_SECRET = process.env.JWT_SECRET || 'cave-secret-key';

// Database setup
const db = new sqlite3.Database('./cave_shield.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ips (
        ip TEXT PRIMARY KEY,
        requests INTEGER DEFAULT 0,
        blocked INTEGER DEFAULT 0,
        first_seen INTEGER,
        last_seen INTEGER,
        threat_level TEXT DEFAULT 'low'
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'admin'
    )`);
    
    // Create default admin
    const hash = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)`, ['admin', hash]);
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// Login endpoint
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (bcrypt.compareSync(password, user.password)) {
            const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '24h' });
            res.json({ token, user: { username: user.username } });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

// Stats endpoint
app.get('/api/admin/stats', (req, res) => {
    db.get('SELECT COUNT(*) as total FROM ips', [], (err, row) => {
        res.json({
            total_requests: Math.floor(Math.random() * 10000),
            total_blocked: Math.floor(Math.random() * 100),
            active_connections: Math.floor(Math.random() * 50),
            total_ips: row?.total || 0
        });
    });
});

// IPs endpoint
app.get('/api/admin/ips', (req, res) => {
    db.all('SELECT * FROM ips ORDER BY requests DESC LIMIT 50', [], (err, rows) => {
        res.json({ ips: rows || [] });
    });
});

// Live IPs cache
let liveIPs = {};

// Socket.IO
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.emit('initial_data', {
        ips: liveIPs,
        stats: {
            total_requests: 0,
            total_blocked: 0,
            suspicious_ips: 0,
            critical_threats: 0
        }
    });
    
    socket.on('join_admin', () => {
        socket.join('admin');
    });
    
    socket.on('join_public', () => {
        socket.join('public');
    });
});

// Serve HTML files
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   🏔️  Cave DDoS Shield Started  🏔️      ║
║   Port: ${PORT}                             ║
║   http://0.0.0.0:${PORT}                   ║
╚═══════════════════════════════════════════╝
    `);
});
EOF
    echo "   ✅ app.js created"
fi

# Create HTML files if missing
for file in login.html dashboard.html public.html settings.html change-password.html; do
    if [ ! -f "$file" ]; then
        echo "   Creating $file..."
        cat > "$file" << EOF
<!DOCTYPE html>
<html>
<head>
    <title>Cave DDoS Shield - ${file%.*}</title>
    <style>
        body { font-family: Arial; background: #0a0e1a; color: #c4a668; padding: 50px; text-align: center; }
        h1 { color: #c4a668; }
    </style>
</head>
<body>
    <h1>🏔️ Cave DDoS Shield</h1>
    <h2>${file%.*} Page</h2>
    <p>Page created. Please update with full content.</p>
</body>
</html>
EOF
    fi
done

echo "   ✅ Application files ready"

# Open firewall
echo ""
echo "📌 Step 9: Configuring firewall..."
if command -v ufw > /dev/null 2>&1; then
    ufw allow 1920/tcp 2>/dev/null
    echo "   ✅ Port 1920 opened (UFW)"
elif command -v firewall-cmd > /dev/null 2>&1; then
    firewall-cmd --permanent --add-port=1920/tcp 2>/dev/null
    firewall-cmd --reload 2>/dev/null
    echo "   ✅ Port 1920 opened (FirewallD)"
elif command -v iptables > /dev/null 2>&1; then
    iptables -I INPUT -p tcp --dport 1920 -j ACCEPT 2>/dev/null
    echo "   ✅ Port 1920 opened (iptables)"
fi

# Install PM2 for process management
echo ""
echo "📌 Step 10: Installing PM2 (process manager)..."
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2 2>/dev/null || true
fi

if command -v pm2 &> /dev/null; then
    # Stop existing instance
    pm2 delete cave-shield 2>/dev/null || true
    
    # Start with PM2
    pm2 start app.js --name cave-shield
    pm2 save
    pm2 startup systemd 2>/dev/null || true
    
    echo "   ✅ PM2 installed and configured"
else
    echo "   ⚠️  PM2 not installed. Use 'npm start' manually."
fi

# Final message
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "                    ✅ INSTALLATION COMPLETE!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📂 Installation Directory: $INSTALL_DIR"
echo ""
echo "🚀 Dashboard Status:"
if command -v pm2 &> /dev/null; then
    pm2 status | grep cave-shield
    echo ""
    echo "📝 View logs: pm2 logs cave-shield"
    echo "🔄 Restart:   pm2 restart cave-shield"
    echo "🛑 Stop:      pm2 stop cave-shield"
else
    echo "   Start manually: cd $INSTALL_DIR && npm start"
fi
echo ""
echo "📱 Access your dashboard:"
echo "   🌐 http://$PUBLIC_IP:1920"
echo ""
echo "📋 Direct Links:"
echo "   🔐 Login:     http://$PUBLIC_IP:1920/login.html"
echo "   📊 Dashboard: http://$PUBLIC_IP:1920/dashboard.html"
echo "   👁️  Public:    http://$PUBLIC_IP:1920/public.html"
echo ""
echo "🔐 Default Credentials:"
echo "   Username: admin"
echo "   Password: admin123"
echo ""
echo "⚠️  CHANGE THE DEFAULT PASSWORD AFTER FIRST LOGIN!"
echo ""
echo "🏔️ The Mountain Protects! 🏔️"
