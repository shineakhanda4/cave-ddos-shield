#!/bin/bash

# =============================================================================
# Cave DDoS Shield - Fully Automated Installer
# GitHub: https://github.com/shineakhanda4/cave-ddos-shield
# =============================================================================

set -e

clear

echo "════════════════════════════════════════════════════════════════"
echo "         🏔️  CAVE DDoS SHIELD - AUTO INSTALLER  🏔️"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Configuration
REPO_URL="https://github.com/shineakhanda4/cave-ddos-shield.git"
INSTALL_DIR="/opt/cave-shield"
SERVICE_NAME="cave-shield"
PORT=1920

# Detect Public IP
echo "📌 Step 1: Detecting server public IP..."
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || \
            curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || \
            curl -s --max-time 5 icanhazip.com 2>/dev/null || \
            curl -s --max-time 5 api.ipify.org 2>/dev/null || \
            hostname -I 2>/dev/null | awk '{print $1}')

if [ -n "$PUBLIC_IP" ]; then
    echo "   ✅ Public IP: $PUBLIC_IP"
else
    PUBLIC_IP="YOUR_SERVER_IP"
    echo "   ⚠️  Could not detect public IP"
fi

# Detect OS
echo ""
echo "📌 Step 2: Detecting operating system..."
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    echo "   ✅ Detected: $NAME"
else
    OS="unknown"
    echo "   ⚠️  Unknown OS"
fi

# Install system dependencies
echo ""
echo "📌 Step 3: Installing system dependencies..."
case $OS in
    ubuntu|debian)
        apt-get update -y > /dev/null 2>&1
        apt-get install -y curl wget git build-essential python3 pkg-config sqlite3 iptables net-tools > /dev/null 2>&1
        ;;
    centos|rhel|fedora|rocky|almalinux)
        yum update -y > /dev/null 2>&1
        yum groupinstall -y "Development Tools" > /dev/null 2>&1
        yum install -y curl wget git python3 pkgconfig sqlite iptables net-tools > /dev/null 2>&1
        ;;
    *)
        echo "   ⚠️  Please install manually: git, nodejs, build tools"
        ;;
esac
echo "   ✅ System dependencies installed"

# Install Node.js
echo ""
echo "📌 Step 4: Installing Node.js..."
if command -v node &> /dev/null; then
    echo "   ✅ Node.js $(node -v) already installed"
else
    case $OS in
        ubuntu|debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
            apt-get install -y nodejs > /dev/null 2>&1
            ;;
        centos|rhel|fedora|rocky|almalinux)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
            yum install -y nodejs > /dev/null 2>&1
            ;;
    esac
    echo "   ✅ Node.js $(node -v) installed"
fi

# Clone repository
echo ""
echo "📌 Step 5: Cloning Cave DDoS Shield..."
if [ -d "$INSTALL_DIR" ]; then
    echo "   Directory exists. Updating..."
    cd "$INSTALL_DIR"
    git pull origin main > /dev/null 2>&1 || true
else
    mkdir -p /opt
    git clone "$REPO_URL" "$INSTALL_DIR" > /dev/null 2>&1 || {
        echo "   ⚠️  Git clone failed, creating fresh installation..."
        mkdir -p "$INSTALL_DIR"
    }
fi
cd "$INSTALL_DIR"
echo "   ✅ Repository ready"

# Create package.json if missing
echo ""
echo "📌 Step 6: Setting up package.json..."
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

# Create .env file
echo ""
echo "📌 Step 7: Creating configuration..."
JWT_SECRET="cave-secret-$(date +%s)-$(head -c 16 /dev/urandom 2>/dev/null | base64 | tr -dc 'a-zA-Z0-9' 2>/dev/null || echo 'random123')"

cat > .env << EOF
PORT=$PORT
JWT_SECRET=$JWT_SECRET
NODE_ENV=production
PUBLIC_IP=$PUBLIC_IP
EOF
echo "   ✅ Configuration created"

