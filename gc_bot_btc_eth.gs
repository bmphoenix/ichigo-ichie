/**
 * Ichigo Ichie ― 15分足GC版 BTC＋ETH bot（本番対応版）
 * ルール（銘柄ごと）：「15分足EMA50 > EMA200」かつ「4時間足の終値 > EMA200」の間だけ保有。崩れたら売って円で待機
 * Coincheck 現物・ロングのみ ― Google Apps Script
 *
 * 本番対応版で変えたこと
 *  ・注文の前に「発注中」を保存し、注文IDと約定履歴で結果を確定する（実行をまたいだ二重発注を防ぐ）
 *  ・結果が分からない注文があるあいだ、その銘柄では新しい注文を出さない
 *  ・botの持ち分（円・数量・取得原価）を帳簿で管理し、売るのはbotの持ち分だけ（手動で持っている分には触らない）
 *  ・約定の数量・価格は、残高の変化ではなく約定履歴から確定する
 *  ・BTCで失敗してもETHの処理は続ける（銘柄ごとにエラーを分ける）
 *  ・価格データの鮮度と本数を確認し、古い・足りないデータでは判断しない
 *  ・取引履歴は注文IDで重複を防ぎ、書けなかった記録は保留して必ず書き込む
 *  ・resetSim はお試し専用。本番は initLive / reconcileLive を使う
 *
 * 準備（お試し）: スプレッドシートの Apps Script に貼る → testNotify → setup
 * 本番にするとき:
 *  1. スクリプト プロパティに CC_KEY と CC_SECRET（CoincheckのAPIキー。権限は「新規注文」「取引履歴」「残高」「未約定の注文」のみ。出金権限は付けない）
 *  2. DRY_RUN を false にして保存
 *  3. 関数 initLive を実行（botの帳簿を予算どおりに作る。口座に元からあるBTC・ETHはbotの持ち分に含めない）
 *  4. 関数 reconcileLive で、口座の残高とbotの帳簿を確認
 */
const DRY_RUN      = true;
const BUDGET_JPY   = 200000;
const WEIGHTS      = {btc: 0.5, eth: 0.5};
const MIN_ORDER    = {btc: 0.001, eth: 0.01};        // Coincheckの最小注文数量（公式の注文ルールで要確認）
const KRAKEN_PAIR  = {btc: 'XBTUSD', eth: 'ETHUSD'};
const USE_RATIO    = 0.99;
const PENDING_GIVEUP_MIN = 15;                       // 結果不明の注文を「約定なし」と判断するまでの分数
// 通知先はスクリプト プロパティ（NOTIFY_EMAIL / DISCORD_URL）から読む
const NOTIFY_EMAIL = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || '';
const DISCORD_URL  = PropertiesService.getScriptProperties().getProperty('DISCORD_URL') || '';
const COINS = Object.keys(WEIGHTS);

// ================= 初期設定 =================
function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'main').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyMinutes(5).create();
  sheets_();
  log_('トリガーを設定しました（5分ごとに main を実行）');
  main();
}
function testNotify() { notify_('テスト通知', 'Ichigo Ichie bot からの通知テストです。'); }

// お試し専用のリセット（本番では実行できない）
function resetSim() {
  if (!DRY_RUN) throw new Error('本番モードでは resetSim は使えません。initLive / reconcileLive を使ってください');
  const p = props_();
  ['LAST_ERR', 'PENDING'].concat(...COINS.map(c => ['SIM_' + c, 'LEDGER_' + c, 'OPEN_' + c, 'BOOK_' + c, 'PEND_' + c]))
    .forEach(k => p.deleteProperty(k));
  const s = sheets_();
  if (s.trades.getLastRow() > 1) s.trades.deleteRows(2, s.trades.getLastRow() - 1);
  log_('お試しの記録をリセットしました');
}

