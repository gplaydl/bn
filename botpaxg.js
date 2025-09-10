// botpaxg.js
'use strict';

const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ====== Cấu hình ======
const SYMBOL = 'PAXGUSDT';
const QUOTE = 'USDT';
const BASE = 'PAXG';
const BUY_AMOUNT_USD = 80;              // USDT cho mỗi lệnh mua
const INTERVAL = 30_000;                // 30s/lần
const ENABLE_REINVEST = true;           // tái đầu tư sau khi bán
const KEEPALIVE_URL = 'https://bn-5l7b.onrender.com/health';

// ====== API key ======
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
if (!API_KEY || !API_SECRET) {
  console.error('❌ Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET trong biến môi trường');
  process.exit(1);
}

// ====== Trạng thái ======
let filters = { stepSize: 0.00000001, tickSize: 0.01, minNotional: 0, minQty: 0 };
let currentBuyOrder = null;
let currentSellOrder = null;
let lastBuyPrice = null;

// ====== Gọi API Binance ======
async function binanceRequest(method, path, params = {}, isPrivate = false) {
  const baseURL = 'https://api.binance.com';
  const query = new URLSearchParams(params);
  if (isPrivate) {
    query.append('timestamp', Date.now());
    query.append('recvWindow', '5000');
    const signature = crypto.createHmac('sha256', API_SECRET)
      .update(query.toString())
      .digest('hex');
    query.append('signature', signature);
  }
  const headers = isPrivate ? { 'X-MBX-APIKEY': API_KEY } : {};
  const url = `${baseURL}${path}?${query.toString()}`;
  const res = await axios({ method, url, headers });
  return res.data;
}

// ====== Round theo stepSize/tickSize ======
function roundStepSize(qty, stepSize) {
  const q = Math.floor(qty / stepSize) * stepSize;
  return Number(q.toFixed(8));
}
function roundTickSize(price, tickSize) {
  const p = Math.floor(price / tickSize) * tickSize;
  return Number(p.toFixed(2));
}

// ====== Load filters ======
async function loadFilters() {
  const info = await binanceRequest('GET', '/api/v3/exchangeInfo');
  const s = info.symbols.find(x => x.symbol === SYMBOL);
  if (!s) throw new Error(`Không tìm thấy symbol ${SYMBOL}`);

  const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceF = s.filters.find(f => f.filterType === 'PRICE_FILTER');
  const notional =
    s.filters.find(f => f.filterType === 'NOTIONAL') ||
    s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  filters = {
    stepSize: parseFloat(lot?.stepSize || '0.00000001'),
    tickSize: parseFloat(priceF?.tickSize || '0.01'),
    minNotional: notional ? parseFloat(notional.minNotional || notional.notional || '0') : 0,
    minQty: parseFloat(lot?.minQty || '0')
  };
  console.log('Filters:', filters);
}

// ====== Số dư ======
async function getBalances() {
  const acc = await binanceRequest('GET', '/api/v3/account', {}, true);
  const usdt = acc.balances.find(b => b.asset === QUOTE) || { free: '0' };
  const paxg = acc.balances.find(b => b.asset === BASE) || { free: '0' };
  return {
    usdtFree: parseFloat(usdt.free),
    paxgFree: parseFloat(paxg.free)
  };
}

// ====== Lấy giá trung bình đã mua ======
// 1) Ưu tiên từ capital/config/getall (nếu tài khoản hỗ trợ)
async function getAverageBuyPriceFromCapital(asset) {
  try {
    const data = await binanceRequest('GET', '/sapi/v1/capital/config/getall', {}, true);
    const assetInfo = Array.isArray(data) ? data.find(a => a.coin === asset || a.asset === asset) : null;
    const avg = assetInfo?.avgPrice ?? assetInfo?.price ?? assetInfo?.costPrice ?? null;
    if (!avg) {
      console.log(`⚠️ Không tìm thấy giá trung bình cho ${asset} từ capital/config/getall`);
      return null;
    }
    const avgNum = parseFloat(avg);
    return Number.isFinite(avgNum) && avgNum > 0 ? avgNum : null;
  } catch (e) {
    console.log('⚠️ Lỗi lấy giá trung bình từ capital API:', e.response?.data || e.message);
    return null;
  }
}

// 2) Fallback: tính từ lịch sử giao dịch myTrades theo FIFO (giá vốn tồn kho còn lại)
async function fetchAllTrades(symbol, maxPages = 50) {
  const all = [];
  let fromId;
  for (let i = 0; i < maxPages; i++) {
    const params = { symbol, limit: 1000 };
    if (fromId !== undefined) params.fromId = fromId;
    const batch = await binanceRequest('GET', '/api/v3/myTrades', params, true);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    const last = batch[batch.length - 1];
    const nextId = typeof last.id === 'number' ? last.id + 1 : undefined;
    if (!nextId || batch.length < 1000) break;
    fromId = nextId;
  }
  all.sort((a, b) => a.time - b.time || a.id - b.id);
  return all;
}