# Install npm packages
echo ""
echo "📌 Step 8: Installing npm packages (1-3 minutes)..."
rm -rf node_modules package-lock.json 2>/dev/null || true
npm cache clean --force > /dev/null 2>&1 || true

# Try installation multiple ways if needed
npm install --silent 2>/dev/null || npm install --legacy-peer-deps 2>/dev/null || npm install --force 2>/dev/null

if [ -d "node_modules" ]; then
    echo "   ✅ Packages installed"
else
    echo "   ⚠️  Retrying with sqlite3..."
    cat > package.json << 'EOF'
{
  "name": "cave-ddos-shield",
  "version": "2.1.0",
  "main": "app.js",
  "scripts": { "start": "node app.js" },
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
    npm install --force 2>&1 | tail -3
    echo "   ✅ Packages installed (using sqlite3)"
fi

# Create app.js if missing
echo ""
echo "📌 Step 9: Checking application files..."
if [ ! -f "app.js" ]; then
    echo "   ⚠️  app.js not found. Downloading..."
    curl -s -o app.js https://raw.githubusercontent.com/shineakhanda4/cave-ddos-shield/main/app.js 2>/dev/null || {
        echo "   Creating basic app.js..."
        cat > app.js << 'EOFAPP'
// Cave DDoS Shield - Quick Start Version
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const { exec } = require('child_process');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 1920;
const JWT_SECRET = process.env.JWT_SECRET || 'cave-secret-key';
const db = new sqlite3.Database('./cave_shield.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ips (ip TEXT PRIMARY KEY, requests INTEGER, blocked INTEGER, threat_level TEXT, threat_score INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT)`);
    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)`, ['admin', bcrypt.hashSync('admin123', 10)]);
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));
app.use('/api/', rateLimit({ windowMs: 60000, max: 100 }));

let liveIPs = {};
let stats = { total_requests: 0, total_blocked: 0, suspicious_ips: 0, critical_threats: 0 };

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        if (bcrypt.compareSync(password, user.password)) {
            const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '24h' });
            res.cookie('token', token, { httpOnly: true, maxAge: 86400000 });
            res.json({ success: true, token, user: { username } });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

app.get('/api/admin/stats', (req, res) => {
    db.get('SELECT COUNT(*) as total FROM ips', [], (err, row) => {
        res.json({ ...stats, total_ips: row?.total || 0 });
    });
});

app.get('/api/public/stats', (req, res) => {
    res.json(stats);
});

io.on('connection', (socket) => {
    socket.emit('initial_data', { ips: liveIPs, stats });
    socket.on('join_admin', () => socket.join('admin'));
    socket.on('join_public', () => socket.join('public'));
});

setInterval(() => {
    exec("ss -ntu 2>/dev/null | awk '{print $5}' | cut -d: -f1 | grep -E '^[0-9]+\\.' | sort | uniq -c | sort -nr | head -20", (err, stdout) => {
        if (!err && stdout) {
            stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const count = parseInt(parts[0]);
                    const ip = parts[1];
                    if (ip && count > 20) {
                        liveIPs[ip] = { connections: count, threat_score: count * 10, threat_level: count > 100 ? 'critical' : 'high' };
                    }
                }
            });
            stats.suspicious_ips = Object.keys(liveIPs).length;
            stats.critical_threats = Object.values(liveIPs).filter(v => v.threat_level === 'critical').length;
            io.emit('live_update', { ips: liveIPs, stats });
        }
    });
}, 3000);

app.get('/', (req, res) => res.redirect('/login.html'));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🏔️ Cave DDoS Shield running on port ${PORT}`);
});
EOFAPP
    }
fi
echo "   ✅ Application files ready"

# Create HTML files if missing
for file in login.html dashboard.html public.html settings.html change-password.html; do
    if [ ! -f "$file" ]; then
        echo "   Creating $file..."
        cat > "$file" << EOFHTML