// 本番開始：botの帳簿を予算どおりに作る（実際の資産には触らない）
function initLive() {
  if (DRY_RUN) throw new Error('DRY_RUN を false にしてから実行してください');
  COINS.forEach(c => { if (props_().getProperty('PEND_' + c)) throw new Error(c.toUpperCase() + 'に処理中の注文があります'); });
  const acct = ccPrivate_('get', '/api/accounts/balance');
  const need = COINS.reduce((a, c) => a + budget_(c), 0);
  if (Number(acct.jpy) < need) throw new Error(`口座の円（${Number(acct.jpy).toLocaleString()}円）が予算（${need.toLocaleString()}円）より少ないです`);
  COINS.forEach(c => saveBook_(c, {jpy: budget_(c), qty: 0, cost: 0, buyId: null, openTime: null}));
  log_(`本番の帳簿を作成しました（${COINS.map(c => c.toUpperCase() + ' ' + budget_(c).toLocaleString() + '円').join('、')}）`);
  reconcileLive();
}
// 口座の残高とbotの帳簿を見比べる（いつ実行してもOK）
function reconcileLive() {
  const acct = DRY_RUN ? null : ccPrivate_('get', '/api/accounts/balance');
  const lines = COINS.map(c => {
    const b = book_(c), pend = props_().getProperty('PEND_' + c);
    return `${c.toUpperCase()}: bot帳簿 円${Math.round(b.jpy).toLocaleString()} / 数量${round8_(b.qty)}` +
      (acct ? ` ｜ 口座 ${c.toUpperCase()} ${Number(acct[c])}（botの持ち分を${Number(acct[c]) + 1e-12 < b.qty ? '下回っています！' : '含んでいます'}）` : '') +
      (pend ? ' ｜ 処理中の注文あり' : '');
  });
  if (acct) lines.push(`口座の円 ${Number(acct.jpy).toLocaleString()}円（bot帳簿の合計 ${Math.round(COINS.reduce((a, c) => a + book_(c).jpy, 0)).toLocaleString()}円）`);
  lines.forEach(l => log_('【照合】' + l));
}

// ================= メイン =================
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const status = {};
  try {
    migrate_();
    flushPending_();
    COINS.forEach(c => {                                   // 銘柄ごとにエラーを分ける
      try { status[c] = stepCoin_(c); }
      catch (e) { status[c] = {error: e.message}; reportError_(c.toUpperCase() + ': ' + e.message); }
    });
    try { compareSpreads_(); } catch (e) { console.log('取引所比較の失敗: ' + e.message); }
    try { summary_(status); } catch (e) { console.log('サマリー更新失敗: ' + e.message); }
  } catch (e) {
    reportError_(e.message);
  } finally { lock.releaseLock(); }
}
function reportError_(msg) {
  log_('✖ エラー: ' + msg);
  const last = JSON.parse(props_().getProperty('LAST_ERR') || '{}');
  if (last.msg !== msg || Date.now() - last.t > 3600000) {
    notify_('botエラー', msg);
    props_().setProperty('LAST_ERR', JSON.stringify({msg: msg, t: Date.now()}));
  }
}

function stepCoin_(coin) {
  const SYM = coin.toUpperCase();
  // 1) 結果が分からない注文があれば、まずそれを確定させる。確定するまで新しい注文は出さない
  if (props_().getProperty('PEND_' + coin)) {
    const done = resolvePending_(coin);
    if (!done) return {sig: null, book: book_(coin), bid: null, note: '処理中の注文を確認中'};
  }
  const sig = signal_(coin);
  const t = fetchJson_('https://coincheck.com/api/ticker?pair=' + coin + '_jpy');
  const bid = Number(t.bid), ask = Number(t.ask);
  trackSpread_(coin, bid, ask);
  const book = book_(coin);
  const holding = book.qty >= MIN_ORDER[coin];

  if (sig.want && !holding) {
    const acctJpy = DRY_RUN ? book.jpy : Number(ccPrivate_('get', '/api/accounts/balance').jpy);
    const amountJpy = Math.floor(Math.min(book.jpy, acctJpy) * USE_RATIO);    // 帳簿と口座の少ない方で発注（帳簿は書き換えない）
    if (amountJpy / ask < MIN_ORDER[coin]) {
      if (new Date().getMinutes() < 5) log_(`⚠ ${SYM}: 発注できる金額が最小注文数量に届きません（帳簿${Math.round(book.jpy)}円 / 口座${Math.round(acctJpy)}円）`);
    } else {
      placeOrder_(coin, 'buy', {amountJpy: amountJpy, ask: ask, sig: sig.text});
    }
  } else if (!sig.want && holding) {
    let qty = Math.floor(book.qty * 1e8) / 1e8;
    if (!DRY_RUN) qty = Math.min(qty, Math.floor(Number(ccPrivate_('get', '/api/accounts/balance')[coin]) * 1e8) / 1e8);  // botの持ち分だけ売る
    if (qty >= MIN_ORDER[coin]) placeOrder_(coin, 'sell', {qty: qty, bid: bid, sig: sig.text});
    else log_(`⚠ ${SYM}: 売れる数量が最小注文数量に届きません（帳簿${round8_(book.qty)}）`);
  } else if (new Date().getMinutes() < 5) {
    log_(`… ${SYM} 変化なし | ${sig.text}`);
  }
  return {sig: sig, book: book_(coin), bid: bid};
}

