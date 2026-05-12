import os
import fitz  # PyMuPDF
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

API_KEY = os.environ.get('EXTRACT_API_KEY', '')

@app.route('/extract', methods=['POST'])
def extract():
    # Simple API key check
    if API_KEY and request.headers.get('X-API-Key') != API_KEY:
        return jsonify({'error': 'Unauthorized'}), 401

    body = request.get_json(force=True)
    url  = body.get('url')
    if not url:
        return jsonify({'error': 'Missing url'}), 400

    # Download PDF from the signed Supabase Storage URL
    r = requests.get(url, timeout=30)
    if not r.ok:
        return jsonify({'error': f'Download failed: {r.status_code}'}), 400

    # Extract text per page with PyMuPDF
    doc    = fitz.open(stream=r.content, filetype='pdf')
    chunks = []
    for i, page in enumerate(doc, start=1):
        text = page.get_text().strip()
        chunks.append({'page_num': i, 'content': text or ''})

    return jsonify({'chunks': chunks, 'total_pages': len(chunks)})

@app.route('/health')
def health():
    return 'ok'

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
