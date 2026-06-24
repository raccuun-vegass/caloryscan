import os
import json
import base64
import re
import anthropic
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

load_dotenv()

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

client = anthropic.Anthropic(api_key=os.environ.get('ANTHROPIC_API_KEY'))

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

    allowed = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
    if mime_type not in allowed:
        mime_type = 'image/jpeg'

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


if __name__ == '__main__':
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        print('ОШИБКА: Переменная окружения ANTHROPIC_API_KEY не установлена!')
        print('Создайте файл .env с содержимым: ANTHROPIC_API_KEY=ваш-ключ')
        exit(1)
    print('КалориСкан запущен на http://localhost:5000')
    port = int(os.environ.get('PORT', 5000))
    app.run(debug=False, host='0.0.0.0', port=port)