// ================= 注文（発注中の保存 → 送信 → 約定履歴で確定） =================
function placeOrder_(coin, side, o) {
  const now = Date.now();
  const pend = {side: side, t: now, orderId: null, stage: 'sending', amountJpy: o.amountJpy || null, qty: o.qty || null, sig: o.sig};
  props_().setProperty('PEND_' + coin, JSON.stringify(pend));                     // 送る前に保存
  if (DRY_RUN) {                                                                    // お試し：最良気配で全量約定したとみなす
    const id = 'SIM' + now + coin;
    const fill = side === 'buy'
      ? {order_id: id, funds: {[coin]: o.amountJpy / o.ask, jpy: -o.amountJpy}, fee: 0, fee_currency: 'JPY'}
      : {order_id: id, funds: {[coin]: -o.qty, jpy: o.qty * o.bid}, fee: 0, fee_currency: 'JPY'};
    finalize_(coin, pend, id, [fill]);
    return;
  }
  let res;
  try {
    res = ccPrivate_('post', '/api/exchange/orders', side === 'buy'
      ? {pair: coin + '_jpy', order_type: 'market_buy', market_buy_amount: o.amountJpy}
      : {pair: coin + '_jpy', order_type: 'market_sell', amount: o.qty});
  } catch (e) {
    // 送ったかどうか分からない。新しく出し直さず、次回以降に約定履歴で確認する
    log_(`⚠ ${coin.toUpperCase()} ${side === 'buy' ? '買い' : '売り'}注文の結果が不明です。次の実行で約定履歴を確認します: ${e.message}`);
    notify_(`${coin.toUpperCase()} 注文結果不明`, '約定履歴で確認するまで、この銘柄の新しい注文は出しません。\n' + e.message);
    return;
  }
  pend.orderId = String(res.id); pend.stage = 'sent';
  props_().setProperty('PEND_' + coin, JSON.stringify(pend));
  for (let i = 0; i < 4; i++) {                                                    // 成行なので通常はすぐ約定する
    Utilities.sleep(2500);
    if (resolvePending_(coin)) return;
  }
  log_(`… ${coin.toUpperCase()} 注文${pend.orderId}の約定を次の実行で確認します`);
}

// 処理中の注文を確定させる。確定したら true
function resolvePending_(coin) {
  const pend = JSON.parse(props_().getProperty('PEND_' + coin) || 'null');
  if (!pend) return true;
  if (DRY_RUN) { props_().deleteProperty('PEND_' + coin); return true; }
  const pair = coin + '_jpy';
  const tx = retry_(() => ccPrivate_('get', '/api/exchange/orders/transactions')).transactions || [];
  let fills;
  if (pend.orderId) {
    fills = tx.filter(x => String(x.order_id) === pend.orderId);
  } else {                                                                          // 注文IDが分からない場合は、時刻・銘柄・売買の向きで探す
    const cand = tx.filter(x => x.pair === pair && x.side === pend.side && new Date(x.created_at).getTime() >= pend.t - 60000);
    if (cand.length) { pend.orderId = String(cand[0].order_id); fills = cand.filter(x => String(x.order_id) === pend.orderId); }
    else fills = [];
  }
  const opens = retry_(() => ccPrivate_('get', '/api/exchange/orders/opens')).orders || [];
  const stillOpen = pend.orderId && opens.some(x => String(x.id) === pend.orderId);
  if (fills.length && !stillOpen) { finalize_(coin, pend, pend.orderId, fills); return true; }
  const ageMin = (Date.now() - pend.t) / 60000;
  if (!fills.length && !stillOpen && ageMin > PENDING_GIVEUP_MIN) {
    props_().deleteProperty('PEND_' + coin);
    log_(`⚠ ${coin.toUpperCase()} 注文${pend.orderId || '(ID不明)'}は約定していないと判断しました（${Math.round(ageMin)}分経過）`);
    notify_(`${coin.toUpperCase()} 注文は約定せず`, '次のシグナルで改めて判断します。Coincheckの画面でも念のため確認してください。');
    return true;
  }
  return false;                                                                     // まだ確定できない → 新しい注文は出さない
}

