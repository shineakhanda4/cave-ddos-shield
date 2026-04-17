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
const fs = require("fs");
const path = require("path");

const execAsync = promisify(exec);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Cave Security Configuration
const JWT_SECRET = process.env.JWT_SECRET || "cave-mountain-secret-key-change-in-production-" + Math.random().toString(36).substring(2);
const JWT_EXPIRES_IN = "24h";
const SALT_ROUNDS = 10;

// Cave branding
const CAVE_NAME = process.env.CAVE_NAME || "Cave DDoS Shield";
const CAVE_VERSION = "2.1.0";
const CAVE_MOTD = "🏔️ The mountain protects its own 🏔️";

app.use(express.json());
app.use(cookieParser());

// Rate limiting for cave entrance attempts
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    message: { error: "Too many attempts to enter the cave. Wait 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting for cave API
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100,
    message: { error: "The cave walls are trembling. Slow down." },
    standardHeaders: true,
    legacyHeaders: false,
});

/* ============================
   CAVE DATABASE SETUP
============================ */
const dbPath = process.env.DB_PATH || "./cave_shield.db";
const db = new Database(dbPath);

console.log(`
╔═══════════════════════════════════════════╗
║   🏔️  ${CAVE_NAME} Database    🏔️
╠═══════════════════════════════════════════╣
║   Path: ${dbPath}
║   Status: Connected to the mountain
╚═══════════════════════════════════════════╝
`);

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = 10000");
db.pragma("temp_store = MEMORY");

// Create tables with cave-themed comments
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
        threat_level TEXT DEFAULT 'low',
        cave_notes TEXT,
        attack_pattern TEXT,
        last_attack_type TEXT
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS attack_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT,
        timestamp INTEGER,
        requests INTEGER,
        bandwidth INTEGER,
        action TEXT,
        attack_vector TEXT,
        mitigated_by TEXT
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
        intelligent_blocking INTEGER DEFAULT 1,
        cave_mode INTEGER DEFAULT 1,
        alert_threshold INTEGER DEFAULT 75
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email TEXT,
        role TEXT DEFAULT 'guardian',
        created_at INTEGER,
        last_login INTEGER,
        login_attempts INTEGER DEFAULT 0,
        locked_until INTEGER DEFAULT 0,
        cave_access_level INTEGER DEFAULT 1
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
        cave_location TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

// Create cave metrics table for historical data
db.exec(`
    CREATE TABLE IF NOT EXISTS cave_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        total_attacks INTEGER,
        blocked_attacks INTEGER,
        peak_connections INTEGER,
        avg_threat_score REAL,
        system_load REAL,
        memory_usage REAL
    )
`);

// Insert default settings with cave theme
const insertSettings = db.prepare("INSERT OR IGNORE INTO settings (id, cave_mode) VALUES (?, ?)");
insertSettings.run(1, 1);

// Create default guardian user
const defaultPassword = "admin123";
const hash = bcrypt.hashSync(defaultPassword, SALT_ROUNDS);

const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password, email, role, created_at, cave_access_level) 
    VALUES (?, ?, ?, ?, ?, ?)
`);

try {
    insertUser.run("admin", hash, "guardian@cave.local", "guardian", Date.now(), 3);
    console.log(`
