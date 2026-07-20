import os
import json
import base64
import re
import anthropic
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

import db

load_dotenv()

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

client = anthropic.Anthropic(api_key=os.environ.get('ANTHROPIC_API_KEY'))

ADMIN_SECRET = os.environ.get('ADMIN_SECRET')
PAYMENT_CARD_NUMBER = os.environ.get('PAYMENT_CARD_NUMBER', '')
SUPPORT_TELEGRAM_USERNAME = os.environ.get('SUPPORT_TELEGRAM_USERNAME', '')

DEVICE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,128}$')
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
SESSION_ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,128}$')
EVENT_NAME_RE = re.compile(r'^[A-Za-z0-9_]{1,64}$')

ANALYTICS_SOURCES = {'app', 'landing'}
ANALYTICS_MAX_EVENTS_PER_BATCH = 100
ANALYTICS_MAX_DURATION_MS = 6 * 60 * 60 * 1000  # 6 hours — generous upper bound, discards garbage
ANALYTICS_MAX_TARGET_LEN = 200
ANALYTICS_MAX_URL_LEN = 300
ANALYTICS_MAX_META_JSON_LEN = 2000

# 20 MB covers the largest legitimate payload (a base64-encoded /analyze image, capped
# at MAX_IMAGE_B64_LEN below); analytics batches are capped separately by field/event limits.
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

db.init_db()


def get_device_id(data):
    device_id = (data.get('device_id') or request.headers.get('X-Device-Id') or '').strip()
    if not DEVICE_ID_RE.match(device_id):
        return None
    return device_id


def require_admin():
    return ADMIN_SECRET and request.headers.get('X-Admin-Secret') == ADMIN_SECRET

SYSTEM_PROMPT = """Ты — эксперт-диетолог и нутрициолог. Твоя задача — анализировать фотографии еды и возвращать данные о калориях и питательных веществах строго в формате JSON.

Анализируй только реальную еду на фотографии. Возвращай ТОЛЬКО валидный JSON без каких-либо пояснений вне JSON.

Формат ответа:
{
  "total_calories": <число>,
  "protein": <граммы белка, число>,
  "fat": <граммы жиров, число>,
  "carbs": <граммы углеводов, число>,
  "dishes": [
    {"name": "<название блюда или продукта>", "calories": <калории>},
    ...
  ],
  "description": "<краткое описание блюда и порции на русском языке>"
}

Если на фото нет еды, верни:
{"error": "На фотографии не обнаружена еда"}
"""

MAX_IMAGE_B64_LEN = 14_000_000  # ~10 MB оригинала

LOOKUP_PROMPT = """Ты — эксперт-нутрициолог. Пользователь называет блюдо и его вес в граммах. Верни ТОЛЬКО валидный JSON с КБЖУ для указанного веса. Никаких пояснений вне JSON.

Формат:
{
  "total_calories": <число>,
  "protein": <граммы белка, число>,
  "fat": <граммы жиров, число>,
  "carbs": <граммы углеводов, число>,
  "note": "<короткое примечание о блюде, например: домашний борщ, средняя жирность>"
}

Если блюдо невозможно определить — верни:
{"error": "Не удалось определить блюдо"}
"""

@app.route('/lookup', methods=['POST'])
def lookup():
    data = request.get_json()
    name = (data.get('name') or '').strip()
    weight = data.get('weight')
    if not name or not weight:
        return jsonify({'error': 'Укажите название и вес'}), 400
    try:
        weight = float(weight)
        if weight <= 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({'error': 'Некорректный вес'}), 400

    device_id = get_device_id(data)
    if not device_id:
        return jsonify({'error': 'Некорректный device_id'}), 400

    allowed, used, limit = db.check_and_increment_usage(device_id)
    if not allowed:
        db.log_event('paywall_shown', device_id)
        return jsonify({'error': 'limit_exceeded', 'used': used, 'limit': limit}), 402

    try:
        message = client.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=256,
            system=LOOKUP_PROMPT,
            messages=[{
                'role': 'user',
                'content': f'Блюдо: {name}\nВес: {weight} г\n\nРассчитай КБЖУ.'
            }]
        )
        text = ''
        for block in message.content:
            if block.type == 'text':
                text = block.text
                break

        json_match = re.search(r'\{.*\}', text, re.DOTALL)
        if not json_match:
            return jsonify({'error': 'Не удалось разобрать ответ ИИ'}), 500

        result = json.loads(json_match.group())
        if 'error' in result:
            return jsonify({'error': result['error']}), 422

        return jsonify(result)

    except anthropic.APIConnectionError:
        return jsonify({'error': 'Ошибка подключения к API'}), 503
    except anthropic.RateLimitError:
        return jsonify({'error': 'Превышен лимит запросов'}), 429
    except json.JSONDecodeError:
        return jsonify({'error': 'Некорректный ответ ИИ'}), 500
    except Exception as e:
        return jsonify({'error': f'Ошибка: {str(e)}'}), 500