// 約定履歴から帳簿・記録・通知を確定させる
function finalize_(coin, pend, orderId, fills) {
  const SYM = coin.toUpperCase();
  let dq = 0, dj = 0;
  fills.forEach(x => {
    dq += Number(x.funds[coin] || 0); dj += Number(x.funds.jpy || 0);
    const fee = Number(x.fee || 0);
    if (fee) { if ((x.fee_currency || '').toUpperCase() === 'JPY') dj -= fee; else dq -= fee; }
  });
  const b = book_(coin), now = Date.now();
  if (pend.side === 'buy') {
    const qty = dq, paid = -dj, price = paid / qty;
    b.jpy -= paid; b.qty += qty; b.cost += paid; b.buyId = orderId; b.openTime = now;
    saveBook_(coin, b);
    props_().deleteProperty('PEND_' + coin);
    notify_(`${SYM}買い`, `${Math.round(paid).toLocaleString()}円分を買いました\n価格 ${Math.round(price).toLocaleString()}円 / 数量 ${round8_(qty)} ${SYM}\n${pend.sig || ''}`);
    log_(`▶ ${SYM} 買い ${Math.round(paid).toLocaleString()}円 → ${round8_(qty)}${SYM} @${Math.round(price).toLocaleString()} 注文${orderId} | ${pend.sig || ''}`);
    record_({type: 'buy', id: orderId, row: ['', SYM, jst_(now), Math.round(price), round8_(qty), Math.round(paid), '', '', '', '', '', '', '', DRY_RUN ? 'お試し' : '本番', orderId]});
  } else {
    const qty = -dq, got = dj, price = got / qty;
    const share = b.qty > 0 ? Math.min(1, qty / b.qty) : 1, cost = b.cost * share;
    const pnl = got - cost, pct = cost ? pnl / cost * 100 : 0, hrs = b.openTime ? (now - b.openTime) / 3600000 : 0;
    const buyId = b.buyId;
    b.jpy += got; b.qty = Math.max(0, b.qty - qty); b.cost -= cost;
    const closed = b.qty < MIN_ORDER[coin];
    if (closed) { b.cost = 0; b.buyId = null; b.openTime = null; }
    saveBook_(coin, b);
    props_().deleteProperty('PEND_' + coin);
    notify_(pnl >= 0 ? `${SYM}売り（勝ち）` : `${SYM}売り（負け）`,
      `損益 ${Math.round(pnl).toLocaleString()}円（${pct.toFixed(2)}%）/ 保有 ${hrs.toFixed(1)}時間\n決済価格 ${Math.round(price).toLocaleString()}円\n${pend.sig || ''}`);
    log_(`▶ ${SYM} 売り ${round8_(qty)}${SYM} @${Math.round(price).toLocaleString()} 損益 ${Math.round(pnl).toLocaleString()}円（${pct.toFixed(2)}%）保有${hrs.toFixed(1)}時間 注文${orderId}${closed ? '' : '（一部のみ）'}`);
    record_({type: 'sell', id: orderId, buyId: buyId, sym: SYM,
             values: [jst_(now), Math.round(price), Math.round(got), Math.round(pnl), Math.round(pct * 100) / 100, Math.round(hrs * 10) / 10, pnl >= 0 ? '勝ち' : '負け']});
  }
}

// ================= botの帳簿（円・数量・取得原価） =================
function budget_(coin) { return BUDGET_JPY * WEIGHTS[coin]; }
function book_(coin) {
  const b = JSON.parse(props_().getProperty('BOOK_' + coin) || 'null');
  return b || {jpy: budget_(coin), qty: 0, cost: 0, buyId: null, openTime: null};
}
function saveBook_(coin, b) { props_().setProperty('BOOK_' + coin, JSON.stringify(b)); }
// 旧版（SIM_/OPEN_/LEDGER_）からの引き継ぎ。1回だけ実行される
function migrate_() {
  COINS.forEach(c => {
    if (props_().getProperty('BOOK_' + c)) return;
    const sim = JSON.parse(props_().getProperty('SIM_' + c) || 'null');
    const open = JSON.parse(props_().getProperty('OPEN_' + c) || 'null');
    const led = props_().getProperty('LEDGER_' + c);
    if (!sim && !open && !led) return;
    const b = {jpy: DRY_RUN && sim ? sim.jpy : (led ? Number(led) : budget_(c)), qty: DRY_RUN && sim ? sim.coin : 0,
               cost: open ? open.jpy : 0, buyId: open ? 'OLD' + (open.row || '') : null, openTime: open ? open.time : null};
    if (!DRY_RUN && open) log_(`⚠ ${c.toUpperCase()}: 旧版の本番ポジションがあります。数量は reconcileLive で確認し、必要なら帳簿を手で直してください`);
    saveBook_(c, b);
    log_(`旧版の記録を引き継ぎました（${c.toUpperCase()} 円${Math.round(b.jpy)} / 数量${round8_(b.qty)}）`);
  });
}

