export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api', '');

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  try {
    if (request.method === 'GET' && path === '/db') {
      const [users, meals, announcements, settings, invites, daySettings] = await Promise.all([
        db.prepare('SELECT * FROM users').all(),
        db.prepare('SELECT * FROM meals').all(),
        db.prepare('SELECT * FROM announcements').all(),
        db.prepare('SELECT * FROM settings').all(),
        db.prepare('SELECT * FROM invites').all(),
        db.prepare('SELECT * FROM day_settings').all(),
      ]);

      const data = {
        users: users.results,
        meals: meals.results,
        announcements: announcements.results,
        settings: Object.fromEntries(settings.results.map(r => [r.key, r.value])),
        invites: invites.results,
        day_settings: Object.fromEntries(daySettings.results.map(r => [r.date, r])),
        nextIds: {
          users: Math.max(0, ...users.results.map(u => u.id)) + 1,
          meals: Math.max(0, ...meals.results.map(m => m.id)) + 1,
          announcements: Math.max(0, ...announcements.results.map(a => a.id)) + 1,
        }
      };
      return new Response(JSON.stringify(data), { headers });
    }

    if (request.method === 'POST' && path === '/db') {
      const body = await request.json();

      if (body.settings) {
        for (const [key, value] of Object.entries(body.settings)) {
          await db.prepare(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
          ).bind(key, value, value).run();
        }
      }

      if (body.users) {
        for (const u of body.users) {
          await db.prepare(
            `INSERT INTO users (id, name, email, phone, password_hash, role, active, created_at, created_by, created_by_name, created_by_role, approved_at, approved_by, approval_note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name=?, email=?, phone=?, password_hash=?, role=?, active=?, created_by=?, created_by_name=?, created_by_role=?, approved_at=?, approved_by=?, approval_note=?`
          ).bind(
            u.id, u.name, u.email, u.phone || '', u.password, u.role, u.active,
            u.created_at || Date.now(), u.created_by || null, u.created_by_name || null,
            u.created_by_role || null, u.approved_at || null, u.approved_by || null,
            u.approval_note || null,
            u.name, u.email, u.phone || '', u.password, u.role, u.active,
            u.created_by || null, u.created_by_name || null,
            u.created_by_role || null, u.approved_at || null, u.approved_by || null,
            u.approval_note || null
          ).run();
        }
      }

      if (body.meals) {
        for (const m of body.meals) {
          await db.prepare(
            `INSERT INTO meals (id, user_id, date, meal_type, confirmed, served, served_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET confirmed=?, served=?, served_at=?`
          ).bind(
            m.id, m.user_id, m.date, m.meal_type || 'lunch',
            m.confirmed || 1, m.served || 0, m.served_at || null, m.created_at || Date.now(),
            m.confirmed || 1, m.served || 0, m.served_at || null
          ).run();
        }
      }

      if (body.announcements) {
        for (const a of body.announcements) {
          await db.prepare(
            `INSERT INTO announcements (id, title, body, visible_days, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title=?, body=?, visible_days=?`
          ).bind(
            a.id, a.title, a.body, a.visible_days || 7,
            a.created_by || null, a.created_at || Date.now(),
            a.title, a.body, a.visible_days || 7
          ).run();
        }
      }

      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}