@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.get_json()
    if not data or 'image' not in data:
        return jsonify({'error': 'Изображение не предоставлено'}), 400

    image_b64 = data['image']
    mime_type = data.get('mime_type', 'image/jpeg')

    if len(image_b64) > MAX_IMAGE_B64_LEN:
        return jsonify({'error': 'Изображение слишком большое. Максимальный размер — 10 МБ.'}), 413

    allowed_mime = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
    if mime_type not in allowed_mime:
        mime_type = 'image/jpeg'

    device_id = get_device_id(data)
    if not device_id:
        return jsonify({'error': 'Некорректный device_id'}), 400

    allowed, used, limit = db.check_and_increment_usage(device_id)
    if not allowed:
        db.log_event('paywall_shown', device_id)
        return jsonify({'error': 'limit_exceeded', 'used': used, 'limit': limit}), 402

    try:
        message = client.messages.create(
            model='claude-opus-4-8',
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'image',
                            'source': {
                                'type': 'base64',
                                'media_type': mime_type,
                                'data': image_b64,
                            },
                        },
                        {
                            'type': 'text',
                            'text': 'Определи всю еду на этой фотографии и посчитай калории. Верни только JSON.'
                        }
                    ],
                }
            ],
        )

        text = ''
        for block in message.content:
            if block.type == 'text':
                text = block.text
                break

        json_match = re.search(r'\{.*\}', text, re.DOTALL)
        if not json_match:
            return jsonify({'error': 'Не удалось разобрать ответ ИИ'}), 500

        result = json.loads(json_match.group())

        if 'error' in result:
            return jsonify({'error': result['error']}), 422

        return jsonify(result)

    except anthropic.APIConnectionError:
        return jsonify({'error': 'Ошибка подключения к API. Проверьте интернет-соединение.'}), 503
    except anthropic.AuthenticationError:
        return jsonify({'error': 'Неверный API ключ. Проверьте переменную ANTHROPIC_API_KEY.'}), 401
    except anthropic.RateLimitError:
        return jsonify({'error': 'Превышен лимит запросов. Попробуйте через минуту.'}), 429
    except json.JSONDecodeError:
        return jsonify({'error': 'ИИ вернул некорректный JSON. Попробуйте ещё раз.'}), 500
    except Exception as e:
        return jsonify({'error': f'Внутренняя ошибка: {str(e)}'}), 500


@app.route('/promo', methods=['POST'])
def apply_promo():
    data = request.get_json() or {}
    device_id = get_device_id(data)
    code = (data.get('code') or '').strip()
    if not device_id or not code:
        return jsonify({'error': 'Укажите промокод'}), 400
    if not db.set_promo_code(device_id, code):
        return jsonify({'error': 'Промокод не найден'}), 404
    return jsonify({'ok': True})


@app.route('/save_email', methods=['POST'])
def save_email():
    data = request.get_json() or {}
    device_id = get_device_id(data)
    email = (data.get('email') or '').strip()
    if not device_id or not EMAIL_RE.match(email):
        return jsonify({'error': 'Укажите корректный email'}), 400
    db.set_device_email(device_id, email)
    return jsonify({'ok': True})


@app.route('/event', methods=['POST'])
def track_event():
    data = request.get_json() or {}
    device_id = get_device_id(data)
    event_type = (data.get('type') or '').strip()
    if not device_id or event_type not in {'buy_click', 'pwa_installed'}:
        return jsonify({'error': 'Некорректный запрос'}), 400
    db.log_event(event_type, device_id)
    return jsonify({'ok': True})


def _validate_analytics_event(raw):
    if not isinstance(raw, dict):
        return None
    name = (raw.get('name') or '').strip()
    if not EVENT_NAME_RE.match(name):
        return None

    target = raw.get('target')
    if target is not None:
        target = str(target).strip()[:ANALYTICS_MAX_TARGET_LEN] or None

    duration_ms = raw.get('duration_ms')
    if duration_ms is not None:
        try:
            duration_ms = int(duration_ms)
        except (ValueError, TypeError):
            duration_ms = None
        else:
            if duration_ms < 0 or duration_ms > ANALYTICS_MAX_DURATION_MS:
                duration_ms = None

    url = raw.get('url')
    if url is not None:
        url = str(url).strip()[:ANALYTICS_MAX_URL_LEN] or None

    meta = raw.get('meta')
    if meta is not None:
        if not isinstance(meta, (dict, list, str, int, float, bool)):
            meta = None
        elif len(json.dumps(meta)) > ANALYTICS_MAX_META_JSON_LEN:
            meta = None

    return {'name': name, 'target': target, 'duration_ms': duration_ms, 'meta': meta, 'url': url}


