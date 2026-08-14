/* =====================================================
   REALM CITY — الباك إند (السيرفر الخلفي)
   يستقبل طلبات التفعيل، يخزنها بقاعدة البيانات،
   يرسل إشعار للديسكورد، ويولّد كود تفعيل يقرأه سيرفر الـFiveM
   ===================================================== */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'realm2026'; // بدّلها من متغيرات Railway حتمًا

// تخزين بسيط لتوكنات تسجيل الدخول (تنمسح لو السيرفر أعاد التشغيل — كافي لأونر واحد أو اثنين)
const adminTokens = new Set();

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'دخول غير مصرح' });
  }
  next();
}

/* ---------- الاتصال بقاعدة البيانات ---------- */
let pool;
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

  // ينشئ الجدول تلقائيًا أول مرة لو ما كان موجود
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      subtitle VARCHAR(100) DEFAULT '',
      price VARCHAR(20) NOT NULL,
      features TEXT NOT NULL,
      sort_order INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // لو الجدول فاضي، نعبيه بالباقات الافتراضية الثلاث أول مرة بس
  const [existing] = await pool.query('SELECT COUNT(*) as c FROM packages');
  if (existing[0].c === 0) {
    await pool.query(
      `INSERT INTO packages (name, subtitle, price, features, sort_order) VALUES
       (?, ?, ?, ?, 1), (?, ?, ?, ?, 2), (?, ?, ?, ?, 3)`,
      [
        'مواطن', 'للانضمام الأول', '15', JSON.stringify(['شخصية واحدة', 'مراجعة قصة الشخصية', 'كود تفعيل فوري', 'دعم عبر التذاكر']),
        'نافذ', 'لمن يبي تجربة أوسع', '35', JSON.stringify(['حتى 3 شخصيات', 'أولوية بالمراجعة', 'رتبة مميزة داخل السيرفر', 'دعم مباشر بالديسكورد']),
        'وجه بارز', 'لأصحاب الحضور القوي', '70', JSON.stringify(['شخصيات غير محدودة', 'مراجعة خاصة لقصة الشخصية', 'وصول لمناطق حصرية', 'خط دعم مباشر']),
      ]
    );
  }

  console.log('✅ قاعدة البيانات جاهزة');
}

/* ---------- توليد كود تفعيل فريد ---------- */
function genCode() {
  const rand = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `REALM-${rand()}-${rand()}`;
}

/* ---------- إرسال إشعار للديسكورد ---------- */
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

/* =====================================================
   1) استقبال طلب تفعيل جديد من الموقع
   ===================================================== */
app.post('/api/apply', async (req, res) => {
  try {
    const { character_name, discord_username, discord_id, character_idea, package_name } = req.body;

    if (!character_name || !discord_username || !character_idea || !package_name) {
      return res.status(400).json({ error: 'كمّل كل الحقول المطلوبة' });
    }
    if (character_idea.length < 30) {
      return res.status(400).json({ error: 'قصة الشخصية قصيرة جدًا' });
    }

    const activation_code = genCode();

    /* =====================================================
       ملاحظة عن الدفع:
       حاليًا الطلب يتفعّل مباشرة (status = whitelisted) فور التقديم،
       بدون بوابة دفع حقيقية.
       عشان تربط دفع فعلي: خلي status الأول = 'pending_payment'،
       وسوّي endpoint ثاني (/api/payment-webhook) يستقبل تأكيد
       الدفع من بوابتك (Tap / MyFatoorah / PayPal) ويحدّث الحالة
       إلى 'whitelisted' بعد التأكد من نجاح الدفع فعليًا.
       ===================================================== */
    const status = 'whitelisted';

    await pool.query(
      `INSERT INTO whitelist_applications
       (character_name, discord_username, discord_id, character_idea, package_name, activation_code, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [character_name, discord_username, discord_id || null, character_idea, package_name, activation_code, status]
    );

    sendToDiscord({ character_name, discord_username, character_idea, package_name, activation_code });

    res.json({ activation_code, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر، حاول مرة ثانية' });
  }
});

/* =====================================================
   2) التحقق من حالة كود معيّن (يستخدمه الموقع وأيضًا
      سكربت الـFiveM يقدر يستخدم نفس الفكرة بالاستعلام المباشر
      عن قاعدة البيانات)
   ===================================================== */
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

/* =====================================================
   3) endpoint يستخدمه سيرفر الـFiveM (مورد realm_whitelist)
      عشان يتحقق هل اللاعب مفعّل عن طريق معرف الديسكورد
      (بديل عن الاتصال المباشر بقاعدة البيانات لو حاب تعزل الصلاحيات)
   ===================================================== */
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

/* =====================================================
   4) placeholder لتأكيد الدفع (تربطه ببوابة الدفع لاحقًا)
   ===================================================== */
app.post('/api/payment-webhook', async (req, res) => {
  // TODO: تحقق من توقيع/صحة الإشعار حسب بوابة الدفع اللي بتستخدمها
  // ثم: UPDATE whitelist_applications SET status='whitelisted' WHERE activation_code = ?
  res.json({ received: true, note: 'هذا مكان جاهز لربط بوابة الدفع لاحقًا' });
});

/* =====================================================
   5) تسجيل دخول الأونر
   ===================================================== */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'كلمة المرور غلط' });
  }
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  adminTokens.add(token);
  res.json({ token });
});

/* =====================================================
   6) الباقات — عرض عام (يستخدمه الموقع نفسه)
   ===================================================== */
app.get('/api/packages', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM packages ORDER BY sort_order ASC, id ASC');
    res.json(rows.map(r => ({ ...r, features: JSON.parse(r.features) })));
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

/* =====================================================
   7) لوحة تحكم الأونر — كل المسارات محمية بكلمة المرور
   ===================================================== */

// سجل كل الطلبات (اللوق)
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM whitelist_applications ORDER BY created_at DESC LIMIT 500'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

// تغيير حالة طلب يدويًا (تفعيل / رفض)
app.patch('/api/admin/logs/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body; // whitelisted | rejected | pending_payment
    await pool.query('UPDATE whitelist_applications SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

// حذف طلب
app.delete('/api/admin/logs/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM whitelist_applications WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

// إضافة باقة (كتوقري) جديدة
app.post('/api/admin/packages', requireAdmin, async (req, res) => {
  try {
    const { name, subtitle, price, features, sort_order } = req.body;
    if (!name || !price || !Array.isArray(features)) {
      return res.status(400).json({ error: 'عبّي كل الحقول' });
    }
    await pool.query(
      'INSERT INTO packages (name, subtitle, price, features, sort_order) VALUES (?, ?, ?, ?, ?)',
      [name, subtitle || '', price, JSON.stringify(features), sort_order || 99]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

// تعديل باقة موجودة
app.put('/api/admin/packages/:id', requireAdmin, async (req, res) => {
  try {
    const { name, subtitle, price, features, sort_order } = req.body;
    await pool.query(
      'UPDATE packages SET name=?, subtitle=?, price=?, features=?, sort_order=? WHERE id=?',
      [name, subtitle || '', price, JSON.stringify(features), sort_order || 99, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

// حذف باقة
app.delete('/api/admin/packages/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM packages WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'صار خطأ' });
  }
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 REALM CITY شغّال على المنفذ ${PORT}`));
}).catch(err => {
  console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
  process.exit(1);
});
