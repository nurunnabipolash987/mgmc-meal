CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER DEFAULT 0,
    created_at INTEGER,
    created_by INTEGER,
    created_by_name TEXT,
    created_by_role TEXT,
    approved_at INTEGER,
    approved_by TEXT,
    approval_note TEXT
);

CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    meal_type TEXT NOT NULL DEFAULT 'lunch',
    confirmed INTEGER DEFAULT 1,
    served INTEGER DEFAULT 0,
    served_at INTEGER,
    created_at INTEGER,
    UNIQUE(user_id, date, meal_type)
);

CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    visible_days INTEGER DEFAULT 7,
    created_by INTEGER,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    created_by INTEGER,
    expires_at INTEGER,
    used_by INTEGER,
    used_at INTEGER,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS day_settings (
    date TEXT PRIMARY KEY,
    cutoff_time TEXT,
    lunch_enabled INTEGER
);