@app.route('/track', methods=['POST'])
def track_analytics():
    # force=True: sendBeacon (used on page-unload flushes) sends the JSON payload as a
    # text/plain Blob to dodge CORS preflight from the landing's separate origin, so the
    # Content-Type header can't be trusted here.
    data = request.get_json(silent=True, force=True) or {}

    session_id = (data.get('session_id') or '').strip()
    if not SESSION_ID_RE.match(session_id):
        return jsonify({'error': 'Некорректный session_id'}), 400

    source = (data.get('source') or '').strip()
    if source not in ANALYTICS_SOURCES:
        return jsonify({'error': 'Некорректный source'}), 400

    device_id = (data.get('device_id') or '').strip() or None
    if device_id and not DEVICE_ID_RE.match(device_id):
        device_id = None

    raw_events = data.get('events')
    if not isinstance(raw_events, list) or not raw_events:
        return jsonify({'error': 'events обязателен'}), 400
    raw_events = raw_events[:ANALYTICS_MAX_EVENTS_PER_BATCH]

    events = [e for e in (_validate_analytics_event(r) for r in raw_events) if e]
    if not events:
        return jsonify({'error': 'Нет валидных событий'}), 400

    db.log_analytics_events(session_id, device_id, source, events)
    return jsonify({'ok': True, 'accepted': len(events)})


@app.route('/admin/analytics', methods=['GET'])
def admin_analytics():
    if not require_admin():
        return jsonify({'error': 'forbidden'}), 403
    return jsonify(db.analytics_summary())


@app.route('/admin/grant', methods=['POST'])
def admin_grant():
    if not require_admin():
        return jsonify({'error': 'forbidden'}), 403
    data = request.get_json() or {}
    device_id = (data.get('device_id') or '').strip()
    email = (data.get('email') or '').strip() or None
    try:
        days = int(data.get('days', 30))
    except (ValueError, TypeError):
        return jsonify({'error': 'Некорректное число дней'}), 400
    if not device_id:
        return jsonify({'error': 'device_id обязателен'}), 400
    try:
        db.grant_pro(device_id, email, days)
    except RuntimeError:
        return jsonify({'error': 'Лимит платежей до регистрации самозанятости достигнут'}), 423
    db.log_event('payment_granted', device_id)
    return jsonify({'ok': True})


@app.route('/payment_status', methods=['GET'])
def payment_status():
    granted = db.count_payments_granted()
    return jsonify({
        'accepting': granted < db.MAX_PAYMENTS_BEFORE_REGISTRATION,
        'granted': granted,
        'limit': db.MAX_PAYMENTS_BEFORE_REGISTRATION,
        'funnel': db.funnel_counts(),
        'funnel_by_channel': db.funnel_counts_by_channel(),
        'telegram_username': SUPPORT_TELEGRAM_USERNAME,
    })


@app.route('/payment_info', methods=['GET'])
def payment_info():
    return jsonify({'card_number': PAYMENT_CARD_NUMBER})


@app.route('/admin/recover', methods=['POST'])
def admin_recover():
    if not require_admin():
        return jsonify({'error': 'forbidden'}), 403
    data = request.get_json() or {}
    email = (data.get('email') or '').strip()
    new_device_id = (data.get('device_id') or '').strip()
    if not email or not new_device_id:
        return jsonify({'error': 'email и device_id обязательны'}), 400
    if not db.recover_pro(email, new_device_id):
        return jsonify({'error': 'Активная подписка для этого email не найдена'}), 404
    db.log_event('access_recovered', new_device_id)
    return jsonify({'ok': True})


if __name__ == '__main__':
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        print('ОШИБКА: Переменная окружения ANTHROPIC_API_KEY не установлена!')
        print('Создайте файл .env с содержимым: ANTHROPIC_API_KEY=ваш-ключ')
        exit(1)
    print('КалориСкан запущен на http://localhost:5000')
    port = int(os.environ.get('PORT', 5000))
    app.run(debug=False, host='0.0.0.0', port=port)