<!DOCTYPE html>
<html><head><title>Cave DDoS Shield - ${file%.*}</title>
<style>body{font-family:Arial;background:#0a0e1a;color:#c4a668;padding:50px;text-align:center;} h1{color:#c4a668;} .btn{background:#2d4a7c;color:white;padding:10px 20px;border:none;border-radius:5px;cursor:pointer;}</style>
</head><body><h1>🏔️ Cave DDoS Shield</h1><h2>${file%.*} Page</h2><p>Page ready.</p></body></html>
EOFHTML
    fi
done

# Set permissions
echo ""
echo "📌 Step 10: Setting permissions..."
chown -R $USER:$USER "$INSTALL_DIR" 2>/dev/null || true
chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null || true
echo "   ✅ Permissions set"

# Open firewall
echo ""
echo "📌 Step 11: Configuring firewall..."
if command -v ufw > /dev/null 2>&1; then
    ufw allow $PORT/tcp > /dev/null 2>&1
    echo "   ✅ Port $PORT opened (UFW)"
elif command -v firewall-cmd > /dev/null 2>&1; then
    firewall-cmd --permanent --add-port=$PORT/tcp > /dev/null 2>&1
    firewall-cmd --reload > /dev/null 2>&1
    echo "   ✅ Port $PORT opened (FirewallD)"
elif command -v iptables > /dev/null 2>&1; then
    iptables -I INPUT -p tcp --dport $PORT -j ACCEPT 2>/dev/null
    echo "   ✅ Port $PORT opened (iptables)"
fi

# Install and configure PM2
echo ""
echo "📌 Step 12: Setting up PM2 process manager..."
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2 > /dev/null 2>&1
fi

pm2 delete $SERVICE_NAME 2>/dev/null || true
pm2 start app.js --name $SERVICE_NAME --cwd "$INSTALL_DIR"
pm2 save > /dev/null 2>&1
pm2 startup systemd > /dev/null 2>&1 || true

echo "   ✅ PM2 configured"

# Create management script
cat > /usr/local/bin/cave-shield << 'EOFCLI'
#!/bin/bash
case "$1" in
    start)   pm2 start cave-shield ;;
    stop)    pm2 stop cave-shield ;;
    restart) pm2 restart cave-shield ;;
    status)  pm2 status cave-shield ;;
    logs)    pm2 logs cave-shield ;;
    *)       echo "Usage: cave-shield {start|stop|restart|status|logs}" ;;
esac
EOFCLI
chmod +x /usr/local/bin/cave-shield

# Final message
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "                    ✅ INSTALLATION COMPLETE!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📂 Installation Directory: $INSTALL_DIR"
echo ""
echo "🚀 Dashboard Status:"
pm2 status | grep $SERVICE_NAME || echo "   Running on port $PORT"
echo ""
echo "📱 Access your dashboard:"
echo "   🌐 http://$PUBLIC_IP:$PORT"
echo ""
echo "📋 Direct Links:"
echo "   🔐 Login:     http://$PUBLIC_IP:$PORT/login.html"
echo "   📊 Dashboard: http://$PUBLIC_IP:$PORT/dashboard.html"
echo "   👁️  Public:    http://$PUBLIC_IP:$PORT/public.html"
echo "   ⚙️  Settings:  http://$PUBLIC_IP:$PORT/settings.html"
echo ""
echo "🔐 Default Credentials:"
echo "   Username: admin"
echo "   Password: admin123"
echo ""
echo "⚠️  CHANGE THE DEFAULT PASSWORD AFTER FIRST LOGIN!"
echo ""
echo "📝 Management Commands:"
echo "   cave-shield status   - Check status"
echo "   cave-shield restart  - Restart dashboard"
echo "   cave-shield logs     - View logs"
echo "   pm2 status          - PM2 status"
echo ""
echo "🔄 Update Command:"
echo "   cd $INSTALL_DIR && git pull && npm install && pm2 restart $SERVICE_NAME"
echo ""
echo "🏔️ The Mountain Protects! 🏔️"
