// 最顶部加载：给所有 console 输出加上日期时间戳（必须在其他模块之前 require）
require('./config/logger');

// 进程守护：记录「服务端为什么会停」。
// 必须在业务模块之前安装，否则启动阶段（连数据库、跑迁移、占端口）的异常兜不住。
// 它会把未捕获异常 / 未处理的 Promise 拒绝 / 停止信号 / 退出码同时写到控制台和
// data/logs/server-lifecycle.log（挂载卷里，重启不丢），用于事后定位。
const processGuard = require('./config/processGuard');
processGuard.install();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDatabase } = require('./config/database');
const { runMigrations } = require('./config/migrate');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const petRoutes = require('./routes/pets');
const assignmentRoutes = require('./routes/assignments');
// 纸质作业扫描（批次制）：逐张上传 + 按组识别 + 进度落库
const paperScanRoutes = require('./routes/paperScan');
const battleRoutes = require('./routes/battles');
const itemRoutes = require('./routes/items');
const friendRoutes = require('./routes/friends');
const achievementRoutes = require('./routes/achievements');
const leaderboardRoutes = require('./routes/leaderboard');
const equipmentRoutes = require('./routes/equipment');
const adminRoutes = require('./routes/admin');
const systemRoutes = require('./routes/system');
const postRoutes = require('./routes/posts');
const chatRoutes = require('./routes/chat');
const forumRoutes = require('./routes/forum');
const notificationRoutes = require('./routes/notifications');
const publicRoutes = require('./routes/public');
const classRoutes = require('./routes/classes');
const dailyTasksModule = require('./routes/daily-tasks');
const knowledgePointRoutes = require('./routes/knowledge-points');
const learningReportRoutes = require('./routes/learning-reports');
const learningReportAiRoutes = require('./routes/learning-reports-ai');
const skillRoutes = require('./routes/skills');
const bossBattleRoutes = require('./routes/boss-battles');
const schoolRoutes = require('./routes/schools');
const aiCoachRoutes = require('./routes/ai-coach');
const questionBankRoutes = require('./routes/question-bank');
const cardRoutes = require('./routes/cards');
const userTransactionRoutes = require('./routes/user-transactions');
const agentRoutes = require('./routes/agent');
const agentTokenRoutes = require('./routes/agent-tokens');

// 初始化数据库
initDatabase();

// 服务启动时间（升级重启后时间会变，前端可据此判断服务端是否换过）
const STARTED_AT = new Date().toISOString();

const { db } = require('./config/database');
const { isClassMember } = require('./middleware/classAccess');

// ===== CORS 白名单 =====
// 未配置 FRONTEND_URL 时回退到本地常用开发地址，避免出现「接口通但前端全被 CORS 拦掉」的假故障。
//
// 之前的实现有两个问题，导致线上出现「不允许的跨域请求」时无从排查：
//   1. 拒绝时只说「不允许」，不打被拒绝的域名，日志里看不出是哪个 Origin 触发的；
//   2. 完全精确匹配，所以协议/端口/尾斜杠/www 前缀任何一处不一致都会被拒。
// 现在统一做规范化比较，并在开发环境放行 localhost 的任意端口（vite 换端口很常见）。
const rawOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

/** 规范化来源用于比较：统一小写、去掉结尾斜杠 */
const normalizeOrigin = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();

const allowedOrigins = rawOrigins.map(normalizeOrigin).filter(Boolean);
const allowedOriginSet = new Set(allowedOrigins);
const isProd = process.env.NODE_ENV === 'production';
// 显式总开关：仅供内网/单机部署临时排障使用，生产环境不建议开启
const allowAllOrigins = /^(1|true|yes)$/i.test(String(process.env.CORS_ALLOW_ALL || ''));

/** 开发环境：放行 localhost / 127.0.0.1 的任意端口 */
const isLocalhostOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);

