const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const Database = require("better-sqlite3");
const { exec } = require("child_process");
const { promisify } = require("util");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const os = require("os");

const execAsync = promisify(exec);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Security configuration
const JWT_SECRET = process.env.JWT_SECRET || "cave-secret-key-change-in-production-" + Math.random().toString(36);
const JWT_EXPIRES_IN = "24h";
const SALT_ROUNDS = 10;

app.use(express.json());
app.use(cookieParser());

// Rate limiting for login attempts
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    message: { error: "Too many login attempts, please try again later" }
});

// Rate limiting for API
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100,
    message: { error: "Too many requests" }
});

/* ============================
   DATABASE SETUP
============================ */
const db = new Database("./cave_shield.db");

console.log("✓ Database connected");

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL");

db.exec(`
    CREATE TABLE IF NOT EXISTS ips (
        ip TEXT PRIMARY KEY,
        requests INTEGER DEFAULT 0,
        bandwidth INTEGER DEFAULT 0,
        threads INTEGER DEFAULT 0,
        blocked INTEGER DEFAULT 0,
        blocked_at INTEGER,
        first_seen INTEGER,
        last_seen INTEGER,
        country TEXT,
        threat_level TEXT DEFAULT 'low'
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS attack_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT,
        timestamp INTEGER,
        requests INTEGER,
        bandwidth INTEGER,
        action TEXT
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        rate_limit_per_minute INTEGER DEFAULT 60,
        max_bandwidth_per_minute INTEGER DEFAULT 1048576,
        auto_block INTEGER DEFAULT 1,
        block_duration INTEGER DEFAULT 3600,
        threat_threshold_medium INTEGER DEFAULT 100,
        threat_threshold_high INTEGER DEFAULT 500,
        threat_threshold_critical INTEGER DEFAULT 1000,
        auto_block_syn_recv INTEGER DEFAULT 50,
        auto_block_high_connections INTEGER DEFAULT 150,
        auto_block_port_scan INTEGER DEFAULT 10,
        auto_block_time_wait INTEGER DEFAULT 300,
        intelligent_blocking INTEGER DEFAULT 1
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email TEXT,
        role TEXT DEFAULT 'admin',
        created_at INTEGER,
        last_login INTEGER,
        login_attempts INTEGER DEFAULT 0,
        locked_until INTEGER DEFAULT 0
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        token TEXT UNIQUE,
        ip_address TEXT,
        user_agent TEXT,
        created_at INTEGER,
        expires_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

// Insert default settings
const insertSettings = db.prepare("INSERT OR IGNORE INTO settings (id) VALUES (?)");
insertSettings.run(1);

// Create default admin user
const defaultPassword = "admin123";
const hash = bcrypt.hashSync(defaultPassword, SALT_ROUNDS);

const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password, email, role, created_at) 
    VALUES (?, ?, ?, ?, ?)
`);

try {
    insertUser.run("admin", hash, "admin@cave.local", "admin", Date.now());
    console.log("✓ Default admin user ready (username: admin, password: admin123)");
    console.log("⚠️  CHANGE DEFAULT PASSWORD IMMEDIATELY!");
} catch (err) {
    if (!err.message.includes("UNIQUE")) {
        console.error("Error creating default admin:", err);
    }
}

/* ============================
   MEMORY CACHE (FAST LIVE)
============================ */
let liveIPs = {};
let minuteTracker = {};
let settings = {
    rate_limit_per_minute: 60,
    max_bandwidth_per_minute: 1048576,
    auto_block: 1,
    block_duration: 3600,
    threat_threshold_medium: 100,
    threat_threshold_high: 500,
    threat_threshold_critical: 1000,
    auto_block_syn_recv: 50,
    auto_block_high_connections: 150,
    auto_block_port_scan: 10,
    auto_block_time_wait: 300,
    intelligent_blocking: 1
};

let stats = {
    total_requests: 0,
    total_blocked: 0,
    active_connections: 0,
    total_bandwidth: 0,
    total_connections: 0,
    suspicious_ips: 0,
    critical_threats: 0,
    high_threats: 0,
    medium_threats: 0,
    server_load: 0,
    memory_usage: 0,
    total_network_connections: 0,
    established_connections: 0,
    syn_recv_total: 0,
    last_scan: 0
};

/* ============================
   LOAD SETTINGS
============================ */
function loadSettings() {
    try {
        const row = db.prepare("SELECT * FROM settings WHERE id = 1").get();
        if (row) {
            settings = row;
            console.log("✓ Settings loaded");
        }
    } catch (err) {
        console.error("Settings load error:", err);
    }
}
loadSettings();

