const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const SYMBOL = 'PAXGUSDT';
const BUY_AMOUNT_USD = 80;
const INTERVAL = 30000;

let filters = {};
let currentBuyOrder = null;
let currentSellOrder = null;
let lastBuyPrice = null;

async function binanceRequest(method, path, params = {}, isPrivate = false) {
  const baseURL = 'https://api.binance.com';
  const timestamp = Date.now();
  let query = new URLSearchParams(params);

  if (isPrivate) {
    query.append('timestamp', timestamp);
    const signature = crypto
      .createHmac('sha256', API_SECRET)
      .update(query.toString())
      .digest('hex');
    query.append('signature', signature);
  }

  const headers = isPrivate ? { 'X-MBX-APIKEY': API_KEY } : {};
  const url = `${baseURL}${path}?${query.toString()}`;
  const res = await axios({ method, url, headers });
  return res.data;
}

function roundStepSize(qty, stepSize) {
  return (Math.floor(qty / stepSize) * stepSize).toFixed(8);
}

function roundTickSize(price, tickSize) {
  return (Math.floor(price / tickSize) * tickSize).toFixed(2);
}

async function loadFilters() {
  const info = await binanceRequest('GET', '/api/v3/exchangeInfo');
  const symbolInfo = info.symbols.find(s => s.symbol === SYMBOL);
  const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
  const minNotional = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  filters = {
    stepSize: parseFloat(lotSize.stepSize),
    tickSize: parseFloat(priceFilter.tickSize),
    minNotional: parseFloat(minNotional.minNotional)
  };
}

async function checkOpenOrders() {
  const orders = await binanceRequest('GET', '/api/v3/openOrders', { symbol: SYMBOL }, true);
  currentBuyOrder = orders.find(o => o.side === 'BUY');
  currentSellOrder = orders.find(o => o.side === 'SELL');
}

async function placeBuyOrder(price) {
  const qty = roundStepSize(BUY_AMOUNT_USD / price, filters.stepSize);
  console.log(`Đặt MUA ${qty} ${SYMBOL} tại ${price}`);
  const order = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL,
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: qty,
    price: price
  }, true);
  currentBuyOrder = order;
}

async function placeSellOrder(price, qty) {
  qty = roundStepSize(qty, filters.stepSize);
  console.log(`Đặt BÁN ${qty} ${SYMBOL} tại ${price}`);
  const order = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL,
    side: 'SELL',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: qty,
    price: price
  }, true);
  currentSellOrder = order;
}

async function checkFilledOrders() {
  if (currentBuyOrder) {
    const order = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL,
      orderId: currentBuyOrder.orderId
    }, true);
    if (order.status === 'FILLED') {
      console.log(`Mua khớp tại ${order.price}`);
      lastBuyPrice = parseFloat(order.price);
      currentBuyOrder = null;
      await placeSellOrder(roundTickSize(lastBuyPrice + 100, filters.tickSize), parseFloat(order.executedQty));
    }
  }
  if (currentSellOrder) {
    const order = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL,
      orderId: currentSellOrder.orderId
    }, true);
    if (order.status === 'FILLED') {
      console.log(`Bán khớp tại ${order.price}`);
      currentSellOrder = null;
      lastBuyPrice = null;
    }
  }
}

async function botLoop() {
  try {
    await checkOpenOrders();
    await checkFilledOrders();

    if (!currentBuyOrder && !currentSellOrder) {
      const ticker = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
      const currentPrice = parseFloat(ticker.price);
      const buyPrice = roundTickSize(currentPrice - 50, filters.tickSize);
      await placeBuyOrder(buyPrice);
    }
  } catch (err) {
    console.error('Lỗi:', err.response?.data || err.message);
  }
}

(async () => {
  await loadFilters();
  console.log('Bot PAXG chạy...');
  setInterval(botLoop, INTERVAL);
})();

app.get('/', (req, res) => {
  res.send('Bot PAXG đang chạy...');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on port ${process.env.PORT || 3000}`);
});