// ================= シグナル（Kraken公開データ、確定足のみ。鮮度と本数を確認） =================
function krakenOHLC_(coin, interval) {
  const r = fetchJson_(`https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIR[coin]}&interval=${interval}`);
  if (r.error && r.error.length) throw new Error('Kraken: ' + r.error.join(','));
  const key = Object.keys(r.result).find(k => k !== 'last');
  const rows = r.result[key].slice(0, -1);                                         // 最後の1本は未確定足
  const t = rows.map(x => Number(x[0])), c = rows.map(x => Number(x[4]));
  if (rows.length < 250) throw new Error(`${coin.toUpperCase()} ${interval}分足のデータが足りません（${rows.length}本）`);
  if (!c.every(v => isFinite(v) && v > 0)) throw new Error(`${coin.toUpperCase()} ${interval}分足に不正な値があります`);
  const age = Date.now() / 1000 - (t[t.length - 1] + interval * 60);              // 最後の確定足が閉じてからの秒数
  if (age > interval * 60 * 2 + 600) throw new Error(`${coin.toUpperCase()} ${interval}分足が古すぎます（${Math.round(age / 60)}分前）`);
  return c;
}
function ema_(arr, p) { const a = 2 / (p + 1); let e = arr[0]; for (let i = 1; i < arr.length; i++) e = a * arr[i] + (1 - a) * e; return e; }
function signal_(coin) {
  const c15 = krakenOHLC_(coin, 15), c4 = krakenOHLC_(coin, 240);
  const f = ema_(c15, 50), s = ema_(c15, 200), e4 = ema_(c4, 200), l4 = c4[c4.length - 1];
  const gc = f > s, up4 = l4 > e4;
  return {want: gc && up4,
          text: `15分 EMA50 ${f.toFixed(0)} / EMA200 ${s.toFixed(0)} → ${gc ? 'GC' : 'DC'}｜4H 終値 ${l4.toFixed(0)} / EMA200 ${e4.toFixed(0)} → ${up4 ? '上' : '下'}`};
}

// ================= サマリー =================
function summary_(status) {
  const s = sheets_();
  const data = s.trades.getLastRow() > 1 ? s.trades.getRange(2, 1, s.trades.getLastRow() - 1, 14).getValues() : [];
  const stat = rows => {
    const closed = rows.filter(r => r[12] !== ''), w = closed.filter(r => Number(r[10]) >= 0).length;
    return {n: closed.length, w: w, rate: closed.length ? (w / closed.length * 100).toFixed(1) + '%' : '-',
            pnl: closed.reduce((a, r) => a + Number(r[9]), 0)};
  };
  let eq = 0, known = true;
  COINS.forEach(c => { const x = status[c] || {}, b = book_(c); if (x.bid) eq += b.jpy + b.qty * x.bid; else known = false; });
  const all = stat(data);
  const rows = [['最終更新', new Date()], ['モード', DRY_RUN ? 'お試し（注文は出ていません）' : '本番'],
    ['合計の評価額（円）', known ? Math.round(eq) : '一部取得できず'], ['開始時の資産（円）', BUDGET_JPY],
    ['通算損益（円）', known ? Math.round(eq - BUDGET_JPY) : '-'], ['通算リターン', known ? ((eq / BUDGET_JPY - 1) * 100).toFixed(2) + '%' : '-'],
    ['決済済みの取引（全体）', `${all.n}回（勝ち${all.w} / 負け${all.n - all.w}、勝率 ${all.rate}）`], ['', '']];
  COINS.forEach(c => {
    const x = status[c] || {}, b = book_(c), SYM = c.toUpperCase(), st = stat(data.filter(r => r[1] === SYM));
    const pend = props_().getProperty('PEND_' + c);
    rows.push([`【${SYM}】状態`, x.error ? 'エラー：' + x.error : pend ? '注文の確認中' : (b.qty >= MIN_ORDER[c] ? '保有中' : '待機中（円）')],
              [`【${SYM}】シグナル`, x.sig ? x.sig.text : (x.note || '-')],
              [`【${SYM}】bot帳簿（円 / 数量）`, `${Math.round(b.jpy).toLocaleString()}円 / ${round8_(b.qty)} ${SYM}`],
              [`【${SYM}】評価額（円）`, x.bid ? Math.round(b.jpy + b.qty * x.bid) : '-'],
              [`【${SYM}】含み損益（円）`, x.bid && b.qty >= MIN_ORDER[c] ? Math.round(b.qty * x.bid - b.cost) : '-'],
              [`【${SYM}】決済済み損益（円）`, Math.round(st.pnl)],
              [`【${SYM}】取引回数・勝率`, `${st.n}回（勝率 ${st.rate}）`],
              [`【${SYM}】平均スプレッド（気配ベースの推定往復コスト）`, sprText_(c)], ['', '']);
  });
  s.summary.clear();
  s.summary.getRange(1, 1, rows.length, 2).setValues(rows);
  s.summary.getRange(1, 1, rows.length, 1).setFontWeight('bold');
  s.summary.autoResizeColumns(1, 2);
}