/* ============================
   PLATFORM DETECTION
============================ */
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

if (isLinux) {
    console.log("✓ Linux detected - Full network monitoring enabled");
} else if (isWindows) {
    console.log("⚠️  Windows detected - Network monitoring disabled (Linux VPS required for full protection)");
} else {
    console.log(`⚠️  ${process.platform} detected - Network monitoring may not work properly`);
}

/* ============================
   IP VALIDATION
============================ */
function isValidIPv4(ip) {
    if (!ip || typeof ip !== 'string') return false;
    
    const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = ip.match(ipRegex);
    
    if (!match) return false;
    
    for (let i = 1; i <= 4; i++) {
        const octet = parseInt(match[i]);
        if (octet < 0 || octet > 255) return false;
    }
    
    if (ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '255.255.255.255') return false;
    if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.16.')) return false;
    if (ip.startsWith('169.254.')) return false;
    if (ip.startsWith('224.') || ip.startsWith('240.')) return false;
    
    return true;
}

/* ============================
   NETWORK MONITORING FUNCTIONS
============================ */
async function monitorActiveConnections() {
    if (!isLinux) return {};
    
    try {
        const { stdout: ssOutput } = await execAsync(`ss -ntu state established 2>/dev/null | awk '{print $5}' | cut -d: -f1 | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' | sort | uniq -c | sort -nr | head -100`);
        
        const connections = {};
        const lines = ssOutput.trim().split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                
                if (isValidIPv4(ip)) {
                    connections[ip] = (connections[ip] || 0) + count;
                }
            }
        });
        
        return connections;
    } catch (err) {
        console.error("Connection monitoring error:", err.message);
        return {};
    }
}

async function monitorAllConnectionStates() {
    if (!isLinux) return {};
    
    try {
        const { stdout } = await execAsync(`ss -ntu 2>/dev/null | awk '{print $1, $5}' | grep -E '^[A-Z]+ [0-9]+\\.' | awk '{print $2, $1}' | cut -d: -f1 | sort | uniq -c | sort -nr | head -100`);
        
        const statesByIP = {};
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                const state = parts[2];
                
                if (ip && !ip.startsWith('10.') && !ip.startsWith('192.168.') && !ip.startsWith('127.')) {
                    if (!statesByIP[ip]) statesByIP[ip] = {};
                    statesByIP[ip][state] = (statesByIP[ip][state] || 0) + count;
                }
            }
        });
        
        return statesByIP;
    } catch (err) {
        return {};
    }
}

async function monitorSynFlood() {
    if (!isLinux) return {};
    
    try {
        const synFlood = {};
        
        const { stdout: synRecv } = await execAsync(`ss -ntu state syn-recv 2>/dev/null | awk '{print $5}' | cut -d: -f1 | grep -E '^[0-9]+\\.' | sort | uniq -c | sort -nr | head -50`);
        
        synRecv.trim().split('\n').filter(line => line.trim()).forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                if (ip && count > 5) {
                    synFlood[ip] = (synFlood[ip] || 0) + count;
                }
            }
        });
        
        const { stdout: synSent } = await execAsync(`ss -ntu state syn-sent 2>/dev/null | awk '{print $5}' | cut -d: -f1 | grep -E '^[0-9]+\\.' | sort | uniq -c | sort -nr | head -50`);
        
        synSent.trim().split('\n').filter(line => line.trim()).forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                if (ip && count > 3) {
                    synFlood[ip] = (synFlood[ip] || 0) + count;
                }
            }
        });
        
        return synFlood;
    } catch (err) {
        return {};
    }
}

async function detectPortScanning() {
    if (!isLinux) return {};
    
    try {
        const { stdout } = await execAsync(`ss -ntu 2>/dev/null | awk '{print $5}' | grep -E '^[0-9]+\\.' | sort | uniq | awk -F: '{print $1}' | uniq -c | sort -nr | head -50`);
        
        const scanners = {};
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const portCount = parseInt(parts[0]);
                const ip = parts[1];
                
                if (portCount > 3 && ip && !ip.startsWith('10.') && !ip.startsWith('192.168.')) {
                    scanners[ip] = portCount;
                }
            }
        });
        
        return scanners;
    } catch (err) {
        return {};
    }
}

