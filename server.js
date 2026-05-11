require("dotenv").config(); // if using .env file

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "default_jwt_refresh_secret";
const ALLOWED_EMAIL_1 = process.env.ALLOWED_EMAIL_1 || "email1@example.com";
const ALLOWED_EMAIL_2 = process.env.ALLOWED_EMAIL_2 || "email2@example.com";
const OLD_PASSWORD = process.env.OLD_PASSWORD || "oldpassword";
const NEW_PASSWORD = process.env.NEW_PASSWORD || "newpassword";

// Initialize file logging
const logStream = fs.createWriteStream(path.join(__dirname, "server.log"), {
  flags: "a",
});
const log = (msg) => {
  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${timestamp}] ${msg}\n`;
  console.log(line.trim());
  logStream.write(line);
};

// Initialize Firebase  SDK
// const serviceAccount = require(process.env.Secret)
// admin.initializeApp({ credential: admin.credential.cert(process.env.Secret) });
let secretObj;
try {
  secretObj = JSON.parse(process.env.Secret);
  if (secretObj.private_key) {
    secretObj.private_key = secretObj.private_key.replace(/\\n/g, '\n');
  }
} catch (err) {
  console.error("Failed to parse process.env.Secret:", err);
}

admin.initializeApp({
  credential: admin.credential.cert(secretObj),
});


const app = express();
const server = http.createServer(app);
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Auth API
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  const isAllowedEmail = email === ALLOWED_EMAIL_1 || email === ALLOWED_EMAIL_2 || email === "test@test.com";
  const isAllowedPassword = password === OLD_PASSWORD || password === NEW_PASSWORD || password === "test";

  if (isAllowedEmail && isAllowedPassword) {
    const workspace = (email === ALLOWED_EMAIL_1 || email === ALLOWED_EMAIL_2) ? "production" : "test";
    const accessToken = jwt.sign({ email, workspace }, JWT_SECRET, { expiresIn: "15m" });
    const refreshToken = jwt.sign({ email, workspace }, JWT_REFRESH_SECRET, { expiresIn: "7d" });
    res.json({ accessToken, refreshToken, user: { email, workspace } });
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
});

app.post("/auth/check-password", (req, res) => {
  const { password } = req.body;
  const isAllowedPassword = password === OLD_PASSWORD || password === NEW_PASSWORD || password === "test";
  if (isAllowedPassword) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

app.post("/auth/refresh", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: "Refresh token required" });

  jwt.verify(refreshToken, JWT_REFRESH_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid refresh token" });
    const accessToken = jwt.sign({ email: user.email, workspace: user.workspace }, JWT_SECRET, { expiresIn: "15m" });
    res.json({ accessToken });
  });
});

const verifyToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1] || req.query.token;
  if (!token) return res.status(401).json({ error: "A token is required for authentication" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    return res.status(401).json({ error: "Invalid Token" });
  }
  return next();
};



// Upload directory setup
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Create private directory for old files
const privateDir = path.join(__dirname, "private_uploads");
if (!fs.existsSync(privateDir)) fs.mkdirSync(privateDir);

// Ensure workspace directories exist
["production", "test"].forEach((ws) => {
  const pubWs = path.join(uploadDir, ws);
  const privWs = path.join(privateDir, ws);
  if (!fs.existsSync(pubWs)) fs.mkdirSync(pubWs, { recursive: true });
  if (!fs.existsSync(privWs)) fs.mkdirSync(privWs, { recursive: true });
});

app.use("/uploads", verifyToken, express.static(uploadDir));
app.use("/private_uploads", verifyToken, express.static(privateDir));

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const workspace = req.user?.workspace || "test";
    const dest = path.join(uploadDir, workspace);
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const fname = uuidv4() + ext;
    cb(null, fname);
  },
});
const upload = multer({ storage });

// In-memory maps (workspace specific)
const mediaMap = { production: new Map(), test: new Map() };
const urlToKeyMap = { production: new Map(), test: new Map() };
const messageQueue = { production: [], test: [] };

/**
 * Cleanup function to move old files to private directory
 */
async function cleanupOldFiles() {
  try {
    const now = Date.now();
    for (const ws of ["production", "test"]) {
      const wsUploadDir = path.join(uploadDir, ws);
      const wsPrivateDir = path.join(privateDir, ws);
      const files = await fs.promises.readdir(wsUploadDir);
      let movedCount = 0;

      for (const file of files) {
        const filePath = path.join(wsUploadDir, file);
        try {
          const stats = await fs.promises.stat(filePath);
          const fileAge = (now - stats.birthtimeMs) / (1000 * 60); // minutes

          if (fileAge > 10) {
            const destPath = path.join(wsPrivateDir, file);
            await fs.promises.rename(filePath, destPath);
            movedCount++;

            const publicUrl = `/uploads/${ws}/${file}`;
            if (urlToKeyMap[ws].has(publicUrl)) {
              const key = urlToKeyMap[ws].get(publicUrl);
              mediaMap[ws].delete(key);
              urlToKeyMap[ws].delete(publicUrl);
            }
          }
        } catch (err) {
          if (err.code !== "ENOENT") {
            log(`Error processing file ${file} in ${ws}: ${err.message}`);
          }
        }
      }

      if (movedCount > 0) {
        log(`Moved ${movedCount} old files to private directory for ${ws}`);
      }
    }
  } catch (err) {
    log(`File cleanup error: ${err.message}`);
  }
}

// Schedule cleanup every 5 minutes
setInterval(
  () => cleanupOldFiles().catch((err) => log(`Cleanup error: ${err.message}`)),
  5 * 60 * 1000
);

// Run immediately on startup, non-blocking
cleanupOldFiles().catch((err) => log(`Initial cleanup error: ${err.message}`));

app.post("/upload", verifyToken, upload.single("file"), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded." });

    const workspace = req.user.workspace || "test";
    const url = `${req.protocol}://${req.get("host")}/uploads/${workspace}/${file.filename}`;
    const key = req.body.key;
    if (key) {
      mediaMap[workspace].set(key, url);
      urlToKeyMap[workspace].set(url, key);
    }
    log(`Mapped key ${key} => ${url} in ${workspace}`);

    const queue = messageQueue[workspace];
    for (let i = queue.length - 1; i >= 0; i--) {
      const queued = queue[i];
      let { msg, unresolvedKeys } = queued;

      unresolvedKeys = unresolvedKeys.filter((k) => k !== key);
      msg.text = msg.text.split(key).join(url);

      if (unresolvedKeys.length === 0) {
        io.to(workspace).emit("newMessage", msg);
        log(`Broadcast queued message ${msg.id} after resolving all blobs in ${workspace}`);
        queue.splice(i, 1);
      } else {
        queued.unresolvedKeys = unresolvedKeys;
      }
    }

    res.json({ url, key });
  } catch (err) {
    log(`Error in /upload: ${err.message}`);
    res.status(500).json({ error: "Failed to upload file." });
  }
});

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "UP", timestamp: new Date().toISOString() }));

