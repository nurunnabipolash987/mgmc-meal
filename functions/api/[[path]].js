export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api', '');

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
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
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON: ' + e.message }), { status: 400, headers });
      }

      const log = [];
      try {
        await db.exec("DELETE FROM users; DELETE FROM meals; DELETE FROM announcements; DELETE FROM settings; DELETE FROM invites; DELETE FROM day_settings;");
        log.push('Cleared tables');

        if (body.settings && typeof body.settings === 'object') {
          const entries = Object.entries(body.settings);
          for (const [key, value] of entries) {
            await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(String(key), String(value == null ? '' : value)).run();
          }
          log.push(`Settings: ${entries.length}`);
        }

        if (Array.isArray(body.users)) {
          for (const u of body.users) {
            await db.prepare(`INSERT INTO users (id, name, email, phone, password_hash, role, active, created_at, created_by, created_by_name, created_by_role, approved_at, approved_by, approval_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
              u.id,
              String(u.name || ''),
              String(u.email || ''),
              String(u.phone || ''),
              String(u.password || ''),
              String(u.role || 'teacher'),
              Number(u.active || 0),
              Number(u.created_at || Date.now()),
              u.created_by != null ? Number(u.created_by) : null,
              u.created_by_name || null,
              u.created_by_role || null,
              u.approved_at != null ? Number(u.approved_at) : null,
              u.approved_by || null,
              u.approval_note || null
            ).run();
          }
          log.push(`Users: ${body.users.length}`);
        }

        if (Array.isArray(body.meals)) {
          for (const m of body.meals) {
            await db.prepare(`INSERT INTO meals (id, user_id, date, meal_type, confirmed, served, served_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
              m.id, Number(m.user_id), String(m.date || ''), String(m.meal_type || 'lunch'),
              Number(m.confirmed || 1), Number(m.served || 0),
              m.served_at != null ? Number(m.served_at) : null,
              Number(m.created_at || Date.now())
            ).run();
          }
          log.push(`Meals: ${body.meals.length}`);
        }

        if (Array.isArray(body.announcements)) {
          for (const a of body.announcements) {
            await db.prepare(`INSERT INTO announcements (id, title, body, visible_days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(
              a.id, String(a.title || ''), String(a.body || ''),
              Number(a.visible_days || 7),
              a.created_by != null ? Number(a.created_by) : null,
              Number(a.created_at || Date.now())
            ).run();
          }
          log.push(`Announcements: ${body.announcements.length}`);
        }

        if (Array.isArray(body.invites)) {
          for (const i of body.invites) {
            await db.prepare(`INSERT INTO invites (token, created_by, expires_at, used_by, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(
              String(i.token || ''),
              i.created_by != null ? Number(i.created_by) : null,
              i.expires_at != null ? Number(i.expires_at) : null,
              i.used_by != null ? Number(i.used_by) : null,
              i.used_at != null ? Number(i.used_at) : null,
              Number(i.created_at || Date.now())
            ).run();
          }
          log.push(`Invites: ${body.invites.length}`);
        }

        if (body.day_settings && typeof body.day_settings === 'object') {
          const entries = Object.entries(body.day_settings);
          for (const [date, ds] of entries) {
            await db.prepare(`INSERT INTO day_settings (date, cutoff_time, lunch_enabled) VALUES (?, ?, ?)`).bind(
              String(date),
              ds.cutoff_time ? String(ds.cutoff_time) : null,
              ds.lunch_enabled != null ? Number(ds.lunch_enabled) : null
            ).run();
          }
          log.push(`DaySettings: ${entries.length}`);
        }

        return new Response(JSON.stringify({ ok: true, log }), { headers });
      } catch (err) {
        console.error('POST error:', err);
        return new Response(JSON.stringify({ ok: false, error: err.message, log }), { status: 500, headers });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
  } catch (error) {
    console.error('General error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
}