async function detectUDPFlood() {
    if (!isLinux) return {};
    
    try {
        const { stdout } = await execAsync(`ss -nu 2>/dev/null | awk '{print $5}' | cut -d: -f1 | grep -E '^[0-9]+\\.' | sort | uniq -c | sort -nr | head -50`);
        
        const udpFlood = {};
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                
                if (count > 20 && ip) {
                    udpFlood[ip] = count;
                }
            }
        });
        
        return udpFlood;
    } catch (err) {
        return {};
    }
}

async function detectSynRecvNetstat() {
    if (!isLinux) return { total: 0, ips: {} };
    
    try {
        const { stdout: synCount } = await execAsync(`netstat -nat 2>/dev/null | grep SYN_RECV | wc -l`);
        const totalSynRecv = parseInt(synCount.trim()) || 0;
        
        const { stdout: synIPs } = await execAsync(`netstat -nat 2>/dev/null | grep SYN_RECV | awk '{print $5}' | cut -d: -f1 | sort | uniq -c | sort -nr`);
        
        const synRecvData = { total: totalSynRecv, ips: {} };
        
        synIPs.trim().split('\n').filter(line => line.trim()).forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                if (ip && count > 3) {
                    synRecvData.ips[ip] = count;
                }
            }
        });
        
        return synRecvData;
    } catch (err) {
        return { total: 0, ips: {} };
    }
}

async function detectHighConnectionIPs() {
    if (!isLinux) return {};
    
    try {
        const { stdout } = await execAsync(`ss -ntu 2>/dev/null | awk '{print $5}' | cut -d: -f1 | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' | sort | uniq -c | awk '$1 > 50 {print $1, $2}'`);
        
        const highConnIPs = {};
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                
                if (isValidIPv4(ip)) {
                    highConnIPs[ip] = count;
                }
            }
        });
        
        return highConnIPs;
    } catch (err) {
        return {};
    }
}

async function detectTimeWaitAbuse() {
    if (!isLinux) return {};
    
    try {
        const { stdout } = await execAsync(`ss -ntu state time-wait 2>/dev/null | awk '{print $5}' | cut -d: -f1 | grep -E '^[0-9]+\\.' | sort | uniq -c | sort -nr | head -50`);
        
        const timeWaitAbuse = {};
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const count = parseInt(parts[0]);
                const ip = parts[1];
                
                if (count > 100 && ip) {
                    timeWaitAbuse[ip] = count;
                }
            }
        });
        
        return timeWaitAbuse;
    } catch (err) {
        return {};
    }
}

async function getServerStats() {
    if (!isLinux) {
        return {
            load_1min: 0, load_5min: 0, load_15min: 0,
            memory_total: 0, memory_used: 0, memory_free: 0, memory_percent: 0,
            total_network_connections: 0, established_connections: 0
        };
    }
    
    try {
        const stats = {};
        const loadavg = os.loadavg();
        stats.load_1min = loadavg[0] || 0;
        stats.load_5min = loadavg[1] || 0;
        stats.load_15min = loadavg[2] || 0;
        
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        stats.memory_total = Math.round(totalMem / 1024 / 1024);
        stats.memory_used = Math.round((totalMem - freeMem) / 1024 / 1024);
        stats.memory_free = Math.round(freeMem / 1024 / 1024);
        stats.memory_percent = Math.round(((totalMem - freeMem) / totalMem) * 100);
        
        const { stdout: connCount } = await execAsync(`ss -ntu 2>/dev/null | wc -l`);
        stats.total_network_connections = parseInt(connCount.trim()) - 1 || 0;
        
        const { stdout: estabCount } = await execAsync(`ss -ntu state established 2>/dev/null | wc -l`);
        stats.established_connections = parseInt(estabCount.trim()) - 1 || 0;
        
        return stats;
    } catch (err) {
        return {
            load_1min: 0, load_5min: 0, load_15min: 0,
            memory_total: 0, memory_used: 0, memory_free: 0, memory_percent: 0,
            total_network_connections: 0, established_connections: 0
        };
    }
}

