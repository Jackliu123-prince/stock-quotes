# 行情中心 · Netlify 版（自选 / LOF基金 / 股票行情 三页合一）

一个免费托管的行情网站，包含三个标签页：

- **⭐ 自选**：用户自选的 LOF 基金，显示场内价、买/卖一、单位净值、估值、溢价率、买一溢价、卖一折价。
- **📑 LOF基金**：LOF 基金列表，在自选基础上多了「跟踪指数」「指数涨跌%」，用于场内/场外套利判断（溢价=场内价>净值，可场外申购场内卖；折价反向）。
- **📊 股票行情**：股票估值与分红（PB、动态PE、ROE、分红率、股息率、定估收益率、总市值）。

三个列表都保存在**浏览器本地（localStorage）**，互不影响、互不共享；行情通过 **Netlify Functions** 服务端代理获取，前端不处理跨域与 GBK 解码。

> 为什么需要服务端代理：腾讯行情是 GBK 编码且浏览器直连有跨域限制，纯静态托管跑不了，
> 所以把抓取逻辑放在 Netlify Function（`netlify/functions/stocks.js` 与 `funds.js`）里。

## 目录结构
```
index.html                    前端页面（三标签页）
style.css                     样式
app.js                        前端逻辑（三列表各存 localStorage；交易时段 10 分钟智能刷新）
netlify/functions/stocks.js   股票行情代理（腾讯 GBK 行情 + 东财分红）
netlify/functions/funds.js    LOF 基金代理（腾讯 GBK 行情 + 东财净值/估值 + 溢价率）
netlify.toml                  构建配置 + /api/stocks、/api/funds 重定向 + 静态资源缓存
package.json                  依赖 iconv-lite（GBK 解码兜底）
```

## 刷新策略（已为免费额度优化）
- **交易时段**（周一至周五 北京时间 9:00–16:00）：当前标签页每 **10 分钟**自动刷新一次。
- **非交易时段**（含周末、节假日、盘后）：**不自动刷新**，只能点右上角「↻ 刷新」手动更新。
- **标签页隐藏时自动暂停**：切到后台的标签页不会刷新（浏览器也会限流）。
- **只刷新当前可见页**：三个页不会同时抓数据，进一步省调用。
- 顶部「自动」勾选可整体关闭自动刷新（变为纯手动）。

> 调用次数估算：交易时段每 10 分钟刷新一次 = 每天约 24 次/页；个人使用远低于 Netlify 免费 12.5 万次/月上限。

## 本地预览
前端是纯静态文件，直接用浏览器打开 `index.html` 即可看页面；但 `/api/*` 需 Netlify 函数，
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
6. 之后改代码只需 `git add -A && git commit -m "..." && git push origin main`，Netlify 自动重新部署。

## 数据说明
- 行情源：腾讯财经实时行情（GBK，函数内用 iconv-lite 解码）。
- 净值/估值源：东方财富 fundgz（实时估值）+ api.fund.eastmoney.com/f10/lsjz（权威最新净值，含前一交易日用于指数涨跌幅近似）。
- 分红源：东方财富分红送配（股票页）。
- 溢价率 = (现价 − 估值) ÷ 估值；买一溢价 = (买一 − 估值) ÷ 估值；卖一折价 = (卖一 − 估值) ÷ 估值。估值缺失时回退到最新单位净值。
- 指数涨跌% 在无非免费实时源时，以基金最新净值相对前一交易日净值的日变动近似（标记 ≈）。
- 仅供研究参考，不构成投资建议。

## 免费层注意事项
- **函数调用 12.5 万次/月**：上述刷新策略已大幅压低调用量。
- **支持自定义域名**（免费，含免费 SSL）。
- 函数首次调用有冷启动（约 1~2 秒），属正常；若显示「更新失败」点刷新即可。
