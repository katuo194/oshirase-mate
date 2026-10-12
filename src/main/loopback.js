// OAuth のリダイレクトを受けるローカルサーバー（2.3 Loopback）。Electron 非依存。
// - 127.0.0.1 のみに bind し、ポートは OS に任せる（Google のデスクトップアプリ型は任意ポートを許可）
// - GET /callback だけを処理。state が不正なリクエストは無視してフローを継続する（偽造リクエストで潰されないため）
// - 有効なコールバックを1回受けたら閉じる。タイムアウト・キャンセルにも対応

import http from 'node:http';
import { parseCallback } from './authCore.js';

const CALLBACK_PATH = '/callback';

const PAGES = {
  ok: { status: 200, title: '連携が完了しました', body: 'このタブは閉じて、アプリに戻ってください。' },
  denied: { status: 200, title: '連携をキャンセルしました', body: 'このタブは閉じて構いません。' },
  error: { status: 400, title: '連携に失敗しました', body: 'このタブは閉じて、アプリからやり直してください。' },
  invalid: { status: 400, title: '無効なリクエストです', body: '' },
};

const page = ({ title, body }) =>
  `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:'Yu Gothic UI',sans-serif;text-align:center;margin-top:20vh"><h1>${title}</h1><p>${body}</p></body></html>`;

/**
 * @param {object} opts
 * @param {string} opts.expectedState
 * @param {number} [opts.timeoutMs] 既定 5 分
 * @returns {Promise<{ redirectUri: string, result: Promise<{ code: string } | { error: 'denied' | 'error' }>, close: () => void }>}
 *   result は timeout / cancelled で reject する（Error.code = 'timeout' | 'cancelled'）
 */
export async function startLoopbackServer({ expectedState, timeoutMs = 5 * 60 * 1000 }) {
  let settle;
  let fail;
  const result = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let done = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (p) => {
      res.writeHead(p.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // URL に認可コードが含まれるため、ページ内から外へ Referer を漏らさない
        'Referrer-Policy': 'no-referrer',
      });
      res.end(page(p));
    };

    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const parsed = parseCallback(url.searchParams, expectedState);
    if (!parsed.ok && parsed.reason === 'invalid') {
      send(PAGES.invalid);
      return;
    }
    if (done) {
      send(PAGES.invalid);
      return;
    }
    done = true;
    if (parsed.ok) {
      send(PAGES.ok);
      settle({ code: parsed.code });
    } else {
      send(parsed.reason === 'denied' ? PAGES.denied : PAGES.error);
      settle({ error: parsed.reason });
    }
    // レスポンスを返し終えてから閉じる
    res.on('finish', close);
  });

  let timer = null;
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    if (!done) {
      done = true;
      fail(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  timer = setTimeout(() => {
    if (done) return;
    done = true;
    server.close();
    server.closeAllConnections?.();
    fail(Object.assign(new Error('timeout'), { code: 'timeout' }));
  }, timeoutMs);

  const { port } = server.address();
  return { redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, result, close };
}