/* ============================
   MAIN ATTACK ANALYSIS
============================ */
async function analyzeNetworkActivity() {
    try {
        const [
            connections, 
            connectionStates, 
            synFlood, 
            scanners, 
            udpFlood, 
            serverStats,
            synRecvData,
            highConnIPs,
            timeWaitAbuse
        ] = await Promise.all([
            monitorActiveConnections(),
            monitorAllConnectionStates(),
            monitorSynFlood(),
            detectPortScanning(),
            detectUDPFlood(),
            getServerStats(),
            detectSynRecvNetstat(),
            detectHighConnectionIPs(),
            detectTimeWaitAbuse()
        ]);
        
        const now = Date.now();
        const allIPs = [
            ...Object.keys(connections),
            ...Object.keys(synFlood),
            ...Object.keys(scanners),
            ...Object.keys(udpFlood),
            ...Object.keys(synRecvData.ips || {}),
            ...Object.keys(highConnIPs),
            ...Object.keys(timeWaitAbuse)
        ];
        
        const detectedIPs = new Set(allIPs.filter(ip => isValidIPv4(ip)));
        
        stats.server_load = serverStats.load_1min;
        stats.memory_usage = serverStats.memory_percent;
        stats.total_network_connections = serverStats.total_network_connections;
        stats.established_connections = serverStats.established_connections;
        stats.syn_recv_total = synRecvData.total || 0;
        
        let criticalCount = 0;
        let highCount = 0;
        let mediumCount = 0;
        
        for (const ip of detectedIPs) {
            const connectionCount = connections[ip] || 0;
            const synCount = synFlood[ip] || 0;
            const portScanCount = scanners[ip] || 0;
            const udpCount = udpFlood[ip] || 0;
            const ipStates = connectionStates[ip] || {};
            const synRecvCount = synRecvData.ips?.[ip] || 0;
            const highConnCount = highConnIPs[ip] || 0;
            const timeWaitCount = timeWaitAbuse[ip] || 0;
            
            let threatScore = 0;
            let attackType = [];
            let attackDetails = {};
            
            // SYN_RECV detection (highest priority)
            if (synRecvCount > 50) {
                threatScore += synRecvCount * 20;
                attackType.push('syn_recv_flood');
                attackDetails.syn_recv = synRecvCount;
            } else if (synRecvCount > 20) {
                threatScore += synRecvCount * 10;
                attackType.push('syn_recv_attack');
                attackDetails.syn_recv = synRecvCount;
            }
            
            // High connection count
            if (highConnCount > 200) {
                threatScore += highConnCount * 3;
                attackType.push('massive_connection_flood');
                attackDetails.high_connections = highConnCount;
            } else if (highConnCount > 100) {
                threatScore += highConnCount * 2;
                attackType.push('connection_flood');
                attackDetails.high_connections = highConnCount;
            } else if (highConnCount > 50) {
                threatScore += highConnCount;
                attackType.push('high_connections');
                attackDetails.high_connections = highConnCount;
            }
            
            // TIME_WAIT abuse
            if (timeWaitCount > 500) {
                threatScore += timeWaitCount * 2;
                attackType.push('time_wait_exhaustion');
                attackDetails.time_wait = timeWaitCount;
            } else if (timeWaitCount > 200) {
                threatScore += timeWaitCount;
                attackType.push('time_wait_abuse');
                attackDetails.time_wait = timeWaitCount;
            }
            
            // Regular connection count
            if (connectionCount > 100) {
                threatScore += connectionCount * 2;
                if (!attackType.includes('connection_flood')) {
                    attackType.push('connection_flood');
                }
                attackDetails.connections = connectionCount;
            }
            
            // SYN flood detection
            if (synCount > 20) {
                threatScore += synCount * 10;
                attackType.push('syn_flood');
                attackDetails.syn_packets = synCount;
            }
            
            // Port scanning
            if (portScanCount > 10) {
                threatScore += portScanCount * 15;
                attackType.push('aggressive_scan');
                attackDetails.ports_scanned = portScanCount;
            } else if (portScanCount > 5) {
                threatScore += portScanCount * 10;
                attackType.push('port_scan');
                attackDetails.ports_scanned = portScanCount;
            }
            
            // UDP flood
            if (udpCount > 50) {
                threatScore += udpCount * 5;
                attackType.push('udp_flood');
                attackDetails.udp_packets = udpCount;
            }
            
            // Update or create IP tracking
            if (!liveIPs[ip]) {
                const existingIP = db.prepare("SELECT blocked, blocked_at FROM ips WHERE ip = ?").get(ip);
                
                liveIPs[ip] = {
                    requests: 0, bandwidth: 0, threads: 0,
                    first_seen: now, last_seen: now,
                    threat_level: 'low', connections: 0,
                    attack_type: [], threat_score: 0,
                    attack_details: {},
                    blocked: existingIP?.blocked || false,
                    blocked_at: existingIP?.blocked_at || null
                };
                
                db.prepare("INSERT OR IGNORE INTO ips (ip, first_seen, last_seen) VALUES (?, ?, ?)").run(ip, now, now);
            }
            
            liveIPs[ip].connections = connectionCount;
            liveIPs[ip].last_seen = now;
            liveIPs[ip].threat_score = threatScore;
            liveIPs[ip].attack_type = attackType;
            liveIPs[ip].attack_details = attackDetails;
            liveIPs[ip].connection_states = ipStates;
            liveIPs[ip].syn_count = synCount;
            liveIPs[ip].udp_count = udpCount;
            liveIPs[ip].port_scan_count = portScanCount;
            liveIPs[ip].syn_recv_count = synRecvCount;
            liveIPs[ip].high_conn_count = highConnCount;
            liveIPs[ip].time_wait_count = timeWaitCount;
            
            // Determine threat level
            if (threatScore >= settings.threat_threshold_critical) {
                liveIPs[ip].threat_level = 'critical';
                criticalCount++;
            } else if (threatScore >= settings.threat_threshold_high) {
                liveIPs[ip].threat_level = 'high';
                highCount++;
            } else if (threatScore >= settings.threat_threshold_medium) {
                liveIPs[ip].threat_level = 'medium';
                mediumCount++;
            } else {
                liveIPs[ip].threat_level = 'low';
            }
            
            // Intelligent auto-blocking
            const shouldBlock = settings.auto_block && (
                liveIPs[ip].threat_level === 'critical' ||
                threatScore >= settings.threat_threshold_critical ||
                (settings.intelligent_blocking && (
                    synRecvCount >= settings.auto_block_syn_recv ||
                    highConnCount >= settings.auto_block_high_connections ||
                    portScanCount >= settings.auto_block_port_scan ||
                    timeWaitCount >= settings.auto_block_time_wait ||
                    attackType.length >= 3 ||
                    (synRecvCount > 20 && highConnCount > 100) ||
                    (portScanCount > 5 && synCount > 10) ||
                    (udpCount > 30 && connectionCount > 50)
                ))
            );
            
            if (shouldBlock) {
                const alreadyBlocked = liveIPs[ip]?.blocked || false;
                const ipData = db.prepare("SELECT blocked FROM ips WHERE ip = ?").get(ip);
                
                if (!alreadyBlocked && (!ipData || !ipData.blocked)) {
                    const blockResult = await blockIP(ip, attackType.join(',') || 'auto');
                    
                    if (blockResult.success) {
                        liveIPs[ip].blocked = true;
                        liveIPs[ip].blocked_at = Date.now();
                        
                        console.log(`🚨 INTELLIGENT AUTO-BLOCK: ${ip}`);
                        console.log(`   Threat Level: ${liveIPs[ip].threat_level} | Score: ${threatScore}`);
                        console.log(`   Attack Types: ${attackType.join(', ')}`);
                    }
                }
            }
        }
        
        stats.total_connections = Object.values(connections).reduce((a, b) => a + b, 0);
        stats.suspicious_ips = detectedIPs.size;
        stats.critical_threats = criticalCount;
        stats.high_threats = highCount;
        stats.medium_threats = mediumCount;
        stats.last_scan = now;
        
    } catch (err) {
        console.error("Network analysis error:", err);
    }
}

