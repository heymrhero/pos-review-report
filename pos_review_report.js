/**
 * POS评价日报 - GitHub Actions CI 版
 *
 * 环境变量（GitHub Secrets）：
 *   POS_USERNAME  - 登录账号
 *   POS_PASSWORD  - 登录密码
 *   WECOM_WEBHOOK - 企业微信机器人 Webhook
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const USERNAME = process.env.POS_USERNAME || '';
const PASSWORD = process.env.POS_PASSWORD || '';
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK || '';
const REPORT_DATE = new Date().toISOString().split('T')[0];

const STORES = [
  { name: '每日英雄（仁恒置地广场店）', id: '67809' },
  { name: '每日英雄（梅江环宇城店）', id: '67815' },
  { name: '每日英雄（彩柒汇店）',     id: '67816' },
  { name: '每日英雄（华苑店）',       id: '67817' },
  { name: '每日英雄（远洋店）',       id: '67818' },
  { name: '每日英雄（万科广场店）',   id: '67819' },
  { name: '每日英雄（国金汇店）',     id: '67820' },
  { name: '每日英雄（六纬路店）',     id: '67821' },
];

function getDateRanges() {
  const today = new Date(REPORT_DATE + 'T00:00:00');
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const day7Ago   = new Date(today); day7Ago.setDate(today.getDate() - 7);
  const day30Ago  = new Date(today); day30Ago.setDate(today.getDate() - 30);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const fmt = d => d.toISOString().split('T')[0];
  const prevDay = fmt(new Date(today.getTime() - 86400000));
  return {
    yesterday:  { start: fmt(yesterday), end: fmt(yesterday), label: '昨日' },
    last7:      { start: fmt(day7Ago),   end: prevDay,       label: '最近7天' },
    last30:     { start: fmt(day30Ago),  end: prevDay,       label: '最近30天' },
    thisMonth:  { start: fmt(monthStart), end: prevDay,      label: '本月' }
  };
}

function inRange(addTime, start, end) {
  if (!addTime) return false;
  return addTime.slice(0, 10) >= start && addTime.slice(0, 10) <= end;
}

function sendWecom(title, summary) {
  if (!WECOM_WEBHOOK) { console.log('(未配置 Webhook)'); return; }
  const lines = ['## ' + title, '', ...summary.map(s => '- ' + s), '', '> 完整报表见 GitHub Actions Artifacts'];
  const payload = JSON.stringify({ msgtype: 'markdown', markdown: { content: lines.join('\n') } });
  const u = new URL(WECOM_WEBHOOK);
  const req = https.request({
    hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log('推送结果:', d.trim().slice(0, 200))); });
  req.on('error', e => console.error('推送失败:', e.message));
  req.write(payload);
  req.end();
}

(async () => {
  console.log('=== POS 评价日报 ' + REPORT_DATE + ' ===');
  console.log('分店数:', STORES.length, 'Webhook:', WECOM_WEBHOOK ? '已配置' : '未配置');
  console.log('');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // 登录
  async function login() {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    console.log('正在登录...');
    await page.goto('https://zhyx.eingdong.com/console/#/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    for (const input of await page.locator('input').all()) {
      const t = await input.evaluate(el => el.type);
      if (t === 'text' || t === 'tel') await input.fill(USERNAME);
      if (t === 'password') await input.fill(PASSWORD);
    }
    const cb = page.locator('.el-checkbox__label').first();
    if (await cb.count() > 0) { await cb.click(); await page.waitForTimeout(300); }
    await page.locator('.tologin').click();
    await page.waitForTimeout(4000);
    const ok = !page.url().includes('/#/login');
    if (!ok) { console.error('登录失败!'); await browser.close(); process.exit(1); }
    console.log('登录成功');
    const state = await ctx.storageState();
    await page.close(); await ctx.close();
    return state;
  }

  // 获取分店评价
  async function fetchStore(store, authState) {
    const ctx = await browser.newContext({ storageState: authState });
    const page = await ctx.newPage();
    try {
      await page.goto('https://zhyx.eingdong.com/console/#/application/review', { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500);

      // 打开分店切换下拉
      const avatar = page.locator('.avatar-wrapper');
      if (await avatar.count() > 0) await avatar.first().click();
      else await page.locator('text=子店').first().click();
      await page.waitForTimeout(1000);

      // 展开天津市
      await page.locator('text=天津市').first().click();
      await page.waitForTimeout(800);

      // 点击目标分店
      await page.locator('.store-name-text').filter({ hasText: store.name.replace('每日英雄（', '').replace('）', '') }).first().click();
      await page.waitForTimeout(3000);

      // fetch 评价
      const r1 = await page.evaluate(async () => {
        const r = await fetch('https://zhyx.eingdong.com/service/index.php/comment/get_list1', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'keyword=&type=0&search_type=0&star_overall=0&page=1&pagesize=100&storeid=0', credentials: 'include'
        });
        return r.json();
      });

      let reviews = r1.list || [];
      const total = parseInt((r1.count || {}).count) || 0;

      if (total > 100) {
        for (let p = 2; p <= Math.ceil(total / 100); p++) {
          const rp = await page.evaluate(async (n) => {
            const r = await fetch('https://zhyx.eingdong.com/service/index.php/comment/get_list1', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `keyword=&type=0&search_type=0&star_overall=0&page=${n}&pagesize=100&storeid=0`, credentials: 'include'
            });
            return r.json();
          }, p);
          reviews = reviews.concat(rp.list || []);
        }
      }

      return {
        name: store.name, id: store.id,
        reviews: reviews.map(r => ({
          content: r.content || '', nickName: r.nickName || r.nick_name || '匿名',
          starOverall: parseInt(r.star_overall) || 0, addTime: r.add_time || '',
          mealStyle: r.meal_style === '0' ? '堂食' : r.meal_style === '1' ? '外卖' : r.meal_style === '2' ? '自取' : '其他',
          goodsList: (r.goods_list || []).map(g => g.title || g), reply: r.reply || ''
        })),
        stats: {
          total: parseInt((r1.count || {}).count) || 0,
          positive: parseInt((r1.count || {}).positive_comment) || 0,
          negative: parseInt((r1.count || {}).negative_comment) || 0,
        }
      };
    } finally { await page.close(); await ctx.close(); }
  }

  try {
    const authState = await login();

    const allReviews = {};
    for (const store of STORES) {
      process.stdout.write('  ' + store.name + ' ... ');
      allReviews[store.id] = await fetchStore(store, authState);
      console.log(allReviews[store.id].reviews.length + '条');
    }

    // 汇总
    const dateRanges = getDateRanges();
    const summaryLines = [];

    for (const [key, range] of Object.entries(dateRanges)) {
      let total = 0, positive = 0, negative = 0;
      for (const d of Object.values(allReviews)) {
        const f = d.reviews.filter(r => inRange(r.addTime, range.start, range.end));
        total += f.length; positive += f.filter(r => r.starOverall >= 4).length; negative += f.filter(r => r.starOverall <= 2).length;
      }
      const line = '[' + range.label + '] 总' + total + ' 好评' + positive + ' 差评' + negative;
      summaryLines.push(line);
      console.log('  ' + line);

      if (negative > 0) {
        for (const d of Object.values(allReviews)) {
          for (const r of d.reviews.filter(r => inRange(r.addTime, range.start, range.end) && r.starOverall <= 2)) {
            console.log('    [' + d.name + '] ' + r.nickName + ' ★' + r.starOverall + ' ' + r.addTime + ' ' + r.content.slice(0, 60));
          }
        }
      }
    }

    // 生成 HTML
    const html = generateReport(allReviews, dateRanges);
    const outPath = path.join(__dirname, 'review_report_' + REPORT_DATE + '.html');
    fs.writeFileSync(outPath, html, 'utf-8');
    console.log('\n报表: ' + outPath);

    // 推送
    sendWecom('每日英雄评价日报 ' + REPORT_DATE, summaryLines);
    await new Promise(r => setTimeout(r, 3000));

    // GitHub Step Summary
    const ghs = process.env.GITHUB_STEP_SUMMARY;
    if (ghs) fs.appendFileSync(ghs, '# 评价日报 ' + REPORT_DATE + '\n\n' + summaryLines.map(l => '- ' + l).join('\n') + '\n');

  } catch (e) { console.error(e); process.exit(1); }
  finally { await browser.close(); }
})();

function generateReport(allReviews, dateRanges) {
  function stats(arr) {
    const t = arr.length, p = arr.filter(r => r.starOverall >= 4).length, n = arr.filter(r => r.starOverall <= 2).length;
    return { total: t, positive: p, negative: n, avg: t > 0 ? (arr.reduce((s, r) => s + r.starOverall, 0) / t).toFixed(1) : '-' };
  }
  function sStars(n) { let s = ''; for (let i = 0; i < 5; i++) s += i < n ? '★' : '☆'; return s; }

  const keys = ['yesterday', 'last7', 'last30', 'thisMonth'];
  let btns = '', panes = '';

  for (const [i, key] of keys.entries()) {
    const range = dateRanges[key];
    const gs = stats(Object.values(allReviews).flatMap(d => d.reviews.filter(r => inRange(r.addTime, range.start, range.end))));
    const rows = Object.values(allReviews).map(d => {
      const s = stats(d.reviews.filter(r => inRange(r.addTime, range.start, range.end)));
      return '<tr style="border-bottom:1px solid #f0f0f0"><td style="padding:10px">' + d.name + '</td><td style="padding:10px;text-align:center">' + s.total + '</td><td style="padding:10px;text-align:center;color:#52c41a">' + s.positive + '</td><td style="padding:10px;text-align:center;color:#ff4d4f">' + s.negative + '</td><td style="padding:10px;text-align:center;font-weight:600">' + s.avg + '</td></tr>';
    }).join('');

    const badAll = Object.values(allReviews).flatMap(d => d.reviews.filter(r => inRange(r.addTime, range.start, range.end) && r.starOverall <= 2));
    let badHtml = '';
    if (badAll.length > 0) {
      const items = badAll.map(r => {
        const sn = Object.values(allReviews).find(d => d.reviews.some(x => x.content === r.content && x.addTime === r.addTime))?.name || '';
        return '<div style="background:white;padding:12px;border-radius:8px;margin-bottom:8px;border-left:3px solid #ff4d4f"><div style="font-size:12px;color:#999;margin-bottom:4px">' + sn + ' · ' + sStars(r.starOverall) + ' · ' + r.addTime + '</div><div style="font-size:14px"><strong>' + r.nickName + '</strong>：' + r.content + '</div><div style="font-size:12px;color:#999;margin-top:4px">' + r.mealStyle + ' · ' + (r.goodsList || []).join('、') + '</div>' + (r.reply ? '<div style="margin-top:6px;padding:6px;background:#f5f7fa;border-radius:4px;font-size:12px;color:#666">回复：' + r.reply + '</div>' : '') + '</div>';
      }).join('');
      badHtml = '<div style="margin-top:16px"><h4 style="font-size:14px;color:#ff4d4f;margin-bottom:10px">差评详情（' + badAll.length + '条）</h4>' + items + '</div>';
    }

    btns  += '<button class="tab' + (i === 0 ? ' on' : '') + '" onclick="sw(\'' + key + '\',this)">' + range.label + '</button>';
    panes += '<div class="pane' + (i === 0 ? ' show' : '') + '" id="t-' + key + '"><p style="color:#999;font-size:13px;margin-bottom:12px">' + range.start + ' ~ ' + range.end + '</p><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px"><div style="background:#fff;padding:14px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700">' + gs.total + '</div><div style="font-size:12px;color:#999">评价总数</div></div><div style="background:#fff;padding:14px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700;color:#52c41a">' + gs.positive + '</div><div style="font-size:12px;color:#999">好评</div></div><div style="background:#fff;padding:14px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700;color:#ff4d4f">' + gs.negative + '</div><div style="font-size:12px;color:#999">差评</div></div><div style="background:#fff;padding:14px;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:700;color:#faad14">' + gs.avg + '</div><div style="font-size:12px;color:#999">平均分</div></div></div><table style="width:100%;background:#fff;border-radius:8px;overflow:hidden;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f5f7fa"><th style="padding:10px;text-align:left">分店</th><th style="padding:10px">评价数</th><th style="padding:10px">好评</th><th style="padding:10px">差评</th><th style="padding:10px">平均</th></tr></thead><tbody>' + rows + '</tbody></table>' + badHtml + '</div>';
  }

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>每日英雄评价日报 ' + REPORT_DATE + '</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7fa;padding:20px;color:#333;max-width:960px;margin:0 auto}.h{background:linear-gradient(135deg,#4a7c59,#2d5a3d);color:#fff;padding:24px;border-radius:12px;margin-bottom:20px}.h h1{font-size:20px;margin-bottom:4px}.h s{font-size:13px;opacity:.8}.tb{display:flex;gap:8px;background:#fff;padding:6px;border-radius:10px;margin-bottom:16px}.tab{flex:1;padding:10px 0;border:none;background:rgba(0,0,0,0);border-radius:6px;font-size:14px;cursor:pointer;color:#666}.tab.on{background:#4a7c59;color:#fff;font-weight:600}.pane{display:none}.pane.show{display:block}.f{text-align:center;color:#999;font-size:12px;margin-top:30px;padding:16px}</style></head><body><div class="h"><h1>每日英雄 · 用户评价日报</h1><s>' + REPORT_DATE + ' · ' + STORES.length + ' 家分店 · 自动生成</s></div><div class="tb">' + btns + '</div>' + panes + '<div class="f">GitHub Actions · 每天 8:30 自动运行</div><script>function sw(k,e){document.querySelectorAll(".pane").forEach(el=>el.classList.remove("show"));document.querySelectorAll(".tab").forEach(el=>el.classList.remove("on"));document.getElementById("t-"+k).classList.add("show");e.classList.add("on")}</script></body></html>';
}
