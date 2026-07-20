import os
import json
import psycopg2

# Модель бесплатных сканов: сначала щедрый lifetime-пул (не сбрасывается по дням),
# после его исчерпания — постоянный дневной лимит. Промокод повышает именно
# lifetime-пул (более щедрое знакомство с продуктом для пришедших по каналу),
# а не дневной хвост. Все три значения настраиваются через .env.
FREE_LIFETIME_LIMIT       = int(os.environ.get('FREE_LIFETIME_LIMIT', 20))
FREE_LIFETIME_LIMIT_PROMO = int(os.environ.get('FREE_LIFETIME_LIMIT_PROMO', 40))
FREE_DAILY_LIMIT_AFTER    = int(os.environ.get('FREE_DAILY_LIMIT_AFTER', 3))

# Первые платежи принимаются напрямую по СБП (личный перевод, без самозанятости).
# После этого числа приём приостанавливается до регистрации самозанятости —
# см. план разработки.md.
MAX_PAYMENTS_BEFORE_REGISTRATION = 17


def get_conn():
    return psycopg2.connect(os.environ['DATABASE_URL'], connect_timeout=10)


def init_db():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    promo_code TEXT,
                    email TEXT,
                    first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("ALTER TABLE devices ADD COLUMN IF NOT EXISTS email TEXT")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS usage_log (
                    device_id TEXT NOT NULL,
                    day DATE NOT NULL,
                    scans_count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (device_id, day)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id SERIAL PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    email TEXT,
                    pro_until TIMESTAMPTZ NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_subscriptions_device ON subscriptions(device_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(email)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS promo_codes (
                    code TEXT PRIMARY KEY,
                    channel_label TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS events (
                    id SERIAL PRIMARY KEY,
                    type TEXT NOT NULL,
                    device_id TEXT,
                    ts TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS analytics_events (
                    id SERIAL PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    device_id TEXT,
                    source TEXT NOT NULL,
                    name TEXT NOT NULL,
                    target TEXT,
                    duration_ms INTEGER,
                    meta JSONB,
                    url TEXT,
                    ts TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_analytics_source_name_target ON analytics_events(source, name, target)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id)")
        conn.commit()
    finally:
        conn.close()


def _touch_device(cur, device_id):
    """Ensure a devices row exists on the given cursor; return current promo_code (or None)."""
    cur.execute(
        "INSERT INTO devices (device_id) VALUES (%s) ON CONFLICT (device_id) DO NOTHING",
        (device_id,)
    )
    cur.execute("SELECT promo_code FROM devices WHERE device_id = %s", (device_id,))
    row = cur.fetchone()
    return row[0] if row else None


def set_device_email(device_id, email):
    """Associate an email with a device before payment, so /admin/grant can
    auto-fill it later — the admin only has the device_id from the payment
    comment, not the email, when confirming a manual SBP transfer."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO devices (device_id, email) VALUES (%s, %s) "
                "ON CONFLICT (device_id) DO UPDATE SET email = EXCLUDED.email",
                (device_id, email)
            )
        conn.commit()
    finally:
        conn.close()


def set_promo_code(device_id, code):
    """Validate promo code and attach it to the device. Returns True if applied."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT code FROM promo_codes WHERE code = %s", (code,))
            if cur.fetchone() is None:
                return False
            cur.execute(
                "INSERT INTO devices (device_id, promo_code) VALUES (%s, %s) "
                "ON CONFLICT (device_id) DO UPDATE SET promo_code = EXCLUDED.promo_code",
                (device_id, code)
            )
        conn.commit()
        return True
    finally:
        conn.close()


def check_and_increment_usage(device_id):
    """
    Returns (allowed: bool, used: int, limit: int).

    Two phases:
      1. Lifetime pool (FREE_LIFETIME_LIMIT, or _PROMO with a valid promo code)
         — not reset daily. While the running lifetime total is under this
         cap, every scan is allowed regardless of which day it falls on.
      2. Once the lifetime pool is exhausted, falls back to a plain daily cap
         (FREE_DAILY_LIMIT_AFTER) that resets every day, forever.

    Everything happens on one connection with the row locked via the
    INSERT ... ON CONFLICT DO UPDATE — a separate SELECT-then-UPDATE would
    race under concurrent requests (e.g. a double-tap or two open tabs) and
    let more than the limit through. Single connection matters here more
    than anywhere else since this runs on every scan (/analyze, /lookup).
    """
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM subscriptions WHERE device_id = %s AND pro_until > now() LIMIT 1",
                (device_id,)
            )
            if cur.fetchone() is not None:
                conn.commit()
                return True, 0, None

            promo_code = _touch_device(cur, device_id)
            lifetime_limit = FREE_LIFETIME_LIMIT_PROMO if promo_code else FREE_LIFETIME_LIMIT

            cur.execute(
                "SELECT COALESCE(SUM(scans_count), 0) FROM usage_log WHERE device_id = %s",
                (device_id,)
            )
            lifetime_used_before = cur.fetchone()[0]

            cur.execute(
                "INSERT INTO usage_log (device_id, day, scans_count) VALUES (%s, CURRENT_DATE, 1) "
                "ON CONFLICT (device_id, day) DO UPDATE SET scans_count = usage_log.scans_count + 1 "
                "RETURNING scans_count",
                (device_id,)
            )
            today_used = cur.fetchone()[0]

            if lifetime_used_before < lifetime_limit:
                # Still inside the lifetime pool — allowed regardless of today's count.
                conn.commit()
                return True, lifetime_used_before + 1, lifetime_limit

            # Lifetime pool exhausted — plain daily cap from here on.
            if today_used > FREE_DAILY_LIMIT_AFTER:
                cur.execute(
                    "UPDATE usage_log SET scans_count = scans_count - 1 "
                    "WHERE device_id = %s AND day = CURRENT_DATE",
                    (device_id,)
                )
                conn.commit()
                return False, FREE_DAILY_LIMIT_AFTER, FREE_DAILY_LIMIT_AFTER

        conn.commit()
        return True, today_used, FREE_DAILY_LIMIT_AFTER
    finally:
        conn.close()


def count_payments_granted():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM events WHERE type = 'payment_granted'")
            return cur.fetchone()[0]
    finally:
        conn.close()


FUNNEL_EVENT_TYPES = ('paywall_shown', 'buy_click', 'payment_granted', 'pwa_installed')


def funnel_counts():
    """Counts for the demand-test funnel: paywall shown -> buy click -> payment granted."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT type, COUNT(*) FROM events WHERE type IN %s GROUP BY type",
                (FUNNEL_EVENT_TYPES,)
            )
            counts = dict(cur.fetchall())
        return {t: counts.get(t, 0) for t in FUNNEL_EVENT_TYPES}
    finally:
        conn.close()


def funnel_counts_by_channel():
    """Same funnel, broken down by promo_code (channel attribution) so we can compare
    traffic sources against each other — device_id links events to the promo_code
    it was tagged with on the paywall. Devices without a code are grouped together."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(d.promo_code, 'без промокода') AS channel, e.type, COUNT(*) "
                "FROM events e LEFT JOIN devices d ON d.device_id = e.device_id "
                "WHERE e.type IN %s "
                "GROUP BY channel, e.type",
                (FUNNEL_EVENT_TYPES,)
            )
            rows = cur.fetchall()
        result = {}
        for channel, event_type, count in rows:
            result.setdefault(channel, {t: 0 for t in FUNNEL_EVENT_TYPES})
            result[channel][event_type] = count
        return result
    finally:
        conn.close()


def grant_pro(device_id, email, days=30):
    """Raises RuntimeError if the pre-registration payment limit has been reached."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM events WHERE type = 'payment_granted'")
            if cur.fetchone()[0] >= MAX_PAYMENTS_BEFORE_REGISTRATION:
                raise RuntimeError('payment_limit_reached')

            if not email:
                cur.execute("SELECT email FROM devices WHERE device_id = %s", (device_id,))
                row = cur.fetchone()
                email = row[0] if row else None

            cur.execute(
                "INSERT INTO subscriptions (device_id, email, pro_until) "
                "VALUES (%s, %s, now() + (%s || ' days')::interval)",
                (device_id, email, days)
            )
        conn.commit()
    finally:
        conn.close()


def recover_pro(email, new_device_id):
    """Find the latest pro_until for this email and re-grant it to new_device_id."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pro_until FROM subscriptions WHERE email = %s AND pro_until > now() "
                "ORDER BY pro_until DESC LIMIT 1",
                (email,)
            )
            row = cur.fetchone()
            if row is None:
                return False
            pro_until = row[0]
            cur.execute(
                "INSERT INTO subscriptions (device_id, email, pro_until) VALUES (%s, %s, %s)",
                (new_device_id, email, pro_until)
            )
        conn.commit()
        return True
    finally:
        conn.close()