// ================= スプレッドの記録（実際の売買コストの検証用） =================
// 5分ごとの買値・売値の差（%）を集計し、1時間ごとに「スプレッド」シートへ平均・最小・最大を書き出す
function trackSpread_(coin, bid, ask) {
  try {
    if (!(bid > 0 && ask > 0)) return;
    const sp = (ask - bid) / ask * 100, hour = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:00');
    const key = 'SPR_' + coin, all = 'SPRALL_' + coin;
    let h = JSON.parse(props_().getProperty(key) || 'null');
    if (h && h.hour !== hour) {          // 1時間が終わったらシートに書き出す
      retry_(() => sheets_().spread.appendRow([h.hour, coin.toUpperCase(), r4_(h.sum / h.n), r4_(h.min), r4_(h.max), h.n]), 2);
      h = null;
    }
    h = h || {hour: hour, n: 0, sum: 0, min: 999, max: 0};
    h.n++; h.sum += sp; h.min = Math.min(h.min, sp); h.max = Math.max(h.max, sp);
    props_().setProperty(key, JSON.stringify(h));
    const a = JSON.parse(props_().getProperty(all) || '{"n":0,"sum":0,"max":0}');
    a.n++; a.sum += sp; a.max = Math.max(a.max, sp);
    props_().setProperty(all, JSON.stringify(a));
  } catch (e) { console.log('スプレッド記録失敗: ' + e.message); }
}
function sprText_(coin) {
  const a = JSON.parse(props_().getProperty('SPRALL_' + coin) || 'null');
  return a && a.n ? `${(a.sum / a.n).toFixed(3)}%（最大 ${a.max.toFixed(3)}%、${a.n}回計測）` : '計測中';
}
function r4_(x) { return Math.round(x * 10000) / 10000; }

// ================= 取引所ごとのスプレッド比較（Coincheck・bitFlyer・bitbank・GMOコイン） =================
// 5分ごとに各取引所の板の最良の買値・売値を取得し、1時間ごとに「取引所比較」シートへ記録する。
// 「取引所比較まとめ」シートには、平均スプレッド＋往復の手数料＝成行の往復コストを、安い順に表示する。
// 手数料（テイカー・片道%）は各社の公式サイトで確認して、必要なら書き換えること。
const EXCH = {
  coincheck: {name: 'Coincheck', fee: 0.00,
              url: c => `https://coincheck.com/api/ticker?pair=${c}_jpy`, parse: j => [+j.bid, +j.ask]},
  bitflyer:  {name: 'bitFlyer', fee: 0.15,   // 直近30日の取引量で0.01〜0.15%に変動
              url: c => `https://api.bitflyer.com/v1/ticker?product_code=${c.toUpperCase()}_JPY`, parse: j => [+j.best_bid, +j.best_ask]},
  bitbank:   {name: 'bitbank', fee: 0.10,
              url: c => `https://public.bitbank.cc/${c}_jpy/ticker`, parse: j => [+j.data.buy, +j.data.sell]},
  gmo:       {name: 'GMOコイン', fee: 0.05,
              url: c => `https://api.coin.z.com/public/v1/ticker?symbol=${c.toUpperCase()}`, parse: j => [+j.data[0].bid, +j.data[0].ask]},
};