/** @param {string|null|undefined} origin @returns {boolean} */
function isOriginAllowed(origin) {
  if (!origin) return true;                // curl / 移动端等无 Origin 的请求
  if (allowAllOrigins) return true;
  const o = normalizeOrigin(origin);
  if (allowedOriginSet.has(o)) return true;
  // 放行 http/https 互换之外的细微差异：www 前缀
  if (allowedOriginSet.has(o.replace(/^https?:\/\/(www\.)/, (m, p) => m.replace('www.', '')))) return true;
  if (!isProd && isLocalhostOrigin(origin)) return true;
  return false;
}

console.log(`CORS 允许来源: ${allowedOrigins.join(', ') || '(无)'}`);
if (!isProd) console.log('CORS 调试: 开发环境已放行 localhost / 127.0.0.1 的任意端口');
if (allowAllOrigins) console.warn('⚠️ CORS_ALLOW_ALL 已开启：任何来源都能访问本接口，请勿用于生产');

const app = express();
const server = http.createServer(app);

// Socket.IO 初始化（用于战斗和实时互动）
// 与 HTTP 接口共用同一套来源判定，避免出现「接口通了但聊天连不上」的半通状态
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      console.error(`[CORS] Socket.IO 拒绝来源: ${origin || '(无)'}`);
      callback(new Error('不允许的跨域请求'), false);
    },
    methods: ['GET', 'POST']
  }
});

// 暴露 io 给各路由使用
app.set('io', io);

// 把 http server / socket.io 交给守护模块：
// 端口被占用（EADDRINUSE）等 listen 失败会以 'error' 事件抛出，
// 没人监听就是未捕获异常 → 进程静默退出。登记后会被完整记录到生命周期日志。
processGuard.register({ server, io });

// 中间件
// helmet 默认 CSP 含 upgrade-insecure-requests：强制浏览器把页面内所有 http 资源
// 请求升级为 https。本系统明确支持「局域网 IP + http」部署（容器只监听纯 HTTP），
// 该指令会让 http 站点的 JS/CSS 全部以 https 请求、握手失败，页面白屏
// （localhost/127.0.0.1 会被浏览器豁免，所以本地测试发现不了，仅真实 IP 中招）。
// 这里显式移除该指令，其余默认 CSP 保持不变。
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': null,
    },
  },
})); // 安全头
app.use(compression()); // 压缩响应
app.use(cors({
  origin: function (origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    // 必须把被拒绝的 origin 打出来：否则只看到「不允许的跨域请求」，
    // 根本无从判断是域名写错、端口变了，还是协议不一致
    console.error(
      `[CORS] 拒绝跨域请求：Origin="${origin}" 不在白名单中。\n` +
      `[CORS] 当前白名单：${allowedOrigins.join(', ') || '(空)'}\n` +
      `[CORS] 排查：①浏览器地址栏的协议+域名+端口是否与 FRONTEND_URL 完全一致；` +
      `② 多实例部署时每个实例的 FRONTEND_URL 都要包含实际访问的域名；` +
      `③ 若通过 IP 而非域名访问，把该 IP 也加进 FRONTEND_URL（用逗号分隔多个）。`
    );
    callback(new Error(`不允许的跨域请求（Origin: ${origin || '无'}）`));
  },
  credentials: true
}));
// 常见扫描/探测路径：直接静默 404
// 说明：这些请求本就取不到任何东西（源码里没有对应的静态目录），
// 放在日志中间件之前，避免 /api/.env、/wp-admin 之类的扫描把控制台刷满。
// 如需追踪扫描来源，可在 Nginx 的 access_log 里查看（请求仍会被 Nginx 记录）。
const SCAN_PATH_RE = /(^|\/)(\.env|\.git|\.svn|\.aws|\.ssh|wp-admin|wp-login|wp-content|phpmyadmin|pma|admin\.php|xmlrpc\.php|config\.php|\.htaccess)/i;
app.use((req, res, next) => {
  if (SCAN_PATH_RE.test(req.path) || /\.(sqlite|sqlite3|db|log|env|bak|old|zip|tar|gz)$/i.test(req.path)) {
    return res.status(404).json({ error: '未找到请求的资源' });
  }
  next();
});

