async function mainCycle() {
  try {
    if (!filters.tickSize) await loadSymbolFilters();

    // Gom API: giá, số dư, openOrders
    const [price, balances, openOrders] = await Promise.all([
      retry(() => getCurrentPrice(), {retries: 3, delay: 400}),
      retry(() => getBalances(),     {retries: 3, delay: 400}),
      retry(() => getOpenOrders(),   {retries: 3, delay: 400}),
    ]);

    await ensureGrid(price);

    const messages = [];

    // === Kiểm tra các lệnh SELL đã khớp và tự động đặt lại BUY ===
    for (const order of openOrders.filter(o => o.side === 'SELL')) {
      const o = await retry(() => getOrder(order.orderId), { retries: 3, delay: 400 });
      if (o.status === 'FILLED') {
        const executedQty = toNumber(o.executedQty || 0);
        const cumQuote    = toNumber(o.cummulativeQuoteQty || 0);
        const avgSellPrice = executedQty > 0 ? (cumQuote / executedQty) : null;

        messages.push(
          `🎉 SELL FILLED ${SYMBOL}\n` +
          `• ID: ${o.orderId}\n` +
          `• SL khớp: ${executedQty}\n` +
          `• Giá TB: ${avgSellPrice ?? 'null'}`
        );

        // Tìm lại nốt tương ứng với giá SELL
        const idx = findNodeIndex(avgSellPrice ?? toNumber(o.price));
        if (idx !== null) {
          const nodeMin = grid.levels[idx];
          const buyPrice = roundToTick(nodeMin, filters.tickSize);
          let buyQty = floorToStep(BUY_AMOUNT_USD / buyPrice, filters.stepSize);
          if (buyQty < filters.minQty) buyQty = filters.minQty;

          const buyExists = openOrders.some(o => o.side === 'BUY' && Number(o.price) === Number(buyPrice));
          if (!buyExists && balances.usdtFree > BUY_AMOUNT_USD && ensureNotional(buyPrice, buyQty, filters.minNotional)) {
            const buyOrder = await placeLimit('BUY', buyPrice, buyQty);
            messages.push(
              `🔁 ĐẶT LẠI BUY sau SELL\n` +
              `• Nốt: [${nodeMin}, ${grid.levels[idx + 1]}]\n` +
              `• Giá: ${buyOrder.price}\n` +
              `• SL : ${buyOrder.origQty}\n` +
              `• ID : ${buyOrder.orderId}`
            );
          }
        }
      }
    }

    // === Duyệt toàn bộ các nốt để đặt BUY/SELL nếu chưa có ===
    for (let i = 0; i < grid.levels.length - 1; i++) {
      const nodeMin = grid.levels[i];
      const nodeMax = grid.levels[i + 1];

      const buyPrice  = roundToTick(nodeMin, filters.tickSize);
      const sellPrice = formatByTick(ceilToTick(nodeMax, filters.tickSize), filters.tickSize);

      const buyExists  = openOrders.some(o => o.side === 'BUY'  && Number(o.price) === Number(buyPrice));
      const sellExists = openOrders.some(o => o.side === 'SELL' && Number(o.price) === Number(sellPrice));

      // ===== BUY =====
      if (!buyExists && balances.usdtFree > BUY_AMOUNT_USD) {
        let buyQty = floorToStep(BUY_AMOUNT_USD / buyPrice, filters.stepSize);
        if (buyQty < filters.minQty) buyQty = filters.minQty;
        if (ensureNotional(buyPrice, buyQty, filters.minNotional)) {
          const buyOrder = await placeLimit('BUY', buyPrice, buyQty);
          messages.push(
            `🟩 ĐẶT BUY ${SYMBOL} tại nốt [${nodeMin}, ${nodeMax}]\n` +
            `• Giá: ${buyOrder.price}\n` +
            `• SL : ${buyOrder.origQty}\n` +
            `• ID : ${buyOrder.orderId}`
          );
        } else {
          messages.push(
            `⚠️ Bỏ qua BUY tại nốt [${nodeMin}, ${nodeMax}]: Notional không đủ\n` +
            `• Giá: ${buyPrice} | SL: ${buyQty}`
          );
        }
      }

      // ===== SELL =====
      if (!sellExists) {
        const estQty = floorToStep(BUY_AMOUNT_USD / sellPrice, filters.stepSize);
        if (balances.baseFree >= estQty && ensureNotional(sellPrice, estQty, filters.minNotional)) {
          const sellOrder = await placeLimit('SELL', sellPrice, estQty);
          messages.push(
            `🟥 ĐẶT SELL ${SYMBOL} tại nốt [${nodeMin}, ${nodeMax}]\n` +
            `• Giá: ${sellOrder.price}\n` +
            `• SL : ${sellOrder.origQty}\n` +
            `• ID : ${sellOrder.orderId}`
          );
        } else {
          messages.push(
            `⚠️ Bỏ qua SELL tại nốt [${nodeMin}, ${nodeMax}]: Không đủ PAXG hoặc Notional thấp\n` +
            `• Giá: ${sellPrice} | SL dự kiến: ${estQty}`
          );
        }
      }
    }

    // Nếu không có hành động nào
    if (messages.length === 0) {
      messages.push(`ℹ️ ${SYMBOL}\n• Không có hành động mới trong chu kỳ này\n• Giá hiện tại: ${price}`);
    }

    // Gửi tổng hợp
    await sendTelegramMessage(messages.join('\n\n'));

  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('❌ mainCycle lỗi:', msg);
    await sendTelegramMessage(`❌ Lỗi: ${msg}`);
  }
}