function compareSpreads_() {
  try {
    const keys = [];
    Object.keys(EXCH).forEach(ex => COINS.forEach(c => keys.push([ex, c])));
    const res = UrlFetchApp.fetchAll(keys.map(([ex, c]) => ({url: EXCH[ex].url(c), muteHttpExceptions: true})));
    const hour = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:00');
    let h = JSON.parse(props_().getProperty('XSPR') || 'null');
    const all = JSON.parse(props_().getProperty('XSPRALL') || '{}');
    if (h && h.hour !== hour) {                       // 1時間が終わったら書き出す
      const rows = Object.keys(h.s).map(k => {
        const [ex, c] = k.split('|'), x = h.s[k];
        return [h.hour, EXCH[ex].name, c.toUpperCase(), x.n ? r4_(x.sum / x.n) : '', x.n ? r4_(x.max) : '', x.n, x.err];
      });
      if (rows.length) retry_(() => { const sh = sheets_().xspread; sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows); }, 2);
      h = null;
    }
    h = h || {hour: hour, s: {}};
    res.forEach((r, i) => {
      const [ex, c] = keys[i], k = ex + '|' + c;
      const s = h.s[k] = h.s[k] || {n: 0, sum: 0, max: 0, err: 0};
      const a = all[k] = all[k] || {n: 0, sum: 0, max: 0, err: 0};
      try {
        if (r.getResponseCode() !== 200) throw new Error('HTTP ' + r.getResponseCode());
        const [bid, ask] = EXCH[ex].parse(JSON.parse(r.getContentText()));
        if (!(bid > 0 && ask > 0 && ask >= bid)) throw new Error('値が不正');
        const sp = (ask - bid) / ask * 100;
        s.n++; s.sum += sp; s.max = Math.max(s.max, sp);
        a.n++; a.sum += sp; a.max = Math.max(a.max, sp);
      } catch (e) { s.err++; a.err++; }
    });
    props_().setProperty('XSPR', JSON.stringify(h));
    props_().setProperty('XSPRALL', JSON.stringify(all));
    writeXSummary_(all);
  } catch (e) { console.log('取引所比較の失敗: ' + e.message); }
}

function writeXSummary_(all) {
  const rows = Object.keys(all).map(k => {
    const [ex, c] = k.split('|'), a = all[k], avg = a.n ? a.sum / a.n : null;
    return [EXCH[ex].name, c.toUpperCase(), avg === null ? '' : r4_(avg), EXCH[ex].fee,
            avg === null ? '' : r4_(avg + EXCH[ex].fee * 2), a.n ? r4_(a.max) : '', a.n, a.err];
  }).sort((x, y) => x[1] !== y[1] ? x[1].localeCompare(y[1]) : (x[4] === '' ? 99 : x[4]) - (y[4] === '' ? 99 : y[4]));
  const sh = sheets_().xsummary;
  sh.clear();
  const head = [['取引所', '銘柄', '平均スプレッド(%)', '手数料・片道(%)', '成行の往復コスト(%)', '最大スプレッド(%)', '計測回数', '取得エラー']];
  sh.getRange(1, 1, 1, 8).setValues(head);
  sh.getRange(1, 1, 1, 8).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, 8).setValues(rows);
  sh.getRange(rows.length + 3, 1).setValue('成行の往復コスト＝平均スプレッド＋手数料×2。銘柄ごとに安い順。手数料は各社の最新情報で要確認。');
}


// ================= 失敗に強くするための仕組み =================
function retry_(fn, tries) {
  let err;
  for (let i = 0; i < (tries || 3); i++) { try { return fn(); } catch (e) { err = e; Utilities.sleep(2000 * (i + 1)); } }
  throw err;
}
function fetchJson_(url) {
  return retry_(() => {
    const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    if (r.getResponseCode() === 429 || r.getResponseCode() >= 500) throw new Error(`HTTP ${r.getResponseCode()}: ${url}`);
    return JSON.parse(r.getContentText());
  });
}
// 取引履歴：注文IDで重複を防ぎ、書けなかったら保留して次回に書く
function record_(op) {
  try { applyRecord_(op); }
  catch (e) {
    const q = JSON.parse(props_().getProperty('PENDING') || '[]'); op.tries = (op.tries || 0) + 1; q.push(op);
    props_().setProperty('PENDING', JSON.stringify(q));
    console.log('取引履歴の書き込みを保留: ' + e.message);
  }
}
function idCol_(sh) {
  if (sh.getRange(1, 15).getValue() !== '注文ID') sh.getRange(1, 15).setValue('注文ID');
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 15, n, 1).getValues().map(r => String(r[0])) : [];
}
function applyRecord_(op) {
  const sh = sheets_().trades, ids = idCol_(sh);
  if (op.type === 'buy') {
    if (ids.indexOf(String(op.id)) >= 0) return;                                    // すでに書いてあれば何もしない
    op.row[0] = sh.getLastRow();
    sh.appendRow(op.row);
  } else {
    let row = op.buyId ? ids.indexOf(String(op.buyId)) + 2 : 0;
    if (row < 2) {                                                                  // IDで見つからなければ、決済されていない最後の行
      const n = sh.getLastRow() - 1, data = n > 0 ? sh.getRange(2, 1, n, 7).getValues() : [];
      for (let i = data.length - 1; i >= 0; i--) if (data[i][1] === op.sym && data[i][6] === '') { row = i + 2; break; }
    }
    if (row < 2) throw new Error(`${op.sym} の売りを書く行が見つかりません（注文${op.id}）`);
    if (String(sh.getRange(row, 7).getValue()) !== '') return;                      // すでに決済が書いてあれば何もしない
    sh.getRange(row, 7, 1, 7).setValues([op.values]);
  }
}
function flushPending_() {
  const q = JSON.parse(props_().getProperty('PENDING') || '[]');
  if (!q.length) return;
  const left = [];
  q.forEach(op => {
    try { applyRecord_(op); }
    catch (e) {
      op.tries = (op.tries || 0) + 1; left.push(op);
      if (op.tries === 5) notify_('取引履歴に書けない記録があります', `${op.type} 注文${op.id}: ${e.message}`);
    }
  });
  if (left.length) props_().setProperty('PENDING', JSON.stringify(left)); else props_().deleteProperty('PENDING');
  if (left.length < q.length) log_(`保留していた取引履歴を${q.length - left.length}件書き込みました`);
}

