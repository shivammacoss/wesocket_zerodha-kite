const { KiteTicker } = require("kiteconnect");

const latestTicksByToken = new Map();

function toTokenArray(tokens) {
  if (!Array.isArray(tokens)) {
    tokens = [tokens];
  }

  return tokens
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0);
}

function normalizeMarketData(ticks) {
  return (ticks || []).map((t) => {
    const last_price = t.last_price;
    const change = t.change;

    let chp = 0;
    if (Number.isFinite(last_price) && Number.isFinite(change)) {
      const prev_close = last_price - change;
      if (prev_close) {
        chp = (change / prev_close) * 100;
      }
    }

    return {
      ...t,
      ltp: last_price,
      ch: change,
      chp: Number.isFinite(chp) ? chp.toFixed(2) : "0.00",
      high: t.ohlc?.high,
      low: t.ohlc?.low,
      open: t.ohlc?.open,
      close: t.ohlc?.close,
      bid: t.depth?.buy?.[0]?.price,
      ask: t.depth?.sell?.[0]?.price,
      time: t.last_trade_time ? new Date(t.last_trade_time).toLocaleTimeString() : "-",
    };
  });
}

module.exports = function createZerodhaTickerBridge({ io, apiKey }) {
  let ticker = null;
  let tickerConnected = false;
  let currentAccessToken = null;

  const socketSubscriptions = new Map();
  let currentUnionTokens = [];

  function getUnionTokens() {
    const union = new Set();
    for (const set of socketSubscriptions.values()) {
      for (const token of set) union.add(token);
    }
    return Array.from(union);
  }

  function applySubscriptions() {
    if (!ticker) return;

    const tokens = getUnionTokens();

    const prev = currentUnionTokens;
    const next = tokens;

    if (prev.length > 0) {
      ticker.unsubscribe(prev);
    }

    if (next.length > 0) {
      ticker.subscribe(next);
      ticker.setMode(ticker.modeFull, next);
    }

    currentUnionTokens = next;
  }

  function bindIoHandlersOnce() {
    if (io.__zerodhaBridgeHandlersRegistered) return;
    io.__zerodhaBridgeHandlersRegistered = true;

    io.on("connection", (socket) => {
      socketSubscriptions.set(socket.id, new Set());

      socket.on("subscribe", (tokens) => {
        const normalized = toTokenArray(tokens);
        const set = socketSubscriptions.get(socket.id);
        if (!set) return;

        for (const t of normalized) set.add(t);
        applySubscriptions();
      });

      socket.on("unsubscribe", (tokens) => {
        const normalized = toTokenArray(tokens);
        const set = socketSubscriptions.get(socket.id);
        if (!set) return;

        for (const t of normalized) set.delete(t);
        applySubscriptions();
      });

      socket.on("setSubscriptions", (tokens) => {
        const normalized = toTokenArray(tokens);
        socketSubscriptions.set(socket.id, new Set(normalized));
        applySubscriptions();
      });

      socket.on("disconnect", () => {
        socketSubscriptions.delete(socket.id);
        applySubscriptions();
      });
    });
  }

  function start(accessToken) {
    if (!accessToken) return;

    currentAccessToken = accessToken;

    if (ticker) {
      try {
        ticker.disconnect();
      } catch (e) {
        // ignore
      }
      ticker = null;
      tickerConnected = false;
    }

    ticker = new KiteTicker({
      api_key: apiKey,
      access_token: currentAccessToken,
    });

    ticker.on("connect", () => {
      tickerConnected = true;
      io.emit("serviceStatus", getStatus());
      applySubscriptions();
    });

    ticker.on("disconnect", () => {
      tickerConnected = false;
      io.emit("serviceStatus", getStatus());
    });

    ticker.on("error", () => {
      tickerConnected = false;
      io.emit("serviceStatus", getStatus());
    });

    ticker.on("ticks", (ticks) => {
      for (const t of ticks || []) {
        const token = Number(t.instrument_token);
        if (Number.isFinite(token) && token > 0) {
          latestTicksByToken.set(token, t);
        }
      }
      io.emit("marketData", normalizeMarketData(ticks));
    });

    bindIoHandlersOnce();
    ticker.connect();
  }

  function getStatus() {
    return {
      tickerConnected,
      hasAccessToken: Boolean(currentAccessToken),
      subscribedTokenCount: getUnionTokens().length,
    };
  }

  bindIoHandlersOnce();

  return {
    start,
    getStatus,
    getLatestTick(token) {
      const t = Number(token);
      if (!Number.isFinite(t)) return null;
      return latestTicksByToken.get(t) || null;
    },
    getLatestPrice(token) {
      const tick = this.getLatestTick(token);
      const p = tick?.last_price;
      return Number.isFinite(p) ? p : null;
    },
    getLatestPrices(tokens) {
      const out = {};
      const arr = Array.isArray(tokens) ? tokens : [tokens];
      for (const tok of arr) {
        const t = Number(tok);
        if (!Number.isFinite(t)) continue;
        const p = this.getLatestPrice(t);
        if (p !== null) out[String(t)] = p;
      }
      return out;
    },
  };
};
