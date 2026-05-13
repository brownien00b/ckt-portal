import io
import os

import pdfplumber
import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

API_KEY = os.environ.get('EXTRACT_API_KEY', '')


def table_to_text(table):
    rows = []
    for row in table:
        cells = [str(cell or '').strip() for cell in row]
        rows.append(' | '.join(cells))
    return '\n'.join(rows)


@app.route('/extract', methods=['POST'])
def extract():
    if API_KEY and request.headers.get('X-API-Key') != API_KEY:
        return jsonify({'error': 'Unauthorized'}), 401

    body = request.get_json(force=True)
    url  = body.get('url')
    if not url:
        return jsonify({'error': 'Missing url'}), 400

    r = requests.get(url, timeout=30)
    if not r.ok:
        return jsonify({'error': f'Download failed: {r.status_code}'}), 400

    chunks = []
    with pdfplumber.open(io.BytesIO(r.content)) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            parts = []

            # Tables as structured text — preserves spec rows that PyMuPDF scrambles
            for table in page.extract_tables():
                t = table_to_text(table)
                if t.strip():
                    parts.append(t)

            # Full page text (pdfplumber handles multi-column better than PyMuPDF)
            text = page.extract_text(x_tolerance=2, y_tolerance=3)
            if text and text.strip():
                parts.append(text.strip())

            chunks.append({'page_num': i, 'content': '\n\n'.join(parts)})

    return jsonify({'chunks': chunks, 'total_pages': len(chunks)})


@app.route('/health')
def health():
    return 'ok'


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