╔═══════════════════════════════════════════╗
║   🏔️  Default Guardian Ready  🏔️
╠═══════════════════════════════════════════╣
║   Username: admin
║   Password: admin123
║   ⚠️  CHANGE PASSWORD IMMEDIATELY!
╚═══════════════════════════════════════════╝
    `);
} catch (err) {
    if (!err.message.includes("UNIQUE")) {
        console.error("Error creating default guardian:", err);
    }
}

/* ============================
   CAVE MEMORY CACHE
============================ */
let liveIPs = {};
let minuteTracker = {};
let caveCache = {
    lastCleanup: Date.now(),
    threatHistory: [],
    blockedHistory: [],
    peakConnections: 0
};

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
    intelligent_blocking: 1,
    cave_mode: 1,
    alert_threshold: 75
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
    last_scan: 0,
    cave_uptime: Date.now(),
    attacks_mitigated: 0,
    peak_threat_score: 0
};

/* ============================
   ENHANCED CAVE MONITORING
============================ */

// Get system metrics with cave flavor
async function getCaveMetrics() {
    const metrics = {
        load_1min: 0,
        load_5min: 0,
        load_15min: 0,
        memory_total: 0,
        memory_used: 0,
        memory_free: 0,
        memory_percent: 0,
        total_network_connections: 0,
        established_connections: 0,
        cave_temperature: 'stable',
        disk_usage: 0
    };
    
    try {
        // CPU load
        const loadAvg = os.loadavg();
        metrics.load_1min = loadAvg[0] || 0;
        metrics.load_5min = loadAvg[1] || 0;
        metrics.load_15min = loadAvg[2] || 0;
        
        // Memory
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        
        metrics.memory_total = Math.round(totalMem / 1024 / 1024);
        metrics.memory_used = Math.round(usedMem / 1024 / 1024);
        metrics.memory_free = Math.round(freeMem / 1024 / 1024);
        metrics.memory_percent = Math.round((usedMem / totalMem) * 100);
        
        // Cave temperature based on load
        if (metrics.load_1min > 2) metrics.cave_temperature = 'scorching';
        else if (metrics.load_1min > 1) metrics.cave_temperature = 'warm';
        else if (metrics.load_1min > 0.5) metrics.cave_temperature = 'temperate';
        else metrics.cave_temperature = 'cool';
        
        // Network stats (Linux only)
        if (os.platform() === 'linux') {
            try {
                const { stdout: connCount } = await execAsync(`ss -ntu 2>/dev/null | wc -l`);
                metrics.total_network_connections = parseInt(connCount.trim()) - 1 || 0;
                
                const { stdout: estabCount } = await execAsync(`ss -ntu state established 2>/dev/null | wc -l`);
                metrics.established_connections = parseInt(estabCount.trim()) - 1 || 0;
            } catch (e) {
                // Ignore network stats errors
            }
        }
        
    } catch (err) {
        console.error("Cave metrics error:", err);
    }
    
    return metrics;
}

// Enhanced block IP with cave logging
async function blockIP(ip, reason = "auto", attackVector = "unknown") {
    if (!isValidIPv4(ip)) {
        console.error(`❌ Invalid IP address for blocking: ${ip}`);
        return { success: false, message: "Invalid IP address" };
    }
    
    const platform = os.platform();
    if (platform !== 'linux') {
        console.log(`⚠️  Cannot block ${ip} - iptables requires Linux (running on ${platform})`);
        // Still mark as blocked in database
        dbRun("UPDATE ips SET blocked = 1, blocked_at = ? WHERE ip = ?", [Date.now(), ip]);
        return { success: true, message: "Marked as blocked (iptables unavailable)" };
    }
    
    try {
        // Check if already blocked
        const { stdout } = await execAsync(`iptables -L INPUT -n 2>/dev/null | grep ${ip}`);
        if (stdout.includes(ip)) {
            dbRun("UPDATE ips SET blocked = 1, blocked_at = ? WHERE ip = ?", [Date.now(), ip]);
            return { success: true, message: "Already blocked" };
        }
    } catch (err) {
        // Not blocked yet, proceed
    }

    try {
        await execAsync(`iptables -A INPUT -s ${ip} -j DROP`);
        
        const blockMessage = reason === "auto" ? "AUTOMATIC DEFENSE" : "GUARDIAN COMMAND";
        console.log(`🏔️ [${blockMessage}] Cave walls sealed against: ${ip} (${attackVector})`);
        
        stats.total_blocked++;
        stats.attacks_mitigated++;
        
        dbRun("UPDATE ips SET blocked = 1, blocked_at = ? WHERE ip = ?", [Date.now(), ip]);
        dbRun(`INSERT INTO attack_logs (ip, timestamp, requests, bandwidth, action, attack_vector, mitigated_by) 
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ip, Date.now(), liveIPs[ip]?.requests || 0, liveIPs[ip]?.bandwidth || 0, 
             `blocked_${reason}`, attackVector, 'cave_shield']);

        // Store in cave cache
        caveCache.blockedHistory.push({
            ip, reason, attackVector, timestamp: Date.now()
        });
        if (caveCache.blockedHistory.length > 100) {
            caveCache.blockedHistory.shift();
        }

        io.emit("ip_blocked", { 
            ip, 
            reason, 
            attackVector,
            timestamp: Date.now(),
            message: `🏔️ Cave walls sealed against ${ip}`
        });
        
        return { success: true, message: "IP blocked successfully" };
    } catch (err) {
        if (err.message.includes('already') || err.message.includes('exist')) {
            dbRun("UPDATE ips SET blocked = 1, blocked_at = ? WHERE ip = ?", [Date.now(), ip]);
            return { success: true, message: "Already blocked" };
        }
        console.error(`❌ Cave wall failed to seal against ${ip}:`, err.message);
        return { success: false, error: err.message };
    }
}