/* ============================
   IPTABLES FUNCTIONS
============================ */
async function blockIP(ip, reason = "auto") {
    if (!isLinux) {
        console.log(`⚠️  Cannot block ${ip} on Windows - iptables requires Linux`);
        return { success: false, message: "Blocking requires Linux VPS" };
    }
    
    if (!isValidIPv4(ip)) {
        console.error(`❌ Invalid IP address: ${ip}`);
        return { success: false, message: "Invalid IP address" };
    }
    
    try {
        const { stdout } = await execAsync(`iptables -L INPUT -n | grep ${ip}`);
        if (stdout.includes(ip)) {
            db.prepare("UPDATE ips SET blocked = 1, blocked_at = ? WHERE ip = ?").run(Date.now(), ip);
            return { success: true, message: "Already blocked" };
        }
    } catch (err) {
        // Not found, proceed to block
    }

    try {
        await execAsync(`iptables -A INPUT -s ${ip} -j DROP`);
        console.log(`🚫 Blocked: ${ip} (${reason})`);
        
        stats.total_blocked++;
        
        db.prepare("UPDATE ips SET blocked = 1, blocked_at = ? WHERE ip = ?").run(Date.now(), ip);
        db.prepare("INSERT INTO attack_logs (ip, timestamp, requests, bandwidth, action) VALUES (?, ?, ?, ?, ?)")
            .run(ip, Date.now(), liveIPs[ip]?.requests || 0, liveIPs[ip]?.bandwidth || 0, `blocked_${reason}`);

        io.emit("ip_blocked", { ip, reason, timestamp: Date.now() });
        
        return { success: true, message: "IP blocked" };
    } catch (err) {
        if (err.message.includes('already') || err.message.includes('exist')) {
            db.prepare("UPDATE ips SET blocked = 1, blocked_at = ? WHERE ip = ?").run(Date.now(), ip);
            return { success: true, message: "Already blocked" };
        }
        console.error(`❌ Block failed for ${ip}:`, err.message);
        return { success: false, error: err.message };
    }
}

