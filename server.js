/* =====================================================
   REALM CITY — الباك إند (السيرفر الخلفي)
   يستقبل طلبات التفعيل، يخزنها بقاعدة البيانات،
   يرسل إشعار للديسكورد، ويولّد كود تفعيل يقرأه سيرفر الـFiveM
   + نظام حسابات إدارة (أونر / أدمن) بتسجيل دخول بالإيميل
   + إدارة الباقات من لوحة التحكم
   + سجل عمليات (لوق) لكل شي يصير بالإدارة
   ===================================================== */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const COOKIE_NAME = 'realm_admin_token';

if (!JWT_SECRET) {
  console.warn('⚠️  ما فيه JWT_SECRET بالـ .env — حط قيمة عشوائية طويلة قبل ما ترفع الموقع فعليًا.');
}
const EFFECTIVE_SECRET = JWT_SECRET || 'dev-only-insecure-secret-change-me';

let pool;

async function ensureColumn(table, column, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
}

async function initDB() {
  pool = await mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whitelist_applications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      character_name VARCHAR(100) NOT NULL,
      discord_username VARCHAR(100) NOT NULL,
      discord_id VARCHAR(50) NULL,
      character_idea TEXT NOT NULL,
      package_name VARCHAR(50) NOT NULL,
      activation_code VARCHAR(30) UNIQUE NOT NULL,
      status ENUM('pending_payment','whitelisted','rejected') DEFAULT 'pending_payment',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn('whitelist_applications', 'package_id', 'INT NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      role ENUM('owner','admin') NOT NULL DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      subtitle VARCHAR(150) DEFAULT '',
      features TEXT,
      featured TINYINT(1) DEFAULT 0,
      sort_order INT DEFAULT 0,
      active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      actor_email VARCHAR(150),
      actor_role VARCHAR(20),
      action VARCHAR(100) NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [pkgCount] = await pool.query('SELECT COUNT(*) AS c FROM packages');
  if (pkgCount[0].c === 0) {
    const defaults = [
      ['مواطن', 15.00, 'للانضمام الأول',
        JSON.stringify(['شخصية واحدة', 'مراجعة قصة الشخصية', 'كود تفعيل فوري', 'دعم عبر التذاكر']), 0, 1, 1],
      ['نافذ', 35.00, 'لمن يبي تجربة أوسع',
        JSON.stringify(['حتى 3 شخصيات', 'أولوية بالمراجعة', 'رتبة مميزة داخل السيرفر', 'دعم مباشر بالديسكورد']), 1, 2, 1],
      ['وجه بارز', 70.00, 'لأصحاب الحضور القوي',
        JSON.stringify(['شخصيات غير محدودة', 'مراجعة خاصة لقصة الشخصية', 'وصول لمناطق حصرية', 'خط دعم مباشر']), 0, 3, 1],
    ];
    for (const p of defaults) {
      await pool.query(
        'INSERT INTO packages (name, price, subtitle, features, featured, sort_order, active) VALUES (?,?,?,?,?,?,?)',
        p
      );
    }
    console.log('✅ تم إنشاء الباقات الافتراضية');
  }

  const [adminCount] = await pool.query('SELECT COUNT(*) AS c FROM admin_users');
  if (adminCount[0].c === 0) {
    if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
      const hash = await bcrypt.hash(process.env.OWNER_PASSWORD, 10);
      await pool.query(
        'INSERT INTO admin_users (email, password_hash, display_name, role) VALUES (?,?,?,?)',
        [process.env.OWNER_EMAIL.toLowerCase().trim(), hash, 'المالك', 'owner']
      );
      console.log('✅ تم إنشاء حساب الأونر الأساسي:', process.env.OWNER_EMAIL);
    } else {
      console.warn('⚠️  ما فيه أي حساب إدارة بعد. عبّي OWNER_EMAIL و OWNER_PASSWORD بمتغيرات Railway وأعد التشغيل عشان يتنشئ حساب الأونر تلقائيًا.');
    }
  }

  console.log('✅ قاعدة البيانات جاهزة');
}

function genCode() {
  const rand = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `REALM-${rand()}-${rand()}`;
}

