# 股票行情单页 · Render 上线包

纯前端单页（股票行情）+ Node 原生 HTTP 服务（含行情代理），**零第三方依赖**，可直接部署到 Render 免费层。

## 目录结构
```
render-stock-site/
├── server.js      # Node 服务：静态托管 + /api/stocks 代理（腾讯GBK行情+东财分红）
├── package.json   # start 脚本 + engine node 22.x（无 dependencies，部署无需 npm install 等待）
├── index.html     # 前端页面
├── style.css      # 样式
├── app.js         # 前端逻辑（股票列表存 localStorage）
└── README.md
```

## 数据来源
- 实时行情：腾讯财经 `qt.gtimg.cn`（GBK 编码，服务端解码）
- 分红送配：东方财富 `datacenter-web.eastmoney.com`
- 指标：PB、动态PE(ttm)、ROE(=PB÷动态PE×100)、分红率、股息率、定估收益率、总市值

---

## 部署到 Render（详细步骤）

### 方式一：GitHub 仓库部署（推荐，后续可自动更新）
1. 在 GitHub 新建一个**公开**仓库（如 `stock-quotes`）。
2. 把本目录 `render-stock-site/` 里的全部文件推上去：
   ```bash
   cd render-stock-site
   git init
   git add .
   git commit -m "stock quotes site"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/stock-quotes.git
   git push -u origin main
   ```
3. 打开 https://dashboard.render.com → 右上角 **New +** → **Web Service**。
4. 选择 **Build and deploy from a Git repository** → 连接 GitHub → 选中该仓库。
5. 配置项（基本都会自动识别，确认一下即可）：
   - **Name**：随便起，如 `stock-quotes`
   - **Runtime**：Node
   - **Build Command**：留空（或 `npm install`，无依赖秒过）
   - **Start Command**：`npm start`  （等于 `node server.js`）
   - **Instance Type**：选 **Free**（重要！默认可能是付费档）
6. 点击 **Create Web Service**。
7. 等 1~2 分钟构建完成，Render 会给一个地址 `https://stock-quotes-xxxx.onrender.com`，打开即是用。

### 方式二：直接上传（不连 GitHub）
Render 不支持直接拖文件夹上传代码（不像 Netlify/Cloudflare Pages 有 drag-and-drop），所以**必须先有一个 Git 仓库或压缩包**。最省事就是方式一的 GitHub 连接。若你不想用 GitHub，也可以本地用 `render` CLI 部署（需注册后安装 CLI），但首次仍建议用 Git 仓库。

---

## 免费层注意事项
- **休眠与冷启动**：免费 Web Service 在空闲 **15 分钟后自动休眠**，之后首次访问需要 **30~60 秒** 唤醒。页面已做错误提示，唤醒后刷新即可正常显示行情。
- **750 小时/月**：一个 Free 实例大约可常驻一整月（不到上限）；若同时挂着多个免费服务会共享额度。
- **自定义域名**：免费层不支持自有域名绑定（需付费档）。如需 `你的域名.com`，要升 Starter($7/月) 等。
- **无数据库需求**：股票列表存在访客浏览器 localStorage，服务本身无状态，休眠不影响数据。

---

## 本地预览（可选）
```bash
cd render-stock-site
node server.js          # 默认 http://localhost:3000
# 或指定端口： PORT=8080 node server.js
```
访问 http://localhost:3000 即可，接口在 http://localhost:3000/api/stocks?symbols=sh600519,sz000858

---

## 常见问题
- **页面打开但行情一直“更新失败”**：多半是服务正在冷启动，等几十秒后点“↻ 刷新”。
- **想换默认股票列表**：在页面输入框直接添加/移除即可，列表存在本地浏览器。
- **想改代码重新部署**：推送到 GitHub 后，Render 会自动重新构建（可在 Dashboard 里看到 Deploy 进度）。
