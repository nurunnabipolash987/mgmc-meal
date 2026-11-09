// functions/api/[[path]].js — Hardened Server-Side Security & D1 Sync for MGMC Meal Management
const DEFAULT_TOKEN = 'mgmc_7f4a2c9e1b8d6a3c5e0d2f8b4a9c7e1d';

// In-memory rate limiter per IP (protects against brute-force / spam floods)
const ipHits = new Map();
function isRateLimited(ip, limit = 60, windowMs = 60000) {
  if (!ip) return false;
  const now = Date.now();
  const entry = ipHits.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
  } else {
    entry.count += 1;
  }
  ipHits.set(ip, entry);
  return entry.count > limit;
}

function isAuthorized(request, env) {
  // 1. Block cross-site requests from external domains
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite === 'cross-site') return false;

  // 2. Verify application token
  const clientToken = request.headers.get('X-App-Token');
  const expectedToken = (env && env.API_TOKEN) ? env.API_TOKEN : DEFAULT_TOKEN;
  return Boolean(clientToken && clientToken === expectedToken);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    }
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const clientIp = request.headers.get('CF-Connecting-IP') || 'local';

  // 1. Verify Token & Same-Origin headers
  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: 'Unauthorized request' }, 401);
  }

  // 2. Rate-limit write/delete operations per IP
  if (request.method !== 'GET' && isRateLimited(clientIp, 45, 60000)) {
    return jsonResponse({ error: 'Too many requests. Please wait a moment.' }, 429);
  }

  const db = env.DB;
  if (!db) {
    return jsonResponse({ error: 'D1 Database binding (DB) not found' }, 500);
  }

  try {
    // ====================================================
    // GET /api/db — Load database state from D1
    // ====================================================
    if (request.method === 'GET') {
      const [
        usersRes,
        mealsRes,
        annRes,
        settingsRes,
        invitesRes,
        daySettingsRes
      ] = await db.batch([
        db.prepare('SELECT * FROM users ORDER BY id ASC'),
        db.prepare('SELECT * FROM meals ORDER BY id ASC'),
        db.prepare('SELECT * FROM announcements ORDER BY id ASC'),
        db.prepare('SELECT * FROM settings'),
        db.prepare('SELECT * FROM invites'),
        db.prepare('SELECT * FROM day_settings')
      ]);

      const users = (usersRes.results || []).map(u => ({
        id: Number(u.id),
        name: u.name,
        email: u.email,
        phone: u.phone || '',
        password: u.password_hash,
        role: u.role,
        active: Number(u.active || 0),
        created_at: u.created_at,
        created_by: u.created_by,
        created_by_name: u.created_by_name,
        created_by_role: u.created_by_role,
        approved_at: u.approved_at,
        approved_by: u.approved_by,
        approval_note: u.approval_note
      }));

      const meals = (mealsRes.results || []).map(m => ({
        id: Number(m.id),
        user_id: Number(m.user_id),
        date: m.date,
        meal_type: m.meal_type || 'lunch',
        confirmed: Number(m.confirmed ?? 1),
        served: Number(m.served || 0),
        served_at: m.served_at,
        created_at: m.created_at
      }));

      const announcements = (annRes.results || []).map(a => ({
        id: Number(a.id),
        title: a.title,
        body: a.body,
        visible_days: Number(a.visible_days || 7),
        created_by: a.created_by,
        created_at: a.created_at
      }));

      const settings = {};
      for (const row of (settingsRes.results || [])) {
        settings[row.key] = row.value;
      }

      const day_settings = {};
      for (const row of (daySettingsRes.results || [])) {
        day_settings[row.date] = {
          cutoff_time: row.cutoff_time,
          lunch_enabled: Number(row.lunch_enabled ?? 1)
        };
      }

      const invites = invitesRes.results || [];
      const maxUid = users.reduce((m, x) => Math.max(m, x.id || 0), 0);
      const maxMid = meals.reduce((m, x) => Math.max(m, x.id || 0), 0);
      const maxAid = announcements.reduce((m, x) => Math.max(m, x.id || 0), 0);

      return jsonResponse({
        users,
        meals,
        announcements,
        settings,
        day_settings,
        invites,
        session: null,
        nextIds: {
          users: maxUid + 1,
          meals: maxMid + 1,
          announcements: maxAid + 1
        }
      });
    }

    // ====================================================
    // POST /api/db — Server-Validated Merge & Atomic Save
    // ====================================================
    if (request.method === 'POST') {
      const payload = await request.json();
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.users)) {
        return jsonResponse({ error: 'Invalid payload format' }, 400);
      }

      // Read current users & meals in D1 so a tampered client cannot wipe records
      const [existingUsersRes, existingMealsRes] = await db.batch([
        db.prepare('SELECT * FROM users'),
        db.prepare('SELECT * FROM meals')
      ]);
      const existingUsers = existingUsersRes.results || [];
      const existingMeals = existingMealsRes.results || [];

      // Parse tombstones (intentional deletions)
      let tombstones = {};
      if (payload.tombstones && typeof payload.tombstones === 'object') {
        tombstones = payload.tombstones;
      } else if (payload.settings && payload.settings.__tombstones_json) {
        try { tombstones = JSON.parse(payload.settings.__tombstones_json); } catch {}
      }

      // SECURITY GUARD 1: Block any attempt to wipe all users via POST
      if (existingUsers.length > 0 && payload.users.length === 0) {
        return jsonResponse({ error: 'Security block: Cannot overwrite non-empty user list with empty array' }, 403);
      }

      // Merge users safely (preserve existing users unless explicitly tombstoned)
      const userMap = new Map();
      for (const eu of existingUsers) {
        userMap.set(Number(eu.id), {
          id: Number(eu.id),
          name: eu.name,
          email: eu.email,
          phone: eu.phone || '',
          password: eu.password_hash,
          role: eu.role,
          active: Number(eu.active || 0),
          created_at: eu.created_at,
          created_by: eu.created_by,
          created_by_name: eu.created_by_name,
          created_by_role: eu.created_by_role,
          approved_at: eu.approved_at,
          approved_by: eu.approved_by,
          approval_note: eu.approval_note
        });
      }
      for (const u of payload.users) {
        const uid = Number(u.id);
        if (!uid || !u.email || !u.name) continue;
        const prev = userMap.get(uid);
        userMap.set(uid, {
          id: uid,
          name: String(u.name).slice(0, 120),
          email: String(u.email).toLowerCase().trim().slice(0, 120),
          phone: String(u.phone || '').slice(0, 20),
          password: u.password || (prev ? prev.password : ''),
          role: ['superadmin', 'matron', 'teacher', 'mess_manager'].includes(u.role) ? u.role : (prev ? prev.role : 'teacher'),
          active: u.active ? 1 : 0,
          created_at: u.created_at || (prev ? prev.created_at : Date.now()),
          created_by: u.created_by ?? (prev ? prev.created_by : null),
          created_by_name: u.created_by_name ?? (prev ? prev.created_by_name : null),
          created_by_role: u.created_by_role ?? (prev ? prev.created_by_role : null),
          approved_at: u.approved_at ?? (prev ? prev.approved_at : null),
          approved_by: u.approved_by ?? (prev ? prev.approved_by : null),
          approval_note: u.approval_note ?? (prev ? prev.approval_note : null)
        });
      }

      // Remove only explicitly tombstoned users, but NEVER allow deleting the last active superadmin
      let finalUsers = Array.from(userMap.values()).filter(u => !tombstones['user_' + u.id]);
      const hasActiveSuperAdmin = finalUsers.some(u => u.role === 'superadmin' && u.active === 1);
      if (!hasActiveSuperAdmin && existingUsers.length > 0) {
        const prevAdmin = existingUsers.find(u => u.role === 'superadmin' && Number(u.active) === 1) || existingUsers[0];
        if (prevAdmin) {
          const restored = userMap.get(Number(prevAdmin.id));
          if (restored) {
            restored.role = 'superadmin';
            restored.active = 1;
            if (!finalUsers.some(x => x.id === restored.id)) finalUsers.push(restored);
          }
        }
      }

      // Merge meals safely by unique key (user_id + date + meal_type)
      const mealKey = m => `${m.user_id}_${m.date}_${m.meal_type || 'lunch'}`;
      const mealMap = new Map();
      for (const em of existingMeals) {
        mealMap.set(mealKey(em), {
          id: Number(em.id),
          user_id: Number(em.user_id),
          date: em.date,
          meal_type: em.meal_type || 'lunch',
          confirmed: Number(em.confirmed ?? 1),
          served: Number(em.served || 0),
          served_at: em.served_at,
          created_at: em.created_at
        });
      }
      for (const m of (payload.meals || [])) {
        if (!m.user_id || !m.date) continue;
        const k = mealKey(m);
        mealMap.set(k, {
          id: Number(m.id || Date.now()),
          user_id: Number(m.user_id),
          date: String(m.date).slice(0, 10),
          meal_type: m.meal_type || 'lunch',
          confirmed: m.confirmed ? 1 : 0,
          served: m.served ? 1 : 0,
          served_at: m.served_at ?? null,
          created_at: m.created_at || Date.now()
        });
      }
      const validUserIds = new Set(finalUsers.map(u => u.id));
      const finalMeals = Array.from(mealMap.values()).filter(m => {
        if (!validUserIds.has(m.user_id)) return false;
        const k = mealKey(m);
        const delTs = tombstones['meal_' + k] || 0;
        return delTs <= (m.created_at || 0);
      });

      const stmts = [];

      // Save Users
      stmts.push(db.prepare('DELETE FROM users'));
      for (const u of finalUsers) {
        stmts.push(
          db.prepare(
            `INSERT INTO users (id, name, email, phone, password_hash, role, active, created_at, created_by, created_by_name, created_by_role, approved_at, approved_by, approval_note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
          ).bind(
            u.id, u.name, u.email, u.phone, u.password, u.role,
            u.active, u.created_at, u.created_by, u.created_by_name,
            u.created_by_role, u.approved_at, u.approved_by, u.approval_note
          )
        );
      }

      // Save Meals
      stmts.push(db.prepare('DELETE FROM meals'));
      for (const m of finalMeals) {
        stmts.push(
          db.prepare(
            `INSERT OR REPLACE INTO meals (id, user_id, date, meal_type, confirmed, served, served_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
          ).bind(
            m.id, m.user_id, m.date, m.meal_type,
            m.confirmed, m.served, m.served_at, m.created_at
          )
        );
      }

      // Save Announcements
      stmts.push(db.prepare('DELETE FROM announcements'));
      for (const a of (payload.announcements || [])) {
        if (tombstones['ann_' + a.id]) continue;
        stmts.push(
          db.prepare(
            `INSERT INTO announcements (id, title, body, visible_days, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
          ).bind(
            a.id, String(a.title || '').slice(0, 120), String(a.body || '').slice(0, 1000),
            Number(a.visible_days || 7), a.created_by ?? null, a.created_at || Date.now()
          )
        );
      }

      // Save Settings
      stmts.push(db.prepare('DELETE FROM settings'));
      for (const [k, v] of Object.entries(payload.settings || {})) {
        stmts.push(
          db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2)').bind(String(k), String(v ?? ''))
        );
      }

      // Save Day Settings
      stmts.push(db.prepare('DELETE FROM day_settings'));
      for (const [date, row] of Object.entries(payload.day_settings || {})) {
        stmts.push(
          db.prepare('INSERT INTO day_settings (date, cutoff_time, lunch_enabled) VALUES (?1, ?2, ?3)')
            .bind(date, row.cutoff_time ?? null, row.lunch_enabled != null ? Number(row.lunch_enabled) : 1)
        );
      }

      // Save Invites
      stmts.push(db.prepare('DELETE FROM invites'));
      for (const inv of (payload.invites || [])) {
        stmts.push(
          db.prepare(
            `INSERT INTO invites (token, created_by, expires_at, used_by, used_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
          ).bind(
            inv.token, inv.created_by ?? null, inv.expires_at ?? null,
            inv.used_by ?? null, inv.used_at ?? null, inv.created_at || Date.now()
          )
        );
      }

      await db.batch(stmts);
      return jsonResponse({ ok: true, log: ['saved'] });
    }

    // ====================================================
    // DELETE /api/db — Admin Reset
    // ====================================================
    if (request.method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM users'),
        db.prepare('DELETE FROM meals'),
        db.prepare('DELETE FROM announcements'),
        db.prepare('DELETE FROM settings'),
        db.prepare('DELETE FROM day_settings'),
        db.prepare('DELETE FROM invites')
      ]);
      return jsonResponse({ ok: true, log: ['reset'] });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return jsonResponse({ error: err.message || 'Server error' }, 500);
  }
}