async function unblockIP(ip) {
    if (!isLinux) {
        console.log(`⚠️  Cannot unblock ${ip} on Windows - iptables requires Linux`);
        return { success: false, message: "Unblocking requires Linux VPS" };
    }
    
    try {
        await execAsync(`iptables -D INPUT -s ${ip} -j DROP`);
        console.log(`✓ Unblocked: ${ip}`);
        
        db.prepare("UPDATE ips SET blocked = 0, blocked_at = NULL WHERE ip = ?").run(ip);
        db.prepare("INSERT INTO attack_logs (ip, timestamp, requests, bandwidth, action) VALUES (?, ?, ?, ?, ?)")
            .run(ip, Date.now(), 0, 0, "unblocked");

        io.emit("ip_unblocked", { ip, timestamp: Date.now() });
        
        return { success: true, message: "IP unblocked" };
    } catch (err) {
        console.error(`❌ Unblock failed for ${ip}:`, err.message);
        return { success: false, error: err.message };
    }
}

/* ============================
   HELPER FUNCTIONS
============================ */
function getClientIP(req) {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.headers["x-real-ip"] ||
        req.socket.remoteAddress ||
        req.connection.remoteAddress
    ).replace("::ffff:", "");
}

function getThreatLevel(requests, bandwidth) {
    if (requests >= settings.threat_threshold_high || bandwidth >= settings.max_bandwidth_per_minute * 5) {
        return "critical";
    } else if (requests >= settings.threat_threshold_medium || bandwidth >= settings.max_bandwidth_per_minute * 2) {
        return "high";
    } else if (requests >= settings.rate_limit_per_minute || bandwidth >= settings.max_bandwidth_per_minute) {
        return "medium";
    }
    return "low";
}

/* ============================
   AUTH MIDDLEWARE
============================ */
function authenticateToken(req, res, next) {
    const token = req.cookies.token || req.headers["authorization"]?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Access denied. No token provided." });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: "Invalid or expired token" });
        }

        try {
            const session = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?").get(token, Date.now());

            if (!session) {
                return res.status(403).json({ error: "Session expired or invalid" });
            }

            req.user = user;
            req.sessionToken = token;
            next();
        } catch (err) {
            return res.status(500).json({ error: "Database error" });
        }
    });
}

/* ============================
   REQUEST TRACKING
============================ */
app.use((req, res, next) => {
    const ip = getClientIP(req);
    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);

    stats.total_requests++;
    stats.active_connections++;

    if (!liveIPs[ip]) {
        liveIPs[ip] = {
            requests: 0, bandwidth: 0, threads: 0,
            first_seen: now, last_seen: now,
            threat_level: "low"
        };
        
        db.prepare("INSERT OR IGNORE INTO ips (ip, first_seen, last_seen) VALUES (?, ?, ?)").run(ip, now, now);
    }

    if (!minuteTracker[ip]) {
        minuteTracker[ip] = { minute: currentMinute, requests: 0, bandwidth: 0 };
    }

    if (minuteTracker[ip].minute !== currentMinute) {
        minuteTracker[ip] = { minute: currentMinute, requests: 0, bandwidth: 0 };
    }

    liveIPs[ip].requests++;
    liveIPs[ip].threads++;
    liveIPs[ip].last_seen = now;
    minuteTracker[ip].requests++;

    const size = parseInt(req.headers["content-length"] || 0);
    liveIPs[ip].bandwidth += size;
    minuteTracker[ip].bandwidth += size;
    stats.total_bandwidth += size;

    liveIPs[ip].threat_level = getThreatLevel(
        minuteTracker[ip].requests,
        minuteTracker[ip].bandwidth
    );

    if (settings.auto_block) {
        const exceedsRate = minuteTracker[ip].requests > settings.rate_limit_per_minute;
        const exceedsBandwidth = minuteTracker[ip].bandwidth > settings.max_bandwidth_per_minute;

        if (exceedsRate || exceedsBandwidth) {
            const reason = exceedsRate ? "rate_limit" : "bandwidth_limit";
            blockIP(ip, reason);
            
            return res.status(429).json({
                error: "Too many requests",
                message: "Your IP has been blocked due to excessive requests",
                ip: ip
            });
        }
    }

    res.on("finish", () => {
        liveIPs[ip].threads--;
        stats.active_connections--;
    });

    next();
});