async function unblockIP(ip) {
    const platform = os.platform();
    if (platform !== 'linux') {
        console.log(`⚠️  Cannot unblock ${ip} - iptables requires Linux`);
        dbRun("UPDATE ips SET blocked = 0, blocked_at = NULL WHERE ip = ?", [ip]);
        return { success: true, message: "Marked as unblocked (iptables unavailable)" };
    }
    
    try {
        await execAsync(`iptables -D INPUT -s ${ip} -j DROP 2>/dev/null`);
        console.log(`🏔️ Cave entrance opened for: ${ip}`);
        
        dbRun("UPDATE ips SET blocked = 0, blocked_at = NULL WHERE ip = ?", [ip]);
        dbRun(`INSERT INTO attack_logs (ip, timestamp, action, mitigated_by) VALUES (?, ?, ?, ?)`,
            [ip, Date.now(), "unblocked", "guardian"]);

        io.emit("ip_unblocked", { 
            ip, 
            timestamp: Date.now(),
            message: `🏔️ Cave entrance opened for ${ip}`
        });
        
        return { success: true, message: "IP unblocked" };
    } catch (err) {
        console.error(`❌ Failed to open cave entrance for ${ip}:`, err.message);
        return { success: false, error: err.message };
    }
}

/* ============================
   ENHANCED AUTHENTICATION
============================ */

