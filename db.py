import os
import psycopg2

FREE_LIMIT_DEFAULT = 3
FREE_LIMIT_PROMO = 10

# Первые платежи принимаются напрямую по СБП (личный перевод, без самозанятости).
# После этого числа приём приостанавливается до регистрации самозанятости —
# см. план разработки.md.
MAX_PAYMENTS_BEFORE_REGISTRATION = 17


def get_conn():
    return psycopg2.connect(os.environ['DATABASE_URL'])


def init_db():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    promo_code TEXT,
                    first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
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
        conn.commit()
    finally:
        conn.close()


def touch_device(device_id):
    """Ensure a devices row exists; return current promo_code (or None)."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO devices (device_id) VALUES (%s) ON CONFLICT (device_id) DO NOTHING",
                (device_id,)
            )
            cur.execute("SELECT promo_code FROM devices WHERE device_id = %s", (device_id,))
            row = cur.fetchone()
        conn.commit()
        return row[0] if row else None
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


def is_pro(device_id):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM subscriptions WHERE device_id = %s AND pro_until > now() LIMIT 1",
                (device_id,)
            )
            return cur.fetchone() is not None
    finally:
        conn.close()


def check_and_increment_usage(device_id):
    """
    Returns (allowed: bool, used: int, limit: int).
    Atomically increments today's count and checks it against the limit —
    a separate SELECT-then-UPDATE would race under concurrent requests
    (e.g. a double-tap or two open tabs) and let more than `limit` through.
    """
    if is_pro(device_id):
        return True, 0, None

    promo_code = touch_device(device_id)
    limit = FREE_LIMIT_PROMO if promo_code else FREE_LIMIT_DEFAULT

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO usage_log (device_id, day, scans_count) VALUES (%s, CURRENT_DATE, 1) "
                "ON CONFLICT (device_id, day) DO UPDATE SET scans_count = usage_log.scans_count + 1 "
                "RETURNING scans_count",
                (device_id,)
            )
            used = cur.fetchone()[0]

            if used > limit:
                cur.execute(
                    "UPDATE usage_log SET scans_count = scans_count - 1 "
                    "WHERE device_id = %s AND day = CURRENT_DATE",
                    (device_id,)
                )
                conn.commit()
                return False, limit, limit

        conn.commit()
        return True, used, limit
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


def accepting_payments():
    return count_payments_granted() < MAX_PAYMENTS_BEFORE_REGISTRATION


def grant_pro(device_id, email, days=30):
    """Raises RuntimeError if the pre-registration payment limit has been reached."""
    if not accepting_payments():
        raise RuntimeError('payment_limit_reached')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
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