/* ============================
   AUTH ROUTES
============================ */
app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
    }

    try {
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (user.locked_until > Date.now()) {
            const minutesLeft = Math.ceil((user.locked_until - Date.now()) / 60000);
            return res.status(423).json({ 
                error: `Account locked. Try again in ${minutesLeft} minutes.` 
            });
        }

        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            const attempts = user.login_attempts + 1;
            const lockedUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : 0;

            db.prepare("UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?")
                .run(attempts, lockedUntil, user.id);

            return res.status(401).json({ 
                error: "Invalid credentials",
                attemptsLeft: Math.max(0, 5 - attempts)
            });
        }

        db.prepare("UPDATE users SET login_attempts = 0, locked_until = 0, last_login = ? WHERE id = ?")
            .run(Date.now(), user.id);

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        const clientIP = getClientIP(req);
        const userAgent = req.headers["user-agent"] || "unknown";
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

        db.prepare(`INSERT INTO sessions (user_id, token, ip_address, user_agent, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`)
            .run(user.id, token, clientIP, userAgent, Date.now(), expiresAt);

        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: "strict"
        });

        res.json({
            success: true,
            message: "Login successful",
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            },
            token
        });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Login failed" });
    }
});

app.post("/api/auth/logout", authenticateToken, (req, res) => {
    try {
        db.prepare("DELETE FROM sessions WHERE token = ?").run(req.sessionToken);
        res.clearCookie("token");
        res.json({ success: true, message: "Logged out successfully" });
    } catch (err) {
        res.status(500).json({ error: "Logout failed" });
    }
});

app.get("/api/auth/me", authenticateToken, (req, res) => {
    try {
        const user = db.prepare("SELECT id, username, email, role, created_at, last_login FROM users WHERE id = ?").get(req.user.id);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        res.json({ user });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch user" });
    }
});

app.post("/api/auth/change-password", authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Current and new password required" });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    try {
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: "Current password is incorrect" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
        db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashedPassword, user.id);
        
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(user.id, req.sessionToken);

        res.json({ success: true, message: "Password changed successfully" });
    } catch (err) {
        res.status(500).json({ error: "Failed to update password" });
    }
});

/* ============================
   ADMIN API
============================ */
app.use("/api/admin", authenticateToken, apiLimiter);

app.get("/api/admin/stats", (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as total_ips, SUM(blocked) as blocked_count FROM ips").get();
        res.json({
            ...stats,
            total_ips: row?.total_ips || 0,
            blocked_ips: row?.blocked_count || 0,
            settings: settings
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/ips", (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM ips ORDER BY requests DESC LIMIT 100").all();
        res.json({ ips: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/block", async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: "IP required" });
    
    const result = await blockIP(ip, "manual");
    res.json(result);
});

app.post("/api/admin/unblock", async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: "IP required" });
    
    const result = await unblockIP(ip);
    res.json(result);
});

app.get("/api/admin/settings", (req, res) => {
    res.json(settings);
});

