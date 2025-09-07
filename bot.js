'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios').default;

const app = express();
const PORT = process.env.PORT || 3000;

// Lấy API key/secret từ Environment Variables
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
  console.error('❌ Missing BINANCE_API_KEY or BINANCE_API_SECRET in environment variables');
  process.exit(1);
}

// Chuẩn hóa symbol
function normalizeSymbol(query) {
  let { symbol, coin } = query;
  if (symbol && typeof symbol === 'string') {
    return symbol.trim().toUpperCase();
  }
  if (coin && typeof coin === 'string') {
    const c = coin.trim().toUpperCase();
    return c.endsWith('USDT') ? c : `${c}USDT`;
  }
  return 'PAXGUSDT';
}

// Gọi API public Binance
async function binancePublic(path, params = {}) {
  const base = 'https://api.binance.com';
  const res = await axios.get(`${base}${path}`, { params, timeout: 10_000 });
  return res.data;
}

// Gọi API signed Binance
async function binanceSigned(path, method, params = {}) {
  const base = 'https://api.binance.com';
  const timestamp = Date.now();
  const recvWindow = 10_000;

  const allParams = { ...params, timestamp, recvWindow };
  const query = new URLSearchParams(allParams).toString();
  const signature = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');

  const url = `${base}${path}?${query}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': BINANCE_API_KEY };

  const res = await axios.request({
    url,
    method,
    headers,
    timeout: 10_000,
  });

  return res.data;
}

// Lấy filters và minNotional
function extractFilters(symbolInfo) {
  const filters = symbolInfo?.filters || [];
  const minNotionalFilter = filters.find(f => f.filterType === 'MIN_NOTIONAL') || null;
  let minNotional = null;
  if (minNotionalFilter) {
    minNotional = minNotionalFilter.minNotional ?? minNotionalFilter.notional ?? null;
  }
  return { filters, minNotional };
}

// Lấy số dư asset
function getAssetBalance(balances, asset) {
  const b = balances.find(x => x.asset === asset);
  if (!b) return { free: 0, locked: 0, total: 0 };
  const free = parseFloat(b.free || '0');
  const locked = parseFloat(b.locked || '0');
  return { free, locked, total: free + locked };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/check', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query);
    const baseAsset = symbol.replace(/USDT$/i, '');

    // 1) Giá hiện tại
    const priceData = await binancePublic('/api/v3/ticker/price', { symbol });
    const price = parseFloat(priceData.price);

    // 2) Thông tin sàn (filters, minNotional)
    const exInfo = await binancePublic('/api/v3/exchangeInfo', { symbol });
    const symbolInfo = exInfo.symbols?.[0] || null;
    if (!symbolInfo) {
      return res.status(400).json({ error: 'Symbol not found on Binance', symbol });
    }
    const { filters, minNotional } = extractFilters(symbolInfo);

    // 3) Số dư tài khoản
    const account = await binanceSigned('/api/v3/account', 'GET');
    const usdt = getAssetBalance(account.balances || [], 'USDT');
    const coin = getAssetBalance(account.balances || [], baseAsset);

    res.json({
      symbol,
      price,
      baseAsset: symbolInfo.baseAsset,
      quoteAsset: symbolInfo.quoteAsset,
      filters,
      minNotional,
      balances: {
        USDT: usdt,
        [symbolInfo.baseAsset]: coin,
      },
      ts: new Date().toISOString(),
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data || err.message || 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Service listening on port ${PORT}`);
});

const url = 'https://bn-5l7b.onrender.com/health'; // endpoint
setInterval(() => {
  axios.get(url)
    .then(res => console.log(`Ping at ${new Date().toISOString()} - ${res.status}`))
    .catch(err => console.error(`Ping error: ${err.message}`));
}, 14 * 60 * 1000); // 14 min


