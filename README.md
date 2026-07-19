# 股票行情单页 · Netlify 版

只保留「📊 股票行情」一页的精简网站。股票列表存在浏览器本地（localStorage）；
行情数据通过 **Netlify Functions** 服务端代理获取（腾讯财经 GBK 实时行情 + 东方财富分红送配），
前端无需处理跨域与 GBK 解码。

> 为什么需要服务端代理：腾讯行情是 GBK 编码且浏览器直连有跨域限制，纯静态托管跑不了，
> 所以把抓取逻辑放在 Netlify Function（`netlify/functions/stocks.js`）里。

## 目录结构
```
index.html              前端页面
style.css               样式
app.js                  前端逻辑（股票列表存 localStorage，自动刷新每 120 秒）
netlify/functions/stocks.js   后端代理（腾讯 GBK 行情 + 东财分红）
netlify.toml           构建配置 + /api/stocks 重定向到函数
package.json           依赖 iconv-lite（GBK 解码兜底）
```

## 本地预览
前端是纯静态文件，直接用浏览器打开 `index.html` 即可看页面；但 `/api/stocks` 需要 Netlify 函数，
本地可用 Netlify CLI：`npx netlify dev`（需先 `npm install`）。

## 部署到 Netlify（免费层，无需绑信用卡）
1. 注册 https://app.netlify.com/signup （建议用 GitHub 登录，最省事）。
2. 进入 Dashboard → **Add new site → Import an existing project**。
3. 选 **Deploy with GitHub**，授权后选择仓库 **`stock-quotes`**。
4. 配置（基本自动识别，确认即可）：
   - **Build command**：`npm install`
   - **Publish directory**：`.`（点号，根目录）
   - 函数目录由 `netlify.toml` 指定，无需手填
5. 点 **Deploy**，约 1 分钟构建完，得到地址 `https://xxxx.netlify.app`。

## 免费层注意事项
- **函数调用次数 12.5 万次/月**：已把自动刷新改为 **120 秒一次**（每天看 3 小时约 3 万次/月，安全）。
  若长时间挂着页面，调用会累积；看不过来时点掉页面顶部的「自动」勾选即可停止刷新。
- **支持自定义域名**（免费，含免费 SSL）——这是比 Render 免费档好的一点。
- 函数首次调用有冷启动（约 1~2 秒），属正常。

## 数据说明
- 数据来源：腾讯财经实时行情、东方财富分红送配。
- 指标：现价、涨跌%、成交额(亿)、PB、动态PE(ttm)、ROE、分红率、股息率、定估收益率、总市值(亿)。
  - ROE = PB ÷ 动态PE × 100
  - 分红率 = 每股股利 ÷ 每股收益
  - 股息率 = 每股股利 ÷ 现价
  - 定估收益率 = (1 − 分红率) × ROE + 股息率
  - 均基于最近一个自然年度已实施分红方案。
- 仅供研究参考，不构成投资建议。