async function logActivity(actor, action, details = '') {
  try {
    await pool.query(
      'INSERT INTO activity_logs (actor_email, actor_role, action, details) VALUES (?,?,?,?)',
      [actor?.email || 'النظام', actor?.role || 'system', action, details]
    );
  } catch (err) {
    console.error('فشل تسجيل العملية باللوق:', err.message);
  }
}

async function sendToDiscord(entry) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'REALM CITY — طلبات القبول',
        embeds: [{
          title: '📋 طلب تفعيل جديد',
          color: 4041471,
          fields: [
            { name: 'اسم الشخصية', value: entry.character_name, inline: true },
            { name: 'الديسكورد', value: entry.discord_username, inline: true },
            { name: 'الباقة', value: entry.package_name, inline: true },
            { name: 'كود التفعيل', value: `\`${entry.activation_code}\`` },
            { name: 'قصة الشخصية', value: entry.character_idea.slice(0, 1000) },
          ],
          footer: { text: 'نظام القبول — REALM CITY' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (err) {
    console.error('فشل إرسال إشعار الديسكورد:', err.message);
  }
}

function signToken(admin) {
  return jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role, display_name: admin.display_name },
    EFFECTIVE_SECRET,
    { expiresIn: '7d' }
  );
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'لازم تسجل دخول' });
  try {
    req.admin = jwt.verify(token, EFFECTIVE_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'الجلسة منتهية، سجل دخول من جديد' });
  }
}

function requireOwner(req, res, next) {
  if (req.admin?.role !== 'owner') {
    return res.status(403).json({ error: 'هذا الإجراء يخص الأونر فقط' });
  }
  next();
}