// 请求日志：输出到 console（morgan 默认直接写 stdout，绕过 console 补丁，故这里改走 console.log 以带时间戳）
app.use(morgan('dev', {
  stream: { write: (msg) => console.log(msg.trimEnd()) }
}));
app.use(express.json()); // JSON 解析
app.use(express.urlencoded({ extended: true }));

// 注意：data/uploads 下的文件**刻意不再挂成公开静态目录**。
//
// 那里放的是学生的手写作答照片（含姓名、笔迹），属于个人数据。
// 以前 /uploads/<文件名> 谁拿到名字谁就能下载，没有任何鉴权——
// 虽然文件名是随机的，但一旦链接被转发、被浏览器历史记录保存，就等于泄露。
//
// 现在这些文件只供服务端自己读取（主观题评阅是直接读磁盘，不走 HTTP），
// 前端展示用学生本机压缩出来的图，不经过网络。
// 万一以后要在页面上回顾历史作答，请加带 token 的读取接口，不要再挂静态目录。
// 优先从 public/images 读取图片（生产环境），如果不存在则从原路径读取
app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use('/images', express.static(path.join(__dirname, '../../frontend/public/images')));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pets', petRoutes.router);
app.use('/api/assignments', assignmentRoutes);
// 纸质扫描挂在同一前缀下（路径自带 /:id/paper-scan/...），放在后面避免抢占原有路由
app.use('/api/assignments', paperScanRoutes);
app.use('/api/battles', battleRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/achievements', achievementRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/admin/system', systemRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/forum', forumRoutes);
app.use('/api/notifications', notificationRoutes);
// 首页面向访客的公开接口（全部免登录，收口在 routes/public.js 里）
app.use('/api/public', publicRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/daily-tasks', dailyTasksModule.router);
app.use('/api/knowledge-points', knowledgePointRoutes);
app.use('/api/learning-reports', learningReportAiRoutes);
app.use('/api/learning-reports', learningReportRoutes);
app.use('/api/skills', skillRoutes);
app.use('/api/boss-battles', bossBattleRoutes);
app.use('/api/schools', schoolRoutes);
app.use('/api/ai-coach', aiCoachRoutes);
app.use('/api/question-bank', questionBankRoutes);
app.use('/api/cards', cardRoutes);
// AI 助手直连：/api/agent 用教师自己生成的令牌鉴权，AI 直接提交课堂做题题目
app.use('/api/agent', agentRoutes);
// AI 直连接令的生成与吊销（教师在页面里操作，走正常登录鉴权）
app.use('/api/agent-tokens', agentTokenRoutes);
// 学生端「我的资产明细」（金币 + 物品/装备/技能流水）
app.use('/api/users', userTransactionRoutes);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '班级宠物养成系统运行中' });
});
// 公开版本号：前端用它判断「服务端是否已升级」，有新版本就提示刷新页面
app.get('/api/version', (req, res) => {
  try {
    const { getCurrentVersion } = require('./utils/version');
    res.set('Cache-Control', 'no-store');
    res.json({ version: getCurrentVersion(), startedAt: STARTED_AT, serverTime: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: '获取版本失败' });
  }
});

// 前端静态文件（生产环境）
app.use(express.static(path.join(__dirname, '../public')));

// index.html 绝不能被缓存：否则升级后浏览器仍会加载旧版前端
app.get(['/', '/index.html'], (req, res, next) => {
  if (!fs.existsSync(PUBLIC_INDEX)) return next();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(PUBLIC_INDEX);
});

// SPA fallback：非 API 请求都返回 index.html
const PUBLIC_INDEX = path.join(__dirname, '../public/index.html');
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: '未找到请求的资源' });
  }
  // 后端未托管前端（前端由 Nginx 提供）时，返回干净的 404，不暴露服务器文件路径
  if (!fs.existsSync(PUBLIC_INDEX)) {
    return res.status(404).json({ error: '未找到请求的资源' });
  }
  res.sendFile(PUBLIC_INDEX);
});