// ================= シート・通知・補助 =================
function sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const get = (name, header) => {
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); if (header) { sh.appendRow(header); sh.setFrozenRows(1); sh.getRange(1, 1, 1, header.length).setFontWeight('bold'); } }
    return sh;
  };
  return {
    summary: get('サマリー'),
    trades: get('取引履歴', ['No', '銘柄', 'エントリー日時', 'エントリー価格', '数量', '投入額(円)', '決済日時', '決済価格',
                            '受取額(円)', '損益(円)', '損益率(%)', '保有時間(h)', '結果', 'モード', '注文ID']),
    log: get('ログ', ['日時', '内容']),
    spread: get('スプレッド', ['時間帯', '銘柄', '平均スプレッド(%)', '最小(%)', '最大(%)', '計測回数']),
    xspread: get('取引所比較', ['時間帯', '取引所', '銘柄', '平均スプレッド(%)', '最大(%)', '計測回数', '取得エラー']),
    xsummary: get('取引所比較まとめ')
  };
}
function log_(msg) {
  console.log(msg);
  try { retry_(() => sheets_().log.appendRow([new Date(), msg]), 2); } catch (e) { console.log('ログの書き込み失敗: ' + e.message); }
}
function notify_(subject, body) {
  const mode = DRY_RUN ? '【お試し】' : '【本番】';
  if (NOTIFY_EMAIL) { try { MailApp.sendEmail(NOTIFY_EMAIL, `[Ichigo Ichie] ${mode}${subject}`, body); } catch (e) { console.log('メール送信失敗: ' + e.message); } }
  if (DISCORD_URL) {
    try {
      UrlFetchApp.fetch(DISCORD_URL, {method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({content: `**[Ichigo Ichie] ${mode}${subject}**\n${body}`})});
    } catch (e) { console.log('Discord送信失敗: ' + e.message); }
  }
}
function jst_(t) { return Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'); }
function round8_(x) { return Math.round(x * 1e8) / 1e8; }
function props_() { return PropertiesService.getScriptProperties(); }

// ================= Coincheck 認証付きAPI =================
let NONCE_ = 0;
function ccPrivate_(method, path, body) {
  const url = 'https://coincheck.com' + path;
  NONCE_ = Math.max(Date.now() * 1000, NONCE_ + 1);   // 連続で呼んでも必ず増えるように
  const nonce = String(NONCE_);
  const bodyStr = body ? JSON.stringify(body) : '';
  const raw = Utilities.computeHmacSha256Signature(nonce + url + bodyStr, props_().getProperty('CC_SECRET'));
  const sig = raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  const opt = {method: method, contentType: 'application/json', muteHttpExceptions: true,
               headers: {'ACCESS-KEY': props_().getProperty('CC_KEY'), 'ACCESS-NONCE': nonce, 'ACCESS-SIGNATURE': sig}};
  if (bodyStr) opt.payload = bodyStr;
  const r = JSON.parse(UrlFetchApp.fetch(url, opt).getContentText());
  if (!r.success) throw new Error('Coincheck: ' + JSON.stringify(r));
  return r;
}