function safeParseFeatures(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

app.post('/api/apply', async (req, res) => {
  try {
    const { character_name, discord_username, discord_id, character_idea, package_id, package_name } = req.body;

    if (!character_name || !discord_username || !character_idea || (!package_id && !package_name)) {
      return res.status(400).json({ error: 'كمّل كل الحقول المطلوبة' });
    }
    if (character_idea.length < 30) {
      return res.status(400).json({ error: 'قصة الشخصية قصيرة جدًا' });
    }

    let finalPackageId = null;
    let finalPackageName = package_name || '';

    if (package_id) {
      const [pkgRows] = await pool.query('SELECT id, name, price FROM packages WHERE id = ? AND active = 1', [package_id]);
      if (!pkgRows.length) return res.status(400).json({ error: 'الباقة المختارة غير متاحة' });
      finalPackageId = pkgRows[0].id;
      finalPackageName = `${pkgRows[0].name} — ${Number(pkgRows[0].price)} ر.س`;
    }

    const activation_code = genCode();
    const status = 'whitelisted';

    await pool.query(
      `INSERT INTO whitelist_applications
       (character_name, discord_username, discord_id, character_idea, package_name, package_id, activation_code, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [character_name, discord_username, discord_id || null, character_idea, finalPackageName, finalPackageId, activation_code, status]
    );

    sendToDiscord({ character_name, discord_username, character_idea, package_name: finalPackageName, activation_code });
    logActivity(null, 'طلب تفعيل جديد', `${character_name} — الباقة: ${finalPackageName} — الكود: ${activation_code}`);

    res.json({ activation_code, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر، حاول مرة ثانية' });
  }
});

app.get('/api/status/:code', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT character_name, package_name, status FROM whitelist_applications WHERE activation_code = ?',
      [req.params.code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ found: false });
    res.json({ found: true, ...rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

app.get('/api/check-discord/:discordId', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT character_name, package_name FROM whitelist_applications
       WHERE discord_id = ? AND status = 'whitelisted' LIMIT 1`,
      [req.params.discordId]
    );
    res.json({ whitelisted: rows.length > 0, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

app.post('/api/payment-webhook', async (req, res) => {
  res.json({ received: true, note: 'هذا مكان جاهز لربط بوابة الدفع لاحقًا' });
});

app.get('/api/packages', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, price, subtitle, features, featured, sort_order FROM packages WHERE active = 1 ORDER BY sort_order ASC, id ASC'
    );
    res.json(rows.map(r => ({ ...r, features: safeParseFeatures(r.features) })));
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ error: 'دخّل الإيميل وكلمة المرور' });

    const [rows] = await pool.query('SELECT * FROM admin_users WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const token = signToken(user);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    logActivity(user, 'تسجيل دخول', `دخل ${user.display_name} للوحة الإدارة`);
    res.json({ id: user.id, email: user.email, display_name: user.display_name, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.post('/api/admin/logout', authMiddleware, (req, res) => {
  res.clearCookie(COOKIE_NAME);
  logActivity(req.admin, 'تسجيل خروج', '');
  res.json({ ok: true });
});

app.get('/api/admin/me', authMiddleware, (req, res) => {
  res.json(req.admin);
});

app.patch('/api/admin/me/password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة لازم تكون 6 أحرف على الأقل' });
    }
    const [rows] = await pool.query('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
    if (!rows.length) return res.status(404).json({ error: 'الحساب غير موجود' });

    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'كلمة المرور الحالية غلط' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, req.admin.id]);
    logActivity(req.admin, 'تغيير كلمة المرور', 'غيّر كلمة مروره الخاصة');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.get('/api/admin/users', authMiddleware, requireOwner, async (req, res) => {
  const [rows] = await pool.query('SELECT id, email, display_name, role, created_at FROM admin_users ORDER BY created_at ASC');
  res.json(rows);
});

app.post('/api/admin/users', authMiddleware, requireOwner, async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    const { password, display_name, role } = req.body;

    if (!email || !password || !display_name || !['owner', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'كمّل كل الحقول (إيميل، باسورد، اسم، رتبة صحيحة)' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور لازم 6 أحرف على الأقل' });

    const [existing] = await pool.query('SELECT id FROM admin_users WHERE email = ?', [email]);
    if (existing.length) return res.status(409).json({ error: 'فيه حساب بهذا الإيميل مسبقًا' });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO admin_users (email, password_hash, display_name, role) VALUES (?,?,?,?)',
      [email, hash, display_name, role]
    );

    logActivity(req.admin, 'إضافة حساب إدارة', `أضاف ${display_name} (${email}) برتبة ${role}`);
    res.json({ id: result.insertId, email, display_name, role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.patch('/api/admin/users/:id', authMiddleware, requireOwner, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { display_name, role, password } = req.body;

    const [rows] = await pool.query('SELECT * FROM admin_users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'الحساب غير موجود' });
    const target = rows[0];

    if (role && !['owner', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'رتبة غير صحيحة' });
    }
    if (role && role !== 'owner' && target.role === 'owner') {
      const [owners] = await pool.query("SELECT COUNT(*) AS c FROM admin_users WHERE role = 'owner'");
      if (owners[0].c <= 1) {
        return res.status(400).json({ error: 'لازم يبقى أونر واحد على الأقل بالموقع' });
      }
    }

    const fields = [];
    const values = [];
    if (display_name) { fields.push('display_name = ?'); values.push(display_name); }
    if (role) { fields.push('role = ?'); values.push(role); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور لازم 6 أحرف على الأقل' });
      fields.push('password_hash = ?');
      values.push(await bcrypt.hash(password, 10));
    }
    if (!fields.length) return res.status(400).json({ error: 'ما فيه شي للتحديث' });

    values.push(id);
    await pool.query(`UPDATE admin_users SET ${fields.join(', ')} WHERE id = ?`, values);

    logActivity(req.admin, 'تعديل حساب إدارة', `عدّل حساب ${target.email}${role ? ` -> رتبة جديدة: ${role}` : ''}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.delete('/api/admin/users/:id', authMiddleware, requireOwner, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query('SELECT * FROM admin_users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'الحساب غير موجود' });
    const target = rows[0];

    if (target.role === 'owner') {
      const [owners] = await pool.query("SELECT COUNT(*) AS c FROM admin_users WHERE role = 'owner'");
      if (owners[0].c <= 1) return res.status(400).json({ error: 'لازم يبقى أونر واحد على الأقل بالموقع' });
    }
    if (target.id === req.admin.id) {
      return res.status(400).json({ error: 'ما تقدر تحذف حسابك الحالي وأنت مسجل دخول فيه' });
    }

    await pool.query('DELETE FROM admin_users WHERE id = ?', [id]);
    logActivity(req.admin, 'حذف حساب إدارة', `حذف حساب ${target.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.get('/api/admin/packages', authMiddleware, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM packages ORDER BY sort_order ASC, id ASC');
  res.json(rows.map(r => ({ ...r, features: safeParseFeatures(r.features) })));
});

app.post('/api/admin/packages', authMiddleware, async (req, res) => {
  try {
    const { name, price, subtitle, features, featured, sort_order, active } = req.body;
    if (!name || price === undefined || price === null) {
      return res.status(400).json({ error: 'كمّل اسم الباقة والسعر' });
    }
    const [result] = await pool.query(
      'INSERT INTO packages (name, price, subtitle, features, featured, sort_order, active) VALUES (?,?,?,?,?,?,?)',
      [
        name,
        price,
        subtitle || '',
        JSON.stringify(Array.isArray(features) ? features : []),
        featured ? 1 : 0,
        sort_order || 0,
        active === false ? 0 : 1,
      ]
    );
    logActivity(req.admin, 'إضافة باقة', `أضاف باقة "${name}" بسعر ${price} ر.س`);
    res.json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.patch('/api/admin/packages/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, price, subtitle, features, featured, sort_order, active } = req.body;

    const [rows] = await pool.query('SELECT * FROM packages WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'الباقة غير موجودة' });

    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (price !== undefined) { fields.push('price = ?'); values.push(price); }
    if (subtitle !== undefined) { fields.push('subtitle = ?'); values.push(subtitle); }
    if (features !== undefined) { fields.push('features = ?'); values.push(JSON.stringify(Array.isArray(features) ? features : [])); }
    if (featured !== undefined) { fields.push('featured = ?'); values.push(featured ? 1 : 0); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(sort_order); }
    if (active !== undefined) { fields.push('active = ?'); values.push(active ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'ما فيه شي للتحديث' });

    values.push(id);
    await pool.query(`UPDATE packages SET ${fields.join(', ')} WHERE id = ?`, values);
    logActivity(req.admin, 'تعديل باقة', `عدّل باقة "${rows[0].name}" (#${id})`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.delete('/api/admin/packages/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query('SELECT * FROM packages WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'الباقة غير موجودة' });

    await pool.query('DELETE FROM packages WHERE id = ?', [id]);
    logActivity(req.admin, 'حذف باقة', `حذف باقة "${rows[0].name}" (#${id})`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.get('/api/admin/applications', authMiddleware, async (req, res) => {
  try {
    const status = req.query.status;
    const search = req.query.search ? `%${req.query.search}%` : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const conditions = [];
    const values = [];
    if (status && ['pending_payment', 'whitelisted', 'rejected'].includes(status)) {
      conditions.push('status = ?');
      values.push(status);
    }
    if (search) {
      conditions.push('(character_name LIKE ? OR discord_username LIKE ? OR activation_code LIKE ?)');
      values.push(search, search, search);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT * FROM whitelist_applications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM whitelist_applications ${where}`, values);

    res.json({ rows, total: countRows[0].c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.patch('/api/admin/applications/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!['pending_payment', 'whitelisted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'حالة غير صحيحة' });
    }
    const [rows] = await pool.query('SELECT * FROM whitelist_applications WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    await pool.query('UPDATE whitelist_applications SET status = ? WHERE id = ?', [status, id]);
    logActivity(req.admin, 'تحديث حالة طلب', `${rows[0].character_name} (${rows[0].activation_code}) -> ${status}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.delete('/api/admin/applications/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query('SELECT * FROM whitelist_applications WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    await pool.query('DELETE FROM whitelist_applications WHERE id = ?', [id]);
    logActivity(req.admin, 'حذف طلب', `حذف طلب ${rows[0].character_name} (${rows[0].activation_code})`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

app.get('/api/admin/logs', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const offset = Number(req.query.offset) || 0;
    const [rows] = await pool.query(
      'SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    const [countRows] = await pool.query('SELECT COUNT(*) AS c FROM activity_logs');
    res.json({ rows, total: countRows[0].c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
  }
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 REALM CITY شغّال على المنفذ ${PORT}`));
}).catch(err => {
  console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
  process.exit(1);
});
