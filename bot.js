// bot.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios').default;
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Postgres pool with SSL for Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Fetch API key/secret from DB (label = 'default', change if needed)
async function getBinanceKeys(label = 'default') {
  const q = 'SELECT api_key, api_secret FROM binance_api_keys WHERE label = $1 LIMIT 1';
  const { rows } = await pool.query(q, [label]);
  if (!rows.length) {
    const e = new Error('No Binance API keys found in DB for label: ' + label);
    e.status = 500;
    throw e;
  }
  return { apiKey: rows[0].api_key, apiSecret: rows[0].api_secret };
}

// Normalize input: accept ?symbol=BTCUSDT or ?coin=BTC
function normalizeSymbol(query) {
  let { symbol, coin } = query;
  if (symbol && typeof symbol === 'string') {
    return symbol.trim().toUpperCase();
  }
  if (coin && typeof coin === 'string') {
    const c = coin.trim().toUpperCase();
    // Default quote is USDT
    return c.endsWith('USDT') ? c : `${c}USDT`;
  }
  // Default symbol if nothing provided
  return 'PAXGUSDT';
}

// Call Binance public
async function binancePublic(path, params = {}) {
  const base = 'https://api.binance.com';
  const res = await axios.get(`${base}${path}`, { params, timeout: 10_000 });
  return res.data;
}

// Call Binance signed (account endpoints)
async function binanceSigned(path, method, apiKey, apiSecret, params = {}) {
  const base = 'https://api.binance.com';
  const timestamp = Date.now();
  const recvWindow = 10_000;

  const allParams = { ...params, timestamp, recvWindow };
  const query = new URLSearchParams(allParams).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');

  const url = `${base}${path}?${query}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': apiKey };

  const res = await axios.request({
    url,
    method,
    headers,
    timeout: 10_000,
  });

  return res.data;
}

// Extract filters and minNotional
function extractFilters(symbolInfo) {
  const filters = symbolInfo?.filters || [];
  // Binance historically used MIN_NOTIONAL with field minNotional; some variants use notional
  const minNotionalFilter = filters.find(f => f.filterType === 'MIN_NOTIONAL') || null;
  let minNotional = null;
  if (minNotionalFilter) {
    minNotional = minNotionalFilter.minNotional ?? minNotionalFilter.notional ?? null;
  }
  return { filters, minNotional };
}

// Format balances (free/locked/total as numbers)
function getAssetBalance(balances, asset) {
  const b = balances.find(x => x.asset === asset);
  if (!b) return { free: 0, locked: 0, total: 0 };
  const free = parseFloat(b.free || '0');
  const locked = parseFloat(b.locked || '0');
  const total = free + locked;
  return { free, locked, total };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/check', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query);
    const baseAsset = symbol.replace(/USDT$/i, ''); // works for default USDT quote
    const { apiKey, apiSecret } = await getBinanceKeys('default');

    // 1) Price
    const priceData = await binancePublic('/api/v3/ticker/price', { symbol });
    const price = parseFloat(priceData.price);

    // 2) Exchange info (filters, minNotional)
    const exInfo = await binancePublic('/api/v3/exchangeInfo', { symbol });
    const symbolInfo = exInfo.symbols?.[0] || null;
    if (!symbolInfo) {
      return res.status(400).json({ error: 'Symbol not found on Binance', symbol });
    }
    const { filters, minNotional } = extractFilters(symbolInfo);

    // 3) Account balances
    const account = await binanceSigned('/api/v3/account', 'GET', apiKey, apiSecret);
    const usdt = getAssetBalance(account.balances || [], 'USDT');
    const coin = getAssetBalance(account.balances || [], baseAsset);

    res.json({
      symbol,
      price,
      baseAsset: symbolInfo.baseAsset,
      quoteAsset: symbolInfo.quoteAsset,
      filters,           // full filters from Binance
      minNotional,       // highlighted
      balances: {
        USDT: usdt,
        [symbolInfo.baseAsset]: coin,
      },
      ts: new Date().toISOString(),
    });
  } catch (err) {
    const status = err.status || err.response?.status || 500;
    const message = err.response?.data || err.message || 'Unknown error';
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Service listening on port ${PORT}`);
});
