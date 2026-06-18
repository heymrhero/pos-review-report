/**
 * POS后台评价自动抓取与报表生成脚本
 * 功能：自动登录POS后台，通过UI切换各分店，获取各分店真实评价，生成HTML报表
 * 用法：node pos_review_report.js [--date 2026-06-07] [--output /path/to/report.html]
 *
 * 关键技术说明：
 * - 该POS系统(胡岩的龙虾Bot)的 comment/get_list1 API 不支持按 storeid 过滤
 * - 必须通过UI点击右上角下拉 → 展开天津市 → 点击分店，切换 session
 * - 切换完成后用页面内 fetch(credentials:include) 获取当前分店的评价
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

// ============ 配置 ============
const LOGIN_URL = 'https://zhyx.eingdong.com/console/#/login';
const USERNAME = process.env.POS_USERNAME || '15611381213';
const PASSWORD = process.env.POS_PASSWORD || '130423';
const STORAGE_STATE_PATH = path.join(__dirname, 'pos_auth_state.json');
const API_BASE = 'https://zhyx.eingdong.com/service/index.php';

// 企业微信推送配置（可选，通过环境变量设置）
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK || '';
const COS_BASE_URL = process.env.COS_BASE_URL || '';

// COS 上传配置（可选，通过环境变量设置）
const COS_SECRET_ID = process.env.COS_SECRET_ID || '';
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || '';
const COS_BUCKET = 'mrhero-1252461064';
const COS_REGION = 'ap-hongkong';
const COS_UPLOAD_KEY = 'review_report.html'; // 固定文件名，与 COS_BASE_URL 对应

// 分店列表（UI名称需和页面完全一致）
const STORES = [
  { name: '每日英雄（仁恒置地广场店）', id: '67809', address: '天津市南开区仁恒置地广场A馆B2层（车场入口旁）' },
  { name: '每日英雄（梅江环宇城店）', id: '67815', address: '天津市河西区解放南路689号中海环宇城F1-107(4号门旁边)' },
  { name: '每日英雄（彩柒汇店）', id: '67816', address: '天津市南开区彩柒汇生活广场BOOM优适健身旁' },
  { name: '每日英雄（华苑店）', id: '67817', address: '天津市西青区迎水道148号天业大厦一楼艾克仕健身进入' },
  { name: '每日英雄（远洋店）', id: '67818', address: '天津市河东区华捷道优适健身UGYM三楼前台' },
  { name: '每日英雄（万科广场店）', id: '67819', address: '天津市河西区广东路45号万科广场4楼屋顶停车场UGYM优适健身前厅' },
  { name: '每日英雄（国金汇店）', id: '67820', address: '天津市南开区国金汇UGYM LAB优适健身（9楼）' },
  { name: '每日英雄（六纬路店）', id: '67821', address: '天津市河东区万隆大厦优氧健身一楼' },
];

// ============ 参数解析 ============
const args = process.argv.slice(2);
let targetDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
let outputPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) { targetDate = args[i + 1]; i++; }
  if (args[i] === '--output' && args[i + 1]) { outputPath = args[i + 1]; i++; }
}
if (!outputPath) {
  outputPath = path.join(process.cwd(), `review_report_${targetDate}.html`);
}

console.log(`\n========== 评价报表生成 ==========`);
console.log(`基准日期: ${targetDate}`);
console.log(`输出路径: ${outputPath}\n`);

// ============ 日期范围 ============
function getDateRanges(baseDateStr) {
  // baseDateStr 已是北京时间（如 '2026-06-18'），创建北京时间午夜
  const today = new Date(baseDateStr + 'T00:00:00+08:00');
  const yesterday = new Date(today.getTime() - 86400000);
  const day7Ago = new Date(today.getTime() - 7 * 86400000);
  const day30Ago = new Date(today.getTime() - 30 * 86400000);
  // 本月1号也用北京时间
  const d = new Date(baseDateStr + 'T00:00:00+08:00');
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const fmt = d => new Date(d.getTime() + 8 * 3600000).toISOString().split('T')[0];
  const prevDay = fmt(yesterday);
  return {
    yesterday: { start: fmt(yesterday), end: fmt(yesterday), label: '昨日' },
    last7:     { start: fmt(day7Ago),   end: prevDay, label: '最近7天' },
    last30:    { start: fmt(day30Ago),  end: prevDay, label: '最近30天' },
    thisMonth: { start: fmt(monthStart), end: prevDay, label: '本月' }
  };
}

function inRange(addTime, start, end) {
  if (!addTime) return false;
  const d = addTime.slice(0, 10);
  return d >= start && d <= end;
}

// ============ 主流程 ============
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // ---- 确保登录状态有效 ----
  async function ensureLogin() {
    if (fs.existsSync(STORAGE_STATE_PATH)) {
      console.log('尝试使用已保存的登录状态...');
      try {
        const ctx = await browser.newContext({ storageState: STORAGE_STATE_PATH, viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        await page.goto('https://zhyx.eingdong.com/console/#/index', { waitUntil: 'networkidle', timeout: 15000 });
        const valid = !page.url().includes('/#/login');
        await page.close();
        await ctx.close();
        if (valid) { console.log('✓ 登录状态有效'); return; }
        console.log('登录状态已失效，重新登录...');
      } catch (e) {
        console.log('加载登录状态失败，重新登录...');
      }
    }
    // 重新登录
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    for (const input of await page.locator('input').all()) {
      const type = await input.evaluate(el => el.type);
      if (type === 'text' || type === 'tel') await input.fill(USERNAME);
      if (type === 'password') await input.fill(PASSWORD);
    }
    await page.locator('.tologin').click();
    await page.waitForTimeout(3000);
    if (page.url().includes('/#/login')) { console.log('✗ 登录失败'); await browser.close(); process.exit(1); }
    console.log('✓ 登录成功');
    await ctx.storageState({ path: STORAGE_STATE_PATH });
    await page.close();
    await ctx.close();
  }

  // ---- 获取单个分店的所有评价（通过 UI 切换 + 页面内 fetch） ----
  async function fetchStoreReviews(store) {
    const context = await browser.newContext({
      storageState: STORAGE_STATE_PATH,
      viewport: { width: 1440, height: 900 }
    });
    const page = await context.newPage();

    try {
      await page.goto('https://zhyx.eingdong.com/console/#/application/review', { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500);

      // 打开右上角下拉
      await page.mouse.click(1320, 15);
      await page.waitForTimeout(800);

      // 展开「天津市」
      await page.mouse.click(1207, 207);
      await page.waitForTimeout(800);

      // 点击目标分店
      await page.evaluate((storeName) => {
        document.querySelectorAll('.store-name-text').forEach(el => {
          if (el.textContent.trim() === storeName) el.click();
        });
      }, store.name);

      // 等待 session 切换完成
      await page.waitForTimeout(4000);

      // 页面内 fetch 第一页（最多100条）
      const firstPage = await page.evaluate(async () => {
        const resp = await fetch('https://zhyx.eingdong.com/service/index.php/comment/get_list1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'keyword=&type=0&search_type=0&star_overall=0&page=1&pagesize=100&storeid=0',
          credentials: 'include'
        });
        return await resp.json();
      });

      let reviews = firstPage.list || [];
      const count = firstPage.count || {};
      const total = parseInt(count.count) || 0;

      // 如果超过100条，拉取后续分页
      if (total > 100) {
        const totalPages = Math.ceil(total / 100);
        for (let p = 2; p <= totalPages; p++) {
          const morePage = await page.evaluate(async (pageNum) => {
            const resp = await fetch('https://zhyx.eingdong.com/service/index.php/comment/get_list1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `keyword=&type=0&search_type=0&star_overall=0&page=${pageNum}&pagesize=100&storeid=0`,
              credentials: 'include'
            });
            return await resp.json();
          }, p);
          reviews = reviews.concat(morePage.list || []);
        }
      }

      return {
        storeInfo: store,
        reviews: reviews.map(r => ({
          id: r.id,
          content: r.content,
          nickName: r.nickName || '匿名',
          telphone: r.telphone || '',
          starOverall: parseInt(r.star_overall) || 0,
          starTaste: parseInt(r.star_taste) || 0,
          starPack: parseInt(r.star_pack) || 0,
          addTime: r.add_time,
          orderNo: r.orderNo,
          orderAddTime: r.order_add_time,
          payType: r.payType,
          mealStyle: r.meal_style === '0' ? '堂食' : r.meal_style === '1' ? '外卖' : r.meal_style === '2' ? '自取' : '其他',
          anonymous: r.anonymous === '1',
          hidden: r.hide === '1',
          pics: r.pics ? String(r.pics).split(',').map(p => `https://zhyx-images.eingdong.com/${p.trim()}`) : [],
          goodsList: (r.goods_list || []).map(g => g.title),
          reply: r.reply
        })),
        stats: {
          total: parseInt(count.count) || 0,
          positive: parseInt(count.positive_comment) || 0,
          negative: parseInt(count.negative_comment) || 0,
          other: parseInt(count.other_comment) || 0
        }
      };
    } finally {
      await page.close();
      await context.close();
    }
  }

  try {
    await ensureLogin();

    console.log('\n--- 逐店切换获取评价 ---');
    const allReviews = {};

    for (const store of STORES) {
      process.stdout.write(`获取 ${store.name} ... `);
      const data = await fetchStoreReviews(store);
      allReviews[store.id] = data;
      console.log(`✓ ${data.reviews.length}条 (好评${data.stats.positive} 差评${data.stats.negative})`);
    }

    console.log('\n--- 生成报表 ---');
    const dateRanges = getDateRanges(targetDate);
    const reportHtml = generateReport(allReviews, targetDate, dateRanges);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, reportHtml, 'utf-8');
    console.log(`✓ 报表已生成: ${outputPath}`);

    const jsonPath = outputPath.replace('.html', '.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ allReviews, dateRanges }, null, 2), 'utf-8');
    console.log(`✓ JSON数据已保存: ${jsonPath}`);

    console.log('\n===== 各维度评价汇总 =====');
    for (const [key, range] of Object.entries(dateRanges)) {
      let total = 0, positive = 0, negative = 0;
      for (const data of Object.values(allReviews)) {
        const filtered = data.reviews.filter(r => inRange(r.addTime, range.start, range.end));
        total += filtered.length;
        positive += filtered.filter(r => r.starOverall >= 4).length;
        negative += filtered.filter(r => r.starOverall <= 2).length;
      }
      console.log(`[${range.label}] 总评价: ${total}  好评: ${positive}  差评: ${negative}`);
    }

    // 推送到企业微信群（如果配置了环境变量）
  if (WECOM_WEBHOOK && COS_BASE_URL) {
    console.log('\n--- 推送企业微信 ---');
    await pushToWecom(allReviews, targetDate, dateRanges, outputPath);
  }

  // 上传到 COS（如果配置了密钥）
  if (COS_SECRET_ID && COS_SECRET_KEY) {
    console.log('\n--- 上传到 COS ---');
    const uploadOk = await uploadToCOS(outputPath);
    if (uploadOk) console.log('✓ COS 上传成功');
    else console.error('✗ COS 上传失败');
  }

} catch (e) {
    console.error('错误:', e.message);
    console.error(e.stack);
  } finally {
    await browser.close();
  }
})();

// ============ COS 上传 ============
async function uploadToCOS(localPath) {
  return new Promise((resolve) => {
    const cos = new COS({
      SecretId: COS_SECRET_ID,
      SecretKey: COS_SECRET_KEY,
    });
    const filename = path.basename(localPath);
    const fileContent = fs.readFileSync(localPath);
    cos.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: COS_UPLOAD_KEY,
      Body: fileContent,
      ContentType: 'text/html; charset=utf-8',
    }, (err, data) => {
      if (err) {
        console.error('COS 上传失败:', err.message || err);
        resolve(false);
      } else {
        console.log(`✓ 已上传到 COS: https://${COS_BUCKET}.cos-website.${COS_REGION}.myqcloud.com/${COS_UPLOAD_KEY}`);
        resolve(true);
      }
    });
  });
}

// ============ 企业微信推送 ============
async function pushToWecom(allReviews, baseDate, dateRanges, outputPath) {
  const filename = path.basename(outputPath);
  // COS 链接 + 企微访问参数，双重验证用的
  const reportUrl = `${COS_BASE_URL}?from=wecom`;
  const https = require('https');

  // 最近30天数据
  const range = dateRanges.last30;
  const storeNames = {
    '67809': '仁恒', '67815': '梅江', '67816': '彩柒',
    '67817': '华苑', '67818': '远洋', '67819': '万科',
    '67820': '国金', '67821': '六纬'
  };

  let storeRows = '';
  let negativeDetails = '';
  let total30 = 0, pos30 = 0, neg30 = 0, neu30 = 0;

  // 汇总四个维度
  const summary = [];
  for (const [key, r] of Object.entries(dateRanges)) {
    let t = 0;
    for (const data of Object.values(allReviews)) {
      t += data.reviews.filter(rv => inRange(rv.addTime, r.start, r.end)).length;
    }
    summary.push(`${r.label}**${t}**`);
  }

  for (const [storeId, data] of Object.entries(allReviews)) {
    const filtered = data.reviews.filter(rv => inRange(rv.addTime, range.start, range.end));
    const pos = filtered.filter(rv => rv.starOverall >= 4).length;
    const neu = filtered.filter(rv => rv.starOverall === 3).length;
    const neg = filtered.filter(rv => rv.starOverall <= 2).length;
    total30 += filtered.length;
    pos30 += pos; neu30 += neu; neg30 += neg;

    const short = storeNames[storeId] || data.storeInfo.name.replace('每日英雄（', '').replace('）', '').slice(0, 2);
    storeRows += `| ${short} | ${filtered.length} | ${pos} | ${neu} | ${neg} |\n`;

    // 差评详情（只取最近30天内的第一条差评）
    if (neg > 0) {
      const bad = filtered.filter(rv => rv.starOverall <= 2);
      for (const rv of bad) {
        const name = rv.anonymous ? '匿名用户' : (rv.nickName || '用户');
        const stars = '★'.repeat(rv.starOverall) + '☆'.repeat(5 - rv.starOverall);
        const content = (rv.content || '').substring(0, 60).replace(/\n/g, ' ');
        // 不显示商家回复
        negativeDetails += `> **${short}店** | ${name} | ${stars}\n> ${content}\n\n`;
      }
    }
  }

  const yesterday = dateRanges.yesterday;
  let yesterdayTotal = 0;
  for (const data of Object.values(allReviews)) {
    yesterdayTotal += data.reviews.filter(rv => inRange(rv.addTime, yesterday.start, yesterday.end)).length;
  }

  const markdown = [
    `## 📊 每日英雄评价日报 ${baseDate}`,
    ``,
    `${summary.join(' | ')}`,
    ``,
    `### 🟢 最近30天各分店明细`,
    `| 分店 | 评价数 | 好评 | 中评 | 差评 |`,
    `|------|--------|------|------|------|`,
    storeRows.trim(),
  ];

  if (negativeDetails) {
    markdown.push(``, `### 🔴 差评详情`, negativeDetails.trim());
  }

  markdown.push(``, `📎 [查看完整报表](${reportUrl})`);

  const payload = JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: markdown.join('\n') }
  });

  // 企业微信 API 在 www.qyapi.weixin.qq.com，CloudStudio 沙箱在外网可以访问
  // 但实际上 GitHub Actions 在企业微信白名单外...

  return new Promise((resolve, reject) => {
    // 使用 HTTPS 请求
    const urlObj = new URL(WECOM_WEBHOOK);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const resp = JSON.parse(body);
          if (resp.errcode === 0) {
            console.log('✓ 企业微信推送成功');
          } else {
            console.log(`✗ 推送失败: ${body}`);
          }
        } catch (e) {
          console.log(`推送响应: ${body}`);
        }
        resolve();
      });
    });
    req.on('error', (e) => {
      console.log(`推送网络错误: ${e.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ============ 报表生成 ============
function generateReport(allReviews, baseDate, dateRanges) {

  function calcStats(reviews) {
    const total = reviews.length;
    const positive = reviews.filter(r => r.starOverall >= 4).length;
    const neutral = reviews.filter(r => r.starOverall === 3).length;
    const negative = reviews.filter(r => r.starOverall <= 2).length;
    const avgRating = total > 0 ? (reviews.reduce((s, r) => s + r.starOverall, 0) / total).toFixed(1) : '-';
    const positiveRate = total > 0 ? ((positive / total) * 100).toFixed(1) : '0.0';
    return { total, positive, neutral, negative, avgRating, positiveRate, hasNeutral: neutral > 0 };
  }

  function reviewItemHtml(review) {
    const stars = '★'.repeat(review.starOverall) + '☆'.repeat(5 - review.starOverall);
    const starClass = review.starOverall >= 4 ? 'stars-good' : review.starOverall >= 3 ? 'stars-ok' : 'stars-bad';
    const goodsTags = review.goodsList.map(g => `<span class="goods-tag">${g}</span>`).join('');
    const replyHtml = review.reply ? `<div class="reply"><strong>商家回复：</strong>${review.reply}</div>` : '';
    const picHtml = review.pics && review.pics.length > 0 ? `<div class="review-pic">${review.pics.map(p => `<img src="${p}" alt="评价图片" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>` : '';
    return `
      <div class="review-item ${review.starOverall <= 2 ? 'review-negative' : ''}">
        <div class="review-header">
          <span class="review-user">${review.anonymous ? '匿名用户' : review.nickName}</span>
          <span class="${starClass}">${stars}</span>
          <span class="review-time">${review.addTime}</span>
        </div>
        <div class="review-content">${(review.content || '（无文字评价）').replace(/\n/g, '<br>')}</div>
        ${picHtml}
        <div class="review-meta">
          <span class="meta-tag">${review.mealStyle}</span>
          ${goodsTags}
          <span class="meta-info">订单号: ${review.orderNo}</span>
        </div>
        ${replyHtml}
      </div>`;
  }

  function tabContentHtml(tabKey, range) {
    let allFiltered = [];
    const storeBlocks = [];

    for (const [storeId, data] of Object.entries(allReviews)) {
      const filtered = data.reviews.filter(r => inRange(r.addTime, range.start, range.end));
      allFiltered = allFiltered.concat(filtered);

      const s = calcStats(filtered);
      const reviewsHtml = filtered.length === 0
        ? '<div class="no-data">该时段暂无评价</div>'
        : filtered.map(reviewItemHtml).join('');

      storeBlocks.push(`
        <div class="store-section">
          <h2 class="store-title">${data.storeInfo.name}</h2>
          <div class="store-stats">
            <div class="stat-card"><div class="stat-value">${s.total}</div><div class="stat-label">评价总数</div></div>
            <div class="stat-card stat-good"><div class="stat-value">${s.positive}</div><div class="stat-label">好评</div></div>
            <div class="stat-card stat-ok"><div class="stat-value">${s.neutral}</div><div class="stat-label">中评</div></div>
            <div class="stat-card stat-bad"><div class="stat-value">${s.negative}</div><div class="stat-label">差评</div></div>
            <div class="stat-card"><div class="stat-value">${s.avgRating}</div><div class="stat-label">平均评分</div></div>
          </div>
          <div class="reviews-list">${reviewsHtml}</div>
        </div>`);
    }

    const gs = calcStats(allFiltered);

    const storeRows = Object.values(allReviews).map(data => {
      const filtered = data.reviews.filter(r => inRange(r.addTime, range.start, range.end));
      const s = calcStats(filtered);
      return `
        <tr style="border-bottom:1px solid #eee;">
          <td style="padding:10px;">${data.storeInfo.name}</td>
          <td style="padding:10px;text-align:center;">${s.total}</td>
          <td style="padding:10px;text-align:center;color:#52c41a;font-weight:600">${s.positive}</td>
          <td style="padding:10px;text-align:center;color:#faad14;font-weight:600">${s.neutral}</td>
          <td style="padding:10px;text-align:center;color:#ff4d4f;font-weight:600">${s.negative}</td>
          <td style="padding:10px;text-align:center;color:#faad14;font-weight:600">${s.avgRating}</td>
        </tr>`;
    }).join('');

    return `
      <div class="tab-content" id="tab-${tabKey}">
        <div class="period-hint">统计区间：${range.start} ~ ${range.end}</div>
        <div class="summary-row summary-row-1">
          <div class="summary-card"><div class="value">${gs.total}</div><div class="label">评价总数</div></div>
          <div class="summary-card card-rating"><div class="value">${gs.avgRating}</div><div class="label">平均评分</div></div>
        </div>
        <div class="summary-row summary-row-2">
          <div class="summary-card card-positive"><div class="value">${gs.positive}</div><div class="label">好评</div></div>
          <div class="summary-card card-neutral"><div class="value">${gs.neutral}</div><div class="label">中评</div></div>
          <div class="summary-card card-negative"><div class="value">${gs.negative}</div><div class="label">差评</div></div>
        </div>
        <div class="store-section">
          <h2 class="store-title">各分店概况</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;">
            <thead><tr style="background:#f5f7fa;">
              <th style="padding:10px;text-align:left;">分店</th>
              <th style="padding:10px;text-align:center;">评价数</th>
              <th style="padding:10px;text-align:center;">好评</th>
              <th style="padding:10px;text-align:center;">中评</th>
              <th style="padding:10px;text-align:center;">差评</th>
              <th style="padding:10px;text-align:center;">平均评分</th>
            </tr></thead>
            <tbody>${storeRows}</tbody>
          </table>
        </div>
        ${storeBlocks.join('')}
      </div>`;
  }

  const tabKeys = ['yesterday', 'last7', 'last30', 'thisMonth'];
  const tabContentsHtml = tabKeys.map(k => tabContentHtml(k, dateRanges[k])).join('\n');
  const tabBtnsHtml = tabKeys.map((k, i) =>
    `<button class="tab-btn${i === 0 ? ' active' : ''}" onclick="switchTab(event,'${k}')">${dateRanges[k].label}</button>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>用户评价报表 - ${baseDate}</title>
  <style id="wx-hide">body { visibility:hidden; }</style>
  <script>
    // 企业微信环境检测：仅允许在企业微信内打开
    (function() {
      var ua = navigator.userAgent || '';
      var isWXWork = ua.indexOf('WXWork') !== -1;
      var hasWecomParam = window.location.search.indexOf('from=wecom') !== -1;
      var hideStyle = document.getElementById('wx-hide');

      function showBlocker() {
        if (hideStyle) hideStyle.textContent = '';
        document.body.innerHTML =
          '<div id="wx-blocker" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;text-align:center;padding:40px;background:#f5f5f5;">'
          + '<div style="font-size:64px;margin-bottom:24px;">🔒</div>'
          + '<div style="font-size:22px;font-weight:700;color:#333;margin-bottom:12px;">访问受限</div>'
          + '<div style="font-size:15px;color:#888;line-height:1.8;max-width:320px;">该报表仅限在企业微信内查看，请通过企业微信会话中的链接打开。</div>'
          + '</div>';
      }

      if (isWXWork || hasWecomParam) {
        if (hideStyle) hideStyle.textContent = '';
      } else {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', showBlocker);
        } else {
          showBlocker();
        }
      }
    })();
  </script>

  <style>
    .container { max-width: 1020px; margin: 0 auto; padding: 20px; }
    .report-header { background: #636E4B; color: white; padding: 24px 30px; border-radius: 12px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; }
    .report-header .header-left { display: flex; align-items: center; gap: 10px; }
    .report-header h1 { font-size: 17px; margin: 0; }
    .report-header .date { font-size: 13px; opacity: 0.85; }
    .tab-nav { display: flex; gap: 8px; margin-bottom: 20px; background: white; padding: 8px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .tab-btn { flex: 1; padding: 8px 0; border: none; background: transparent; border-radius: 7px; font-size: 13px; font-weight: 500; color: #666; cursor: pointer; transition: all 0.2s; }
    .tab-btn:hover { background: #f0f2f5; color: #333; }
    .tab-btn.active { background: #636E4B; color: white; }
    .period-hint { font-size: 12px; color: #aaa; margin-bottom: 16px; }
    .tab-content { display: none; }
    .tab-content.show { display: block; }
    .summary-row { display: grid; gap: 12px; margin-bottom: 10px; }
    .summary-row-1 { grid-template-columns: repeat(2, 1fr); }
    .summary-row-2 { grid-template-columns: repeat(3, 1fr); }
    .summary-card { background: white; border-radius: 10px; padding: 18px 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .summary-card .value { font-size: 22px; font-weight: 700; color: #333; }
    .summary-card .label { font-size: 11px; color: #888; margin-top: 2px; }
    .summary-card.card-positive .value { color: #52c41a; }
    .summary-card.card-neutral .value { color: #faad14; }
    .summary-card.card-negative .value { color: #ff4d4f; }
    .summary-card.card-rating .value { color: #faad14; }
    .store-section { background: white; border-radius: 10px; padding: 22px 24px; margin-bottom: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .store-title { font-size: 15px; color: #222; margin-bottom: 4px; }
    .store-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 18px; }
    .stat-card { background: #f8f9fa; border-radius: 8px; padding: 10px; text-align: center; }
    .stat-card .stat-value { font-size: 17px; font-weight: 700; color: #333; }
    .stat-card .stat-label { font-size: 11px; color: #888; margin-top: 2px; }
    .stat-card.stat-good .stat-value { color: #52c41a; }
    .stat-card.stat-ok .stat-value { color: #faad14; }
    .stat-card.stat-bad .stat-value { color: #ff4d4f; }
    .review-item { border: 1px solid #eee; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
    .review-item.review-negative { border-left: 3px solid #ff4d4f; background: #fff7f7; }
    .review-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
    .review-user { font-weight: 600; color: #333; }
    .review-time { margin-left: auto; font-size: 12px; color: #bbb; }
    .stars-good, .stars-ok { color: #faad14; letter-spacing: 2px; }
    .stars-bad { color: #ff4d4f; letter-spacing: 2px; }
    .review-content { font-size: 14px; margin-bottom: 8px; color: #333; }
    .review-pic img { max-width: 110px; max-height: 110px; border-radius: 6px; margin-top: 6px; }
    .review-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
    .meta-tag, .goods-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .meta-tag { background: #e6f7ff; color: #1890ff; }
    .goods-tag { background: #f6ffed; color: #52c41a; }
    .meta-info { font-size: 12px; color: #ccc; margin-left: auto; }
    .reply { background: #f5f5f5; border-radius: 6px; padding: 8px 12px; margin-top: 8px; font-size: 13px; color: #666; }
    .no-data { text-align: center; padding: 36px; color: #bbb; font-size: 15px; }
    .footer { text-align: center; padding: 18px; color: #ccc; font-size: 12px; }
    @media (max-width: 600px) {
      .container { padding: 10px; }
      .report-header { padding: 16px 14px; flex-direction: column; align-items: flex-start; gap: 6px; }
      .report-header h1 { font-size: 15px; }
      .tab-nav { padding: 5px; gap: 4px; }
      .tab-btn { font-size: 12px; padding: 6px 0; }
      .store-section { padding: 14px 12px; }
      .summary-row { gap: 6px; }
      .summary-row-1 { grid-template-columns: repeat(2, 1fr); }
      .summary-row-2 { grid-template-columns: repeat(3, 1fr); }
      .summary-card { padding: 10px 4px; }
      .summary-card .value { font-size: 18px; }
      .summary-card .label { font-size: 10px; }
      .store-stats { grid-template-columns: repeat(3, 1fr); gap: 6px; }
      .stat-card { padding: 8px 4px; }
      .review-item { padding: 10px 12px; }
      th, td { padding: 6px 4px !important; font-size: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="report-header">
      <div class="header-left"><h1>📊 每日英雄 · 用户评价报表</h1></div>
      <div class="date">生成日期：${baseDate} · 共 ${STORES.length} 家分店</div>
    </div>
    <div class="tab-nav">${tabBtnsHtml}</div>
    ${tabContentsHtml}
    <div class="footer">报表自动生成于 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}<br>数据来源：胡岩的龙虾Bot</div>
  </div>
  <script>
    function switchTab(event, key) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('show'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      document.getElementById('tab-' + key).classList.add('show');
      event.target.classList.add('active');
    }
    document.getElementById('tab-yesterday').classList.add('show');
  </script>
</body>
</html>`;
}