function computeRemainingPositionAvgPriceFIFO(trades) {
  const lots = [];
  const f = v => parseFloat(v);

  for (const t of trades) {
    const qty = f(t.qty);
    const price = f(t.price);
    const commission = f(t.commission || 0);
    const commissionAsset = t.commissionAsset;

    if (t.isBuyer) {
      let qtyNet = qty;
      let totalCost = qty * price;
      if (commissionAsset === BASE) qtyNet = Math.max(0, qtyNet - commission);
      else if (commissionAsset === QUOTE) totalCost += commission;
      if (qtyNet > 0) lots.push({ qty: qtyNet, unitCost: totalCost / qtyNet });
    } else {
      let remaining = qty;
      if (commissionAsset === BASE) remaining = Math.max(0, remaining - commission);
      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remaining);
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-8) lots.shift();
      }
    }
  }

  const remQty = lots.reduce((s, l) => s + l.qty, 0);
  const remCost = lots.reduce((s, l) => s + l.qty * l.unitCost, 0);
  return remQty > 0 && remCost > 0 ? remCost / remQty : null;
}

async function getAverageBuyPriceFromTrades(symbol) {
  try {
    const trades = await fetchAllTrades(symbol);
    if (!trades || trades.length === 0) {
      console.log('⚠️ Không có lịch sử giao dịch để tính giá trung bình.');
      return null;
    }
    const avg = computeRemainingPositionAvgPriceFIFO(trades);
    return avg && Number.isFinite(avg) && avg > 0 ? avg : null;
  } catch (e) {
    console.log('⚠️ Lỗi myTrades:', e.response?.data || e.message);
    return null;
  }
}

async function getAverageBuyPrice(asset, symbol) {
  const avgCapital = await getAverageBuyPriceFromCapital(asset);
  if (avgCapital) return avgCapital;
  const avgTrades = await getAverageBuyPriceFromTrades(symbol);
  if (avgTrades) return avgTrades;
  return null;
}

// ====== Đơn hàng ======
async function checkOpenOrders() {
  const orders = await binanceRequest('GET', '/api/v3/openOrders', { symbol: SYMBOL }, true);
  currentBuyOrder = orders.find(o => o.side === 'BUY') || null;
  currentSellOrder = orders.find(o => o.side === 'SELL') || null;
}

async function placeBuyOrder(price) {
  const { usdtFree } = await getBalances();
  const amountUSD = Math.min(BUY_AMOUNT_USD, usdtFree);
  if (amountUSD < filters.minNotional) {
    console.log(`❌ Không đủ USDT để mua (cần >= ${filters.minNotional})`);
    return;
  }
  let qty = roundStepSize(amountUSD / price, filters.stepSize);
  if (qty < filters.minQty) {
    console.log(`❌ Lượng mua (${qty}) < minQty (${filters.minQty})`);
    return;
  }
  console.log(`✅ Đặt MUA ${qty} ${SYMBOL} tại ${price}`);
  const o = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL, side: 'BUY', type: 'LIMIT',
    timeInForce: 'GTC', quantity: qty, price
  }, true);
  currentBuyOrder = o;
}

async function placeSellOrder(price, qtyWanted) {
  const { paxgFree } = await getBalances();

  // Dust: để botLoop xử lý mua lại
  if (paxgFree < filters.minQty) {
    console.log(`ℹ️ PAXG (${paxgFree}) < minQty (${filters.minQty}) → dư sau bán trước đó.`);
    return;
  }

  let qty = roundStepSize(Math.min(qtyWanted, paxgFree), filters.stepSize);
  if (qty < filters.minQty) {
    console.log(`ℹ️ Lượng bán (${qty}) < minQty (${filters.minQty}) → dư sau bán trước.`);
    return;
  }
  if (qty * price < filters.minNotional) {
    console.log(`ℹ️ Tổng giá trị bán (${(qty * price).toFixed(2)}) < minNotional (${filters.minNotional}) → coi là dư.`);
    return;
  }

  console.log(`✅ Đặt BÁN ${qty} ${SYMBOL} tại ${price}`);
  const o = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL, side: 'SELL', type: 'LIMIT',
    timeInForce: 'GTC', quantity: qty, price
  }, true);
  currentSellOrder = o;
}

