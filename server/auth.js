const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// 确保数据目录存在
function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
}

// 读取用户数据
function readUsers() {
  ensureDataDir();
  if (!fs.existsSync(config.usersFile)) {
    // 创建默认管理员账户 (密码: admin123)
    const defaultUsers = {
      users: [{
        id: '1',
        username: 'admin',
        password: bcrypt.hashSync('admin123', 10),
        isAdmin: true
      }]
    };
    fs.writeFileSync(config.usersFile, JSON.stringify(defaultUsers, null, 2));
    return defaultUsers;
  }
  return JSON.parse(fs.readFileSync(config.usersFile, 'utf-8'));
}

// 保存用户数据
function saveUsers(data) {
  ensureDataDir();
  fs.writeFileSync(config.usersFile, JSON.stringify(data, null, 2));
}

// 读取浏览器配置
function readBrowsers() {
  ensureDataDir();
  if (!fs.existsSync(config.browsersFile)) {
    const defaultBrowsers = { browsers: [] };
    fs.writeFileSync(config.browsersFile, JSON.stringify(defaultBrowsers, null, 2));
    return defaultBrowsers;
  }
  return JSON.parse(fs.readFileSync(config.browsersFile, 'utf-8'));
}

// 保存浏览器配置
function saveBrowsers(data) {
  ensureDataDir();
  fs.writeFileSync(config.browsersFile, JSON.stringify(data, null, 2));
}

// 用户登录
async function login(username, password) {
  const data = readUsers();
  const user = data.users.find(u => u.username === username);
  
  if (!user) {
    throw new Error('User not found');
  }
  
  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    throw new Error('Invalid password');
  }
  
  const token = jwt.sign(
    { id: user.id, username: user.username, isAdmin: user.isAdmin },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
  
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin
    }
  };
}

// JWT 验证中间件
function authMiddleware(req, res, next) {
  // 支持 Authorization header 和 query parameter 中的 token
  let token = null;
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }
  
  if (!token) {
    return res.status(401).json({ error: 'No authentication token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
}

// 管理员权限中间件
function adminMiddleware(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
}

// 验证 WebSocket 连接的 token
function verifyWsToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return null;
  }
}

// 用户管理 API
const userApi = {
  // 获取所有用户
  getAll() {
    const data = readUsers();
    return data.users.map(u => ({
      id: u.id,
      username: u.username,
      isAdmin: u.isAdmin
    }));
  },
  
  // 创建用户
  async create(username, password, isAdmin = false) {
    const data = readUsers();
    
    if (data.users.find(u => u.username === username)) {
      throw new Error('Username already exists');
    }
    
    const newUser = {
      id: Date.now().toString(),
      username,
      password: await bcrypt.hash(password, 10),
      isAdmin
    };
    
    data.users.push(newUser);
    saveUsers(data);
    
    return {
      id: newUser.id,
      username: newUser.username,
      isAdmin: newUser.isAdmin
    };
  },
  
  // 更新用户
  async update(id, updates) {
    const data = readUsers();
    const index = data.users.findIndex(u => u.id === id);
    
    if (index === -1) {
      throw new Error('User not found');
    }
    
    if (updates.username) {
      const existing = data.users.find(u => u.username === updates.username && u.id !== id);
      if (existing) {
        throw new Error('Username already exists');
      }
      data.users[index].username = updates.username;
    }
    
    if (updates.password) {
      data.users[index].password = await bcrypt.hash(updates.password, 10);
    }
    
    if (typeof updates.isAdmin === 'boolean') {
      data.users[index].isAdmin = updates.isAdmin;
    }
    
    saveUsers(data);
    
    return {
      id: data.users[index].id,
      username: data.users[index].username,
      isAdmin: data.users[index].isAdmin
    };
  },
  
  // 删除用户
  delete(id) {
    const data = readUsers();
    const index = data.users.findIndex(u => u.id === id);
    
    if (index === -1) {
      throw new Error('User not found');
    }
    
    // Prevent deleting the last admin
    if (data.users[index].isAdmin) {
      const adminCount = data.users.filter(u => u.isAdmin).length;
      if (adminCount <= 1) {
        throw new Error('Cannot delete the last admin');
      }
    }
    
    data.users.splice(index, 1);
    saveUsers(data);
  }
};

// 浏览器配置 API
const browserApi = {
  // 获取所有浏览器
  getAll() {
    const data = readBrowsers();
    return data.browsers.map(b => ({
      id: b.id,
      name: b.name,
      url: b.url,
      hasPassword: !!b.password
    }));
  },
  
  // 获取单个浏览器
  getById(id) {
    const data = readBrowsers();
    const browser = data.browsers.find(b => b.id === id);
    if (!browser) return null;
    return {
      id: browser.id,
      name: browser.name,
      url: browser.url,
      hasPassword: !!browser.password
    };
  },
  
  // 验证浏览器密码
  async verifyPassword(id, password) {
    const data = readBrowsers();
    const browser = data.browsers.find(b => b.id === id);
    
    if (!browser) {
      throw new Error('Browser not found');
    }
    
    if (!browser.password) {
      return true; // 无密码保护
    }
    
    return await bcrypt.compare(password, browser.password);
  },
  
  // 创建浏览器
  async create(id, name, url, password = null) {
    const data = readBrowsers();
    
    if (data.browsers.find(b => b.id === id)) {
      throw new Error('Browser ID already exists');
    }
    
    const newBrowser = {
      id,
      name,
      url,
      password: password ? await bcrypt.hash(password, 10) : null
    };
    
    data.browsers.push(newBrowser);
    saveBrowsers(data);
    
    return {
      id: newBrowser.id,
      name: newBrowser.name,
      url: newBrowser.url,
      hasPassword: !!newBrowser.password
    };
  },
  
  // 更新浏览器
  async update(id, updates) {
    const data = readBrowsers();
    const index = data.browsers.findIndex(b => b.id === id);
    
    if (index === -1) {
      throw new Error('Browser not found');
    }
    
    if (updates.name) {
      data.browsers[index].name = updates.name;
    }
    
    if (updates.url) {
      data.browsers[index].url = updates.url;
    }
    
    if (updates.password !== undefined) {
      data.browsers[index].password = updates.password 
        ? await bcrypt.hash(updates.password, 10) 
        : null;
    }
    
    saveBrowsers(data);
    
    return {
      id: data.browsers[index].id,
      name: data.browsers[index].name,
      url: data.browsers[index].url,
      hasPassword: !!data.browsers[index].password
    };
  },
  
  // 删除浏览器
  delete(id) {
    const data = readBrowsers();
    const index = data.browsers.findIndex(b => b.id === id);
    
    if (index === -1) {
      throw new Error('Browser not found');
    }
    
    data.browsers.splice(index, 1);
    saveBrowsers(data);
  }
};

module.exports = {
  login,
  authMiddleware,
  adminMiddleware,
  verifyWsToken,
  userApi,
  browserApi
};