app.post("/api/admin/settings", (req, res) => {
    const updates = req.body;
    
    try {
        db.prepare(`UPDATE settings SET 
            rate_limit_per_minute=?, max_bandwidth_per_minute=?, auto_block=?,
            block_duration=?, threat_threshold_medium=?, threat_threshold_high=?,
            threat_threshold_critical=?, auto_block_syn_recv=?, auto_block_high_connections=?,
            auto_block_port_scan=?, auto_block_time_wait=?, intelligent_blocking=?
            WHERE id=1`).run(
            updates.rate_limit_per_minute, updates.max_bandwidth_per_minute, updates.auto_block,
            updates.block_duration, updates.threat_threshold_medium, updates.threat_threshold_high,
            updates.threat_threshold_critical, updates.auto_block_syn_recv, updates.auto_block_high_connections,
            updates.auto_block_port_scan, updates.auto_block_time_wait, updates.intelligent_blocking
        );
        loadSettings();
        io.emit("settings_updated", settings);
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ============================
   PUBLIC API
============================ */
app.get("/api/public/attacks", (req, res) => {
    try {
        const rows = db.prepare(`SELECT ip, requests, bandwidth, threat_level, blocked, last_seen FROM ips WHERE requests > 10 ORDER BY requests DESC LIMIT 100`).all();
        res.json({
            attacks: rows,
            total_attacks: stats.total_requests,
            blocked_count: stats.total_blocked,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

app.get("/api/public/stats", (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as total, SUM(blocked) as blocked FROM ips").get();
        res.json({
            total_requests: stats.total_requests,
            total_ips: row?.total || 0,
            blocked_ips: row?.blocked || 0,
            active_connections: stats.active_connections,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

/* ============================
   SOCKET.IO
============================ */
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    if (!token) {
        socket.user = { username: 'public', role: 'public' };
        return next();
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const session = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?").get(token, Date.now());
        
        if (!session) {
            socket.user = { username: 'public', role: 'public' };
            return next();
        }
        
        socket.user = decoded;
        socket.sessionToken = token;
        next();
    } catch (err) {
        socket.user = { username: 'public', role: 'public' };
        next();
    }
});

io.on("connection", (socket) => {
    console.log(`🔌 Client connected: ${socket.id} (User: ${socket.user.username})`);

    const initialData = {
        ips: liveIPs,
        stats: stats,
        user: socket.user
    };
    
    if (socket.user.role !== 'public') {
        initialData.settings = settings;
    }
    
    socket.emit("initial_data", initialData);

    socket.on("join_admin", () => {
        socket.join("admin");
        console.log(`👤 Admin joined: ${socket.id}`);
    });

    socket.on("join_public", () => {
        socket.join("public");
        console.log(`👁 Public viewer joined: ${socket.id}`);
    });

    socket.on("disconnect", () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
    });
});

/* ============================
   STATIC FILES & ROUTES
============================ */
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.redirect("/login.html");
});

app.get("/health", (req, res) => {
    res.json({ 
        status: "healthy", 
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

/* ============================
   PERIODIC TASKS
============================ */
setInterval(() => {
    for (let ip in liveIPs) {
        let data = liveIPs[ip];

        db.prepare(`INSERT INTO ips (ip, requests, bandwidth, threads, last_seen, threat_level, first_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(ip) DO UPDATE SET
             requests = requests + ?,
             bandwidth = bandwidth + ?,
             threads = ?,
             last_seen = ?,
             threat_level = ?`).run(
            ip, data.requests, data.bandwidth, data.threads, data.last_seen, data.threat_level, data.first_seen,
            data.requests, data.bandwidth, data.threads, data.last_seen, data.threat_level
        );
    }

    io.emit("live_update", {
        ips: liveIPs,
        stats: stats,
        timestamp: Date.now()
    });
}, 3000);

setInterval(() => {
    const currentMinute = Math.floor(Date.now() / 60000);
    for (let ip in minuteTracker) {
        if (minuteTracker[ip].minute < currentMinute - 2) {
            delete minuteTracker[ip];
        }
    }
}, 60000);

setInterval(() => {
    if (settings.block_duration > 0) {
        const expireTime = Date.now() - (settings.block_duration * 1000);
        
        try {
            const rows = db.prepare("SELECT ip FROM ips WHERE blocked = 1 AND blocked_at < ?").all(expireTime);
            rows.forEach(row => {
                unblockIP(row.ip);
                console.log(`⏰ Auto-unblocked: ${row.ip} (duration expired)`);
            });
        } catch (err) {
            console.error("Auto-unblock error:", err);
        }
    }
}, 30000);

// Start network monitoring
setInterval(analyzeNetworkActivity, 3000);
setTimeout(analyzeNetworkActivity, 1000);

console.log("✓ Real-time network monitoring started (3s interval)");

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 1920;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   🏔️  Cave DDoS Shield Started  🏔️      ║
╠═══════════════════════════════════════════╣
║   Port: ${PORT}                             ║
║   Status: ✓ Running                       ║
║   Database: ✓ Connected                   ║
║   Socket.IO: ✓ Active                     ║
║   Network Monitor: ${isLinux ? '✓ Active' : '✗ Inactive (Linux required)'}   ║
╠═══════════════════════════════════════════╣
║   Admin API: http://0.0.0.0:${PORT}/api/admin  ║
║   Public API: http://0.0.0.0:${PORT}/api/public║
╚═══════════════════════════════════════════╝
    `);
});

process.on("SIGINT", () => {
    console.log("\n🛑 Shutting down...");
    server.close(() => {
        db.close();
        console.log("✓ Database closed");
        process.exit(0);
    });
});