def log_event(event_type, device_id):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO events (type, device_id) VALUES (%s, %s)",
                (event_type, device_id)
            )
        conn.commit()
    finally:
        conn.close()


def log_analytics_events(session_id, device_id, source, events):
    """Bulk-insert a batch of client-side analytics events (clicks, scroll
    depth, time spent per landing section / app tab). Each event is a dict
    with name, target, duration_ms, meta, url — already validated/sanitized
    by the caller."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO analytics_events "
                "(session_id, device_id, source, name, target, duration_ms, meta, url) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    (
                        session_id, device_id, source,
                        e['name'], e.get('target'), e.get('duration_ms'),
                        json.dumps(e['meta']) if e.get('meta') is not None else None,
                        e.get('url'),
                    )
                    for e in events
                ]
            )
        conn.commit()
    finally:
        conn.close()


ANALYTICS_MAX_TARGETS_PER_GROUP = 15


def analytics_summary():
    """Aggregated view for the admin panel: event counts and average duration
    (for time-based events like section_time/tab_time), grouped by source,
    event name and target, over the last 30 days."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT source, name, target, COUNT(*), AVG(duration_ms)
                FROM analytics_events
                WHERE ts > now() - interval '30 days'
                GROUP BY source, name, target
                ORDER BY source, name, COUNT(*) DESC
            """)
            rows = cur.fetchall()

            cur.execute("""
                SELECT source, COUNT(DISTINCT session_id), COUNT(*)
                FROM analytics_events
                WHERE ts > now() - interval '30 days'
                GROUP BY source
            """)
            overview_rows = cur.fetchall()
        result = {}
        for source, name, target, count, avg_duration in rows:
            groups = result.setdefault(source, {}).setdefault(name, [])
            if len(groups) < ANALYTICS_MAX_TARGETS_PER_GROUP:
                groups.append({
                    'target': target,
                    'count': count,
                    'avg_duration_ms': round(avg_duration) if avg_duration is not None else None,
                })
        overview = {source: {'sessions': sessions, 'events': events} for source, sessions, events in overview_rows}
        return {'overview': overview, 'groups': result}
    finally:
        conn.close()