async function checkFilledOrders() {
  // BUY filled -> lưu lastBuyPrice
  if (currentBuyOrder) {
    const o = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL, orderId: currentBuyOrder.orderId
    }, true);
    if (o.status === 'FILLED') {
      lastBuyPrice = parseFloat(o.price);
      currentBuyOrder = null;
      console.log(`✅ Đã mua ${o.executedQty} ${BASE} tại ${lastBuyPrice}`);
    }
  }

  // SELL filled -> reset và tái đầu tư (nếu bật)
  if (currentSellOrder) {
    const o = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL, orderId: currentSellOrder.orderId
    }, true);
    if (o.status === 'FILLED') {
      console.log(`💰 Đã bán ${o.executedQty} ${BASE} tại ${o.price}`);
      currentSellOrder = null;
      lastBuyPrice = null;

      if (ENABLE_REINVEST) {
        const { usdtFree } = await getBalances();
        if (usdtFree >= BUY_AMOUNT_USD) {
          const t = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
          const buyPrice = roundTickSize(parseFloat(t.price) - 10, filters.tickSize);
          console.log(`🔄 Tái đầu tư: đặt lệnh mua tại ${buyPrice}`);
          await placeBuyOrder(buyPrice);
        } else {
          console.log(`⏸ Không đủ USDT để tái đầu tư (cần ≥ ${BUY_AMOUNT_USD})`);
        }
      }
    }
  }
}

// ====== Bot loop ======
async function botLoop() {
  try {
    await checkOpenOrders();
    await checkFilledOrders();

    const t = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
    const currentPrice = parseFloat(t.price);
    const { usdtFree, paxgFree } = await getBalances();

    console.log(`📊 Giá hiện tại: ${currentPrice} | ${QUOTE}: ${usdtFree} | ${BASE}: ${paxgFree}`);
    console.log(`📌 Lệnh chờ mua: ${currentBuyOrder ? JSON.stringify({ id: currentBuyOrder.orderId, price: currentBuyOrder.price }) : 'Không có'}`);
    console.log(`📌 Lệnh chờ bán: ${currentSellOrder ? JSON.stringify({ id: currentSellOrder.orderId, price: currentSellOrder.price }) : 'Không có'}`);

    // Dust PAXG: coi là dư sau bán -> chuyển sang BUY nếu đủ USDT
    if (paxgFree > 0 && paxgFree < filters.minQty && !currentBuyOrder) {
      console.log(`ℹ️ PAXG (${paxgFree}) < minQty (${filters.minQty}) → dư sau bán. Kiểm tra USDT để mua lại.`);
      if (usdtFree >= BUY_AMOUNT_USD) {
        const buyPrice = roundTickSize(currentPrice - 10, filters.tickSize);
        console.log(`🔄 Đặt lệnh MUA mới tại ${buyPrice}`);
        await placeBuyOrder(buyPrice);
      } else {
        console.log(`⏸ Không đủ USDT để mua lại (cần ≥ ${BUY_AMOUNT_USD})`);
      }
      return;
    }

    // Đang có PAXG đủ để bán và chưa có SELL -> đặt SELL theo giá trung bình + 20
    if (paxgFree >= filters.minQty && !currentSellOrder) {
      if (lastBuyPrice === null) {
        const avg = await getAverageBuyPrice(BASE, SYMBOL);
        if (!avg) {
          console.log('⏸ Không truy xuất/tính được giá trung bình. Bỏ qua vòng này.');
          return;
        }
        lastBuyPrice = avg;
        console.log(`📈 Giá trung bình mua vào của ${BASE}: ${lastBuyPrice}`);
      }
      const sellPrice = roundTickSize(lastBuyPrice + 20, filters.tickSize);
      await placeSellOrder(sellPrice, paxgFree);
      return; // ưu tiên bán trước
    }

    // Không có PAXG (hoặc đã xử lý ở trên): có thể đặt BUY nếu chưa có BUY
    if (paxgFree === 0 && !currentBuyOrder) {
      if (usdtFree >= BUY_AMOUNT_USD) {
        const buyPrice = roundTickSize(currentPrice - 10, filters.tickSize);
        await placeBuyOrder(buyPrice);
      } else {
        console.log(`❌ USDT < ${BUY_AMOUNT_USD}, chờ tích lũy thêm.`);
      }
    }
  } catch (e) {
    console.error('🚨 Lỗi:', e.response?.data || e.message);
  }
}

// ====== Khởi động ======
(async () => {
  await loadFilters();
  console.log('🚀 Bot PAXG bắt đầu chạy...');
  setInterval(botLoop, INTERVAL);
})();

// ====== HTTP & keepalive ======
app.get('/health', (_, r) => r.json({ status: 'ok' }));
app.get('/', (_, r) => r.send('Bot PAXG đang chạy...'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));

if (KEEPALIVE_URL) {
  setInterval(() => {
    axios.get(KEEPALIVE_URL)
      .then(res => console.log(`🔔 Ping at ${new Date().toISOString()} - ${res.status}`))
      .catch(err => console.error(`Ping error: ${err.message}`));
  }, 14 * 60 * 1000);
}