// Utility to list media files in a directory
async function getMediaFiles(dir, baseUrlPath) {
  const validExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".mp4",
    ".webm",
    ".mov",
  ];
  try {
    const files = await fs.promises.readdir(dir);
    return files
      .filter((file) =>
        validExtensions.includes(path.extname(file).toLowerCase())
      )
      .map((file) => `${baseUrlPath}/${file}`);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// Route to fetch all images/videos
app.get("/media", verifyToken, async (req, res) => {
  try {
    const workspace = req.user.workspace || "test";
    const host = `${req.protocol}://${req.get("host")}`;
    const publicFiles = await getMediaFiles(path.join(uploadDir, workspace), `${host}/uploads/${workspace}`);
    const privateFiles = await getMediaFiles(
      path.join(privateDir, workspace),
      `${host}/private_uploads/${workspace}`
    );
    res.status(200).json({
      public: publicFiles,
      private: privateFiles,
      total: publicFiles.length + privateFiles.length,
    });
  } catch (err) {
    log(`Error in /media: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch media files" });
  }
});

// Route to delete all files in both directories
app.delete("/media", verifyToken, async (req, res) => {
  try {
    const workspace = req.user.workspace || "test";
    const wsUploadDir = path.join(uploadDir, workspace);
    const wsPrivateDir = path.join(privateDir, workspace);

    await Promise.all([
      fs.promises.rm(wsUploadDir, { recursive: true, force: true }),
      fs.promises.rm(wsPrivateDir, { recursive: true, force: true }),
    ]);
    fs.mkdirSync(wsUploadDir, { recursive: true });
    fs.mkdirSync(wsPrivateDir, { recursive: true });
    res.status(200).json({ success: true, message: "All files deleted." });
  } catch (err) {
    log(`Error deleting all files: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route to delete all files in a specific scope (public or private)
app.delete("/media/:scope", verifyToken, async (req, res) => {
  const { scope } = req.params;
  const workspace = req.user.workspace || "test";
  if (scope !== "public" && scope !== "private") {
    return res.status(400).json({ success: false, error: "Invalid scope" });
  }
  const dir = path.join(scope === "private" ? privateDir : uploadDir, workspace);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    res
      .status(200)
      .json({ success: true, message: `All ${scope} files deleted.` });
  } catch (err) {
    log(`Error deleting ${scope} files: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route to delete a specific file in a scope
app.delete("/media/:scope/:filename", verifyToken, async (req, res) => {
  const { scope, filename } = req.params;
  const workspace = req.user.workspace || "test";
  if (scope !== "public" && scope !== "private") {
    return res.status(400).json({ success: false, error: "Invalid scope" });
  }
  const dir = path.join(scope === "private" ? privateDir : uploadDir, workspace);
  const filePath = path.join(dir, filename);
  try {
    await fs.promises.unlink(filePath);
    res
      .status(200)
      .json({ success: true, message: `${filename} deleted from ${scope}.` });
  } catch (err) {
    log(`Error deleting file ${filename} from ${scope}: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Notification helpers (Firebase Cloud Messaging)
const hardcodedFcmToken = "f-gjjLPDSCGcM8Z4FMEhuj:APA91bELrg22C2HArsLuA9bhdVBpA1mWuKBr_2-v2SYHqZ5MQyR9v8LJpdq0QlvePFGLRRCng53cO-fis0hwYQOUd_GtJnjDnKXG88WvRqpU1Ul_0cpolqM";
const sendNotification = async (customBody, clientIp) => {
  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const bodyWithTs = `${customBody} at ${timestamp}${clientIp ? ` (IP: ${clientIp})` : ""
    }`;
  const message = {
    token: hardcodedFcmToken,
    notification: { title: "Socket Status Update", body: bodyWithTs },
    data: { timestamp, ...(clientIp && { clientIp }) },
  };
  log(`Sending notification: "${message.notification.body}"`);
  const response = await admin.messaging().send(message);
  log(`Notification sent successfully, message ID: ${response}`);
  return { messageId: response, timestamp };
};

// Manual notify endpoint
app.get("/notify", verifyToken, async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  if (
    ["127.0.0.1", "::1"].includes(clientIp) ||
    clientIp.match(/^(10\.|192\.168\.|172\.16\.)/)
  ) {
    log(`Internal IP ${clientIp} - skipping notification`);
    return res.status(200).json({
      success: true,
      message: "Health check/internal call",
      ip: clientIp,
    });
  }
  log(`Received GET /notify from IP: ${clientIp}`);
  try {
    const result = await sendNotification(
      "Manual notification triggered",
      clientIp
    );
    res.status(200).json({ success: true, ...result, ip: clientIp });
  } catch (err) {
    log(`Error in /notify: ${err}`);
    res
      .status(500)
      .json({ success: false, error: "Failed to send notification" });
  }
});

// Website visit endpoint
app.get("/website", verifyToken, async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  log(`Received GET /website from IP: ${clientIp}`);
  try {
    const result = await sendNotification("Visitor at /website", clientIp);
    res.status(200).json({ success: true, ...result, ip: clientIp });
  } catch (err) {
    log(`Error in /website: ${err.message}`);
    res
      .status(500)
      .json({ success: false, error: "Failed to send notification" });
  }
});

// Socket.IO setup
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (!token) {
    return next(new Error("Authentication error"));
  }
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Authentication error"));
    socket.user = decoded;
    next();
  });
});

io.on("connection", (socket) => {
  const workspace = socket.user?.workspace || "test";
  socket.join(workspace);

  const clientIp =
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    socket.handshake.address;
  log(`Client connected: ${socket.id} from IP: ${clientIp} in workspace: ${workspace}`);
  sendNotification(`A new client connected to ${workspace}. Socket ID: ${socket.id}`, clientIp);

  socket.on("blobUploadComplete", ({ key, url }) => {
    mediaMap[workspace].set(key, url);
    urlToKeyMap[workspace].set(url, key);
    log(`Received blobUploadComplete for ${key} -> ${url} in ${workspace}`);

    const queue = messageQueue[workspace];
    for (let i = queue.length - 1; i >= 0; i--) {
      const queued = queue[i];
      let { msg, unresolvedKeys } = queued;

      unresolvedKeys = unresolvedKeys.filter((k) => k !== key);
      msg.text = msg.text.split(key).join(url);

      if (unresolvedKeys.length === 0) {
        io.to(workspace).emit("newMessage", msg);
        log(`Broadcast queued message ${msg.id} after resolving all blobs in ${workspace}`);
        queue.splice(i, 1);
      } else {
        queued.unresolvedKeys = unresolvedKeys;
      }
    }
  });

  socket.on("clearMessages", () => {
    io.to(workspace).emit("clearMessages");
    log(`Workspace ${workspace} messages cleared by ${socket.id}`);
  });

  socket.on("sendMessage", async (msg) => {
    log(`sendMessage from ${socket.id} in ${workspace}: ${JSON.stringify(msg)}`);

    if (msg.media && msg.mediaUrl) {
      io.to(workspace).emit("newMessage", msg);
      return;
    }

    let text = msg.text;
    const unresolvedKeys = [];

    mediaMap[workspace].forEach((url, key) => {
      if (text.includes(key)) {
        text = text.split(key).join(url);
      }
    });

    const blobRegex = /blob:[^\s]+/g;
    const blobUrls = text.match(blobRegex) || [];
    for (const blobUrl of blobUrls) {
      if (!mediaMap[workspace].has(blobUrl)) {
        unresolvedKeys.push(blobUrl);
        socket.emit("requestBlobUpload", blobUrl);
        log(`Requested client to upload blob ${blobUrl}`);
      }
    }

    if (unresolvedKeys.length > 0) {
      messageQueue[workspace].push({ msg: { ...msg, text }, unresolvedKeys });
      return;
    }

    const modifiedMsg = { ...msg, text };
    io.to(workspace).emit("newMessage", modifiedMsg);
  });

  socket.on("disconnect", () => {
    log(`Client disconnected: ${socket.id} from ${workspace}`);
    sendNotification(
      `A client disconnected from ${workspace}. Socket ID: ${socket.id}`,
      clientIp
    );
  });
});

// Start server
server.listen(5000, "0.0.0.0", () => {
  log("Socket.io server running on port 5000 and accepting all IPs");
});


