# GitHub Actions 部署指南

每日英雄 POS 后台用户评价自动抓取 + 企业微信推送。

---

## 第一步：下载项目文件

把 `github-actions` 文件夹里的以下文件打包/复制到你本地：

```
github-actions/
├── .github/
│   └── workflows/
│       └── daily-report.yml      # GitHub Actions 定时任务配置
├── pos_review_report.js          # 主脚本
├── package.json                  # 依赖配置
└── .gitignore
```

---

## 第二步：创建 GitHub 仓库

1. 打开 https://github.com ，登录你的账号
2. 点右上角 `+` → `New repository`
3. Repository name 填：`pos-review-report`（或随便起）
4. 选 **Private**（私密仓库，账号密码不会泄露）
5. 不要勾选任何初始化选项（空仓库）
6. 点 `Create repository`

---

## 第三步：把代码推送到 GitHub

打开你电脑的 **终端**（Terminal），依次执行以下命令：

```bash
# 1. 进入项目目录
cd /Users/huwenming/WorkBuddy/2026-06-07-12-07-58/github-actions

# 2. 初始化 Git
git init
git add .
git commit -m "初始提交：POS评价日报脚本"

# 3. 关联你的 GitHub 仓库（把 YOUR_USERNAME 换成你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_USERNAME/pos-review-report.git

# 4. 推送代码
git branch -M main
git push -u origin main
```

推送时可能会弹窗要求登录 GitHub，按提示完成授权即可。

---

## 第四步：配置 Secrets（核心步骤）

这是最关键的一步——账号密码和 Webhook 地址存在 GitHub Secrets 里，不会暴露在代码中。

1. 打开你的 GitHub 仓库页面
2. 点顶部 `Settings` → 左侧菜单 `Secrets and variables` → `Actions`
3. 点绿色 `New repository secret` 按钮
4. **依次添加以下 4 个 Secrets**：

| Name | Value | 说明 |
|------|-------|------|
| `POS_USERNAME` | `15611381213` | POS后台登录账号 |
| `POS_PASSWORD` | `130423` | POS后台登录密码 |
| `WECOM_WEBHOOK` | `https://qyapi.weixin.qq.com/...` | 企业微信机器人地址 |
| `DINGTALK_WEBHOOK` | （可选，留空就行） | 钉钉机器人地址 |

每添加一个点 `Add secret`，再加下一个。

---

## 第五步：获取企业微信 Webhook

1. 打开企业微信 APP
2. 进入一个群聊（可以新建一个"日报推送群"，只需要你自己）
3. 点右上角 `···` → `群机器人` → `添加机器人`
4. 给机器人起名 → 完成
5. 复制 webhook 地址（格式：`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx`）
6. 把这个地址填到第四步的 `WECOM_WEBHOOK` Secret 中

---

## 第六步：手动测试一次

1. 在 GitHub 仓库页面，点顶部 `Actions` 标签
2. 左侧找到 `每日英雄评价日报` workflow
3. 点右侧 `Run workflow` → `Run workflow`（绿色按钮）
4. 刷新页面，等几分钟，看运行结果

**测试成功标志：** 企业微信群收到一条机器人消息，包含各维度的评价汇总。

---

## 第七步：确认定时任务

Workflow 文件里已配置好：**每天北京时间 8:30 自动运行**。

- 不需要开电脑
- 不需要任何服务器
- 完全免费（GitHub Actions 免费额度每月 2000 分钟，这个任务每月只用 ~300 分钟）

---

## 查看历史报表

每次运行后：
1. GitHub 仓库 → `Actions` → 点某次运行记录
2. 下拉到底部 `Artifacts` 区域
3. 下载 `review-report-xxx` 压缩包
4. 解压后浏览器打开 HTML 文件

---

## 常见问题

**Q: 运行失败怎么办？**
A: 点失败的运行记录，查看 `运行评价日报脚本` 步骤的日志。

**Q: 需要续费吗？**
A: 不需要。GitHub Actions 免费额度完全够用。

**Q: 账号密码安全吗？**
A: 存在 GitHub Secrets 中，即使仓库代码公开也不会泄露。而且你选的是 Private 私密仓库。

**Q: 想改成每天早上 9:00 运行？**
A: 编辑 `.github/workflows/daily-report.yml`，把 `cron: '30 0 * * *'` 改成 `cron: '0 1 * * *'`（UTC 时间 = 北京时间 - 8）。

---

## 项目文件结构总览

```
github-actions/
├── .github/workflows/daily-report.yml   # 定时任务（每天8:30）
├── pos_review_report.js                 # 主脚本
├── package.json                         # 依赖
├── .gitignore                           # 忽略文件
└── DEPLOY.md                            # 本文件
```
