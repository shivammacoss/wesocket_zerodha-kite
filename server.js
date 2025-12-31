require("dotenv").config();

const cors = require("cors");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { KiteConnect } = require("kiteconnect");

const createZerodhaTickerBridge = require("./sockets/zerodhaTicker");

const PORT = process.env.PORT || 7000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes("*")) return cb(null, true);
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
  })
);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
});

const kite = new KiteConnect({
  api_key: process.env.KITE_API_KEY,
});

let accessToken = null;

const zerodhaBridge = createZerodhaTickerBridge({
  io,
  apiKey: process.env.KITE_API_KEY,
});

app.get("/", (req, res) => {
  res.json({
    service: "ws-service",
    ok: true,
    hasAccessToken: Boolean(accessToken),
    tickerConnected: zerodhaBridge.getStatus().tickerConnected,
  });
});

app.get("/prices", (req, res) => {
  const tokensRaw = String(req.query.tokens || "");
  const tokens = tokensRaw
    .split(",")
    .map((t) => Number(String(t).trim()))
    .filter((t) => Number.isFinite(t) && t > 0);

  const prices = zerodhaBridge.getLatestPrices(tokens);
  res.json({
    ok: true,
    count: Object.keys(prices).length,
    prices,
  });
});

app.get("/auth/zerodha/login", (req, res) => {
  try {
    const loginURL = kite.getLoginURL();
    res.redirect(loginURL);
  } catch (error) {
    res
      .status(500)
      .send("Error generating Zerodha login URL. Check KITE_API_KEY.");
  }
});

app.get("/auth/zerodha/callback", async (req, res) => {
  try {
    const { request_token } = req.query;

    if (!request_token) {
      res.status(400).send("Missing request_token");
      return;
    }

    const session = await kite.generateSession(
      request_token,
      process.env.KITE_API_SECRET
    );

    accessToken = session.access_token;

    console.log("Zerodha login successful");
    if (accessToken) {
      console.log(`Access token received: ${String(accessToken).slice(0, 8)}...`);
    }

    zerodhaBridge.start(accessToken);

    res.send("Zerodha login successful. WebSocket stream is now live.");
  } catch (err) {
    console.error("Zerodha authentication failed:", err);
    res.status(500).send("Zerodha authentication failed");
  }
});

io.on("connection", (socket) => {
  socket.emit("serviceStatus", {
    hasAccessToken: Boolean(accessToken),
    ...zerodhaBridge.getStatus(),
  });
});

server.listen(PORT, () => {
  console.log(`ws-service running on port ${PORT}`);
  console.log(`Login URL: http://localhost:${PORT}/auth/zerodha/login`);
});