// 错误处理
app.use((err, req, res, next) => {
  // 详细错误只写服务器日志（含堆栈），不返回给客户端，避免泄露文件路径等内部信息
  console.error('错误:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status >= 500 ? '服务器内部错误' : (status === 404 ? '未找到请求的资源' : (err.message || '请求失败'))
  });
});

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('客户端连接:', socket.id);

  // 尽力解析握手 token 把身份挂到 socket.data 上，供聊天类事件做权限校验。
  // 这里不强制拒绝连接：宠物互动、战斗等匿名用法也走同一条连接。
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role;
      socket.data.username = decoded.username || '';
    }
  } catch (e) {
    // token 缺失或过期：聊天事件会被下面的校验挡掉，不影响其它功能
  }

  // 是否有权访问该班级群：管理员直通；学生看 users.class_id；教师看 class_teachers
  const canAccessClassRoom = (classId) => {
    if (!socket.data.userId) return false;
    if (socket.data.role === 'admin') return true;
    return isClassMember(socket.data.userId, parseInt(classId, 10));
  };

  /**
   * 包一层事件处理，任何单个客户端发来的畸形数据都只记一条日志，绝不冒泡成未捕获异常。
   *
   * 必须这么做的原因（真实的「服务端突然停掉」隐患）：
   *   socket.io 的事件监听就是普通 EventEmitter 监听器。回调里抛错 →
   *   冒到 process 层就是 uncaughtException → Node 进程**直接退出**。
   *   而下面这些事件（battle-action / pet-interaction / typing-in-private）
   *   任何人连上 socket 就能发，且原先直接解构 data 成员、没做空值保护：
   *   客户端只要 `socket.emit('typing-in-private')`（不带任何参数），
   *   `data.userId` 就抛 TypeError，整个后端进程随即退出——
   *   表现正是「日志停在一条正常请求之后就没了」。
   */
  const safeOn = (event, handler) => {
    socket.on(event, (payload) => {
      try {
        handler(payload);
      } catch (error) {
        console.error(`Socket 事件处理异常（事件 ${event}，用户 ${socket.data.userId || '未认证'}）:`, error);
      }
    });
  };

  // 加入战斗房间
  safeOn('join-battle', (battleId) => {
    socket.join(`battle:${battleId}`);
    console.log(`用户 ${socket.id} 加入战斗房间：${battleId}`);
  });

  // 战斗动作
  safeOn('battle-action', (data) => {
    const d = data || {};
    socket.to(`battle:${d.battleId}`).emit('battle-action', d);
  });

  // 宠物互动
  safeOn('pet-interaction', (data) => {
    const d = data || {};
    socket.to(`user:${d.targetUserId}`).emit('pet-interaction', d);
  });

  // ==================== 聊天系统 ====================

  // 加入班级群聊房间（原先任何人可加入任意班群被动收消息）
  safeOn('join-class-chat', (classId) => {
    if (!canAccessClassRoom(classId)) {
      console.warn(`⛔ 用户 ${socket.data.userId || '未认证'} 无权加入班级群聊：${classId}`);
      return;
    }
    socket.join(`class:${classId}`);
    console.log(`用户 ${socket.id} 加入班级群聊：${classId}`);
  });

  // 离开班级群聊
  safeOn('leave-class-chat', (classId) => {
    socket.leave(`class:${classId}`);
    console.log(`用户 ${socket.id} 离开班级群聊：${classId}`);
  });

  // 班级群聊消息（实时广播）
  safeOn('send-class-message', (data) => {
    const { classId, message } = data || {};
    if (!canAccessClassRoom(classId)) {
      console.warn(`⛔ 用户 ${socket.data.userId || '未认证'} 无权向班级群 ${classId} 发消息`);
      return;
    }
    io.to(`class:${classId}`).emit('new-class-message', message);
  });

  // 加入私聊房间（用两个用户的ID排序组合作为房间名）
  // 前端历史上只传了 target_user_id，服务端却解构 userId1/userId2，导致房间名算成
  // private:undefined-undefined，双方都收不到实时私聊。这里兼容两种入参。
  safeOn('join-private-chat', (payload) => {
    if (!socket.data.userId) return;
    const userId1 = payload?.userId1 ?? socket.data.userId;
    const userId2 = payload?.userId2 ?? payload?.target_user_id;
    if (!userId2 || [Number(userId1), Number(userId2)].includes(Number(socket.data.userId)) === false) return;
    const roomId = `private:${[userId1, userId2].sort((a, b) => a - b).join('-')}`;
    socket.join(roomId);
    console.log(`用户 ${socket.id} 加入私聊房间：${roomId}`);
  });

  // 私聊消息（实时推送）
  safeOn('send-private-message', (data) => {
    if (!socket.data.userId) return;
    const { targetUserId, message } = data || {};
    // 只能往自己参与的私聊里发
    if (!targetUserId || !message || Number(message.user_id) !== Number(socket.data.userId)) return;
    const roomId = `private:${[message.user_id, targetUserId].sort((a, b) => a - b).join('-')}`;
    io.to(roomId).emit('new-private-message', message);
  });

  // 用户正在输入中
  safeOn('typing-in-class', (data) => {
    if (!canAccessClassRoom(data?.classId)) return;
    socket.to(`class:${data.classId}`).emit('user-typing', { username: socket.data.username || '' });
  });

  safeOn('typing-in-private', (data) => {
    const d = data || {};
    const roomId = `private:${[d.userId, d.targetUserId].sort((a, b) => a - b).join('-')}`;
    socket.to(roomId).emit('user-typing', { username: d.username });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log('客户端断开连接:', socket.id);
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;

// 启动前自动执行数据库迁移：
// 传文件 + 重启即可完成建表/补列/老数据回填；迁移失败只记日志，不阻断服务启动（管理后台会给出提示）
//
// 这里补 .catch：runMigrations 内部虽然自己 try/catch 了迁移错误，但它 finally 里还会
// await knex.destroy()，一旦那一步拒绝（如数据库文件权限/句柄异常），整条链就变成一次
// 未处理的 Promise 拒绝 —— Node ≥15 默认会把它当成致命错误直接结束进程。
runMigrations().catch((error) => {
  console.error('❌ 数据库迁移链路出现未处理错误（服务仍会尝试启动）:', error && error.message ? error.message : error);
  processGuard.logEvent('ERROR', `数据库迁移链路未处理错误：${error && error.message ? error.message : error}`, error);
}).finally(() => {
  // 基础数据兜底：启动只跑迁移、不跑 seed，会导致成就/宠物/道具等基础数据为空
  //（典型表现：后台一切正常，但学生的「成就」列表是空的、宠物选不了）
  // 这里只补空表，绝不覆盖已有数据，因此不会影响管理员自定义的内容。
  try {
    const filled = require('./services/baseData').ensureBaseData();
    const added = filled.filter((x) => x.status === 'filled');
    if (added.length > 0) {
      console.log(`✅ 已自动补齐基础数据：${added.map((x) => x.label + " " + x.count + " 条").join("，")}`);
    }
  } catch (e) {
    console.error('基础数据兜底失败（不影响服务启动）:', e.message);
  }

  // 迁移完成后兜底清理：教师生成了题目却没发布就关掉页面的情况，
  // 前端来不及上报撤销，这里统一退还额度并删掉无人引用的孤儿题目
  try {
    require('./services/aiUsage').sweepOrphanGenerations();
  } catch (e) {
    console.error('清理未发布生成失败:', e.message);
  }
  server.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log(`环境：${process.env.NODE_ENV}`);
    // 每次重启都在生命周期日志里留一条「启动完成」标记：
    // 之后对着日志看，就能一眼分辨「进程是重启过」还是「压根没起来」。
    processGuard.logEvent('INFO', `✅ 服务启动完成，监听端口 ${PORT}（启动时间 ${new Date().toISOString()}）`);
  });
});

module.exports = { app, io };