// Login with cave theme
app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Guardian name and cave key required" });
    }

    try {
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

        if (!user) {
            return res.status(401).json({ error: "Unknown guardian" });
        }

        // Check if account is locked
        if (user.locked_until > Date.now()) {
            const minutesLeft = Math.ceil((user.locked_until - Date.now()) / 60000);
            return res.status(423).json({ 
                error: `Cave entrance sealed. Try again in ${minutesLeft} minutes.` 
            });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            const attempts = user.login_attempts + 1;
            const lockedUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : 0;

            db.prepare(
                "UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?"
            ).run(attempts, lockedUntil, user.id);

            return res.status(401).json({ 
                error: "Incorrect cave key",
                attemptsLeft: Math.max(0, 5 - attempts)
            });
        }

        // Reset login attempts
        db.prepare(
            "UPDATE users SET login_attempts = 0, locked_until = 0, last_login = ? WHERE id = ?"
        ).run(Date.now(), user.id);

        // Generate JWT token
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, cave_level: user.cave_access_level },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Store session with cave location
        const clientIP = getClientIP(req);
        const userAgent = req.headers["user-agent"] || "unknown";
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

        db.prepare(
            `INSERT INTO sessions (user_id, token, ip_address, user_agent, created_at, expires_at, cave_location)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(user.id, token, clientIP, userAgent, Date.now(), expiresAt, 'main_entrance');

        // Set HTTP-only cookie
        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: "strict"
        });

        console.log(`🏔️ Guardian ${username} entered the cave from ${clientIP}`);

        res.json({
            success: true,
            message: `Welcome to the cave, Guardian ${username}`,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                cave_level: user.cave_access_level
            },
            token,
            motd: CAVE_MOTD
        });
    } catch (err) {
        console.error("Cave entrance error:", err);
        res.status(500).json({ error: "The cave walls rumble. Try again." });
    }
});

// Get cave status
app.get("/api/cave/status", (req, res) => {
    res.json({
        name: CAVE_NAME,
        version: CAVE_VERSION,
        motd: CAVE_MOTD,
        uptime: Math.floor((Date.now() - stats.cave_uptime) / 1000),
        status: "protected",
        threats: {
            critical: stats.critical_threats,
            high: stats.high_threats,
            medium: stats.medium_threats,
            blocked: stats.total_blocked
        },
        cave_temperature: stats.server_load > 1 ? 'warm' : 'cool'
    });
});

// Save cave metrics periodically
setInterval(async () => {
    try {
        const metrics = await getCaveMetrics();
        
        dbRun(`INSERT INTO cave_metrics 
               (timestamp, total_attacks, blocked_attacks, peak_connections, avg_threat_score, system_load, memory_usage)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [Date.now(), stats.total_requests, stats.total_blocked, 
             caveCache.peakConnections, 
             stats.suspicious_ips > 0 ? (stats.critical_threats * 100 + stats.high_threats * 50) / stats.suspicious_ips : 0,
             metrics.load_1min, metrics.memory_percent]);
             
        // Clean old metrics (keep 7 days)
        dbRun("DELETE FROM cave_metrics WHERE timestamp < ?", [Date.now() - 7 * 24 * 60 * 60 * 1000]);
        
    } catch (err) {
        console.error("Cave metrics save error:", err);
    }
}, 300000); // Every 5 minutes

/* ============================
   START CAVE SERVER
============================ */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    const platform = os.platform();
    const caveArt = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║         🏔️  🏔️  ${CAVE_NAME}  🏔️  🏔️           ║
║                    Version ${CAVE_VERSION}                          ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║   🏔️  The Mountain Protects  🏔️                              ║
║                                                               ║
║   Port: ${PORT}                                                  ║
║   Platform: ${platform}                                           ║
║   Database: ${dbPath}                    ║
║   Status: 🟢 Cave Shields Active                               ║
║                                                               ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║   Guardian Entrance: http://localhost:${PORT}/login.html          ║
║   Public View: http://localhost:${PORT}/public.html               ║
║   Cave API: http://localhost:${PORT}/api                         ║
║                                                               ║
╠═══════════════════════════════════════════════════════════════╣
║   ${CAVE_MOTD}                    ║
╚═══════════════════════════════════════════════════════════════╝
    `;
    console.log(caveArt);
    
    if (platform !== 'linux') {
        console.log(`
⚠️  NOTICE: Running on ${platform}
   Full network protection (iptables) requires Linux.
   The cave can still monitor but cannot automatically block.
        `);
    }
});

// Graceful cave closure
process.on("SIGINT", () => {
    console.log("\n🏔️ Sealing the cave entrance...");
    server.close(() => {
        console.log("✓ Cave entrance sealed");
        try {
            db.close();
            console.log("✓ Cave archives secured");
        } catch (err) {
            console.error("Archive sealing error:", err);
        }
        console.log("🏔️ The mountain sleeps. Goodbye, Guardian.");
        process.exit(0);
    });
    
    setTimeout(() => {
        console.log("⚠️  Forcing cave closure...");
        process.exit(1);
    }, 5000);
});

// ... (rest of the file remains with same functionality but cave-themed logging)
