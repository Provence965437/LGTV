# LGTV · 黄果剧场

hgtv.im 短剧的 Web 前端 + 认证/收藏后端。

## 目录结构

```
.
├── auth_server.mjs   # 后端服务（Node ESM，http + crypto + mysql2，无额外依赖）
├── restart_auth.sh   # 重启脚本（从 .env 读取凭据）
├── web/              # 前端静态站点
│   ├── index.html    # 首页（分类 + 轮播 + 网格）
│   ├── play.html     # 播放页
│   ├── login.html    # 登录 / 注册
│   ├── browse.html   # 重定向桩
│   ├── css/style.css
│   ├── js/app.js     # 前端逻辑（含 API 基址探测）
│   └── data/dramas.json
├── .env.example      # 环境变量模板
└── .gitignore
```

## 后端能力

- 用户表 `web_users` / 会话表 `web_sessions` / 收藏表 `web_favorites`（MySQL 库 `hgtv_metadata`，启动时幂等建表）
- 密码 scrypt 哈希 + 随机盐；会话 token 30 天
- 接口：`/api/register`、`/api/login`、`/api/logout`、`/api/me`、`/api/favs`(GET/PUT/DELETE)、`/api/health`
- 同时托管 `web/` 静态文件，并开启 CORS

## 部署（以 38.55.194.47 为例）

```bash
cd /root
git clone git@github.com:Provence965437/LGTV.git   # 或 https 地址
cd LGTV
cp .env.example .env
# 编辑 .env 填入真实 MySQL 密码（.env 已被 .gitignore 忽略，不会提交）
vi .env
./restart_auth.sh
```

服务监听 `0.0.0.0:8787`；生产环境建议经 nginx 反代到 80 端口（如 `location /hj/` → `127.0.0.1:8787`）。

## 前端 API 基址

`web/js/app.js` 会自动探测：部署在 `38.55.194.47` 时走相对路径 `/hj/api/...`；本地预览时指向 `http://38.55.194.47/hj`。

## 安全

真实凭据（MySQL 密码等）一律放在 `.env`，**不进入版本库**；仅提交 `.env.example` 模板。
