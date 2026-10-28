// TODO のお知らせ時刻のリール（時・分。Phase 16）。
// Chromium の <input type="time"> の選択リストは、ホイールを上に回したときと下に回したときで動く量が違い、
// 狙った値で止めにくかったため、自前のリールにした。ホイール 1 目盛り・矢印キー 1 回・上下の数字のクリックで、どちらの向きも 1 つずつ動く。
//
// 見た目はスマートフォンの時刻のリールと同じで、上に小さい値・下に大きい値を薄く並べる。
//   ホイールを下へ（手前へ）回す・↓キー・下の数字をクリック … 1 つ大きく（23 時の次は 0 時、59 分の次は 0 分）
//   ホイールを上へ（奥へ）回す・↑キー・上の数字をクリック   … 1 つ小さく
//   数字キー … 2 桁まで打って直接入れる（1 秒あくと打ち直し）
//
// 画面のスクリプトは classic script なので、globalThis.TimeReel に置く（テストは vm で読み込んで純粋関数を確かめる）。

(function () {
  /** 0〜max の範囲で回り込ませる（max の次は 0、0 の前は max）。 */
  function wrap(value, max) {
    const n = max + 1;
    return ((value % n) + n) % n;
  }

  /**
   * ホイールのイベントを「何目盛り動かすか」（-1・0・+1）に直す関数を作る。
   * マウスのホイールは 1 目盛りで 1 回イベントが来るが、量（deltaY）は向き・環境で違い（例：100 と 125）、
   * 量で割ると向きによって 1 目盛りで 2 つ動くことがある。そこで、1 回のイベントでは最大 1 つしか動かさない。
   * タッチパッドのように小さい量が続けて来るときは、threshold に達するまで貯めてから 1 つ動かす。
   * 向きが変わったとき・idleMs あいたときは貯めた量を捨てる。
   *
   * @param {{ threshold?: number, idleMs?: number, now?: () => number }} [opts]
   * @returns {(e: { deltaY: number, deltaMode?: number }) => -1 | 0 | 1}
   */
  function createWheelStepper({ threshold = 50, idleMs = 250, now = () => Date.now() } = {}) {
    let acc = 0;
    let last = -Infinity;
    return (e) => {
      const dy = Number(e?.deltaY) || 0;
      if (dy === 0) return 0;
      const t = now();
      if (t - last > idleMs || Math.sign(dy) !== Math.sign(acc)) acc = 0;
      last = t;
      // 行・ページ単位（deltaMode 1・2）はマウスの 1 目盛りなので、そのまま 1 つ
      if (e.deltaMode === 1 || e.deltaMode === 2) {
        acc = 0;
        return dy > 0 ? 1 : -1;
      }
      acc += dy;
      if (Math.abs(acc) < threshold) return 0;
      const step = acc > 0 ? 1 : -1;
      acc = 0;
      return step;
    };
  }

  /**
   * 数字キーで 2 桁まで打って値を入れる。打った数字が範囲を超えるなら、その 1 桁目から打ち直したことにする。
   * @param {string} buffer それまでに打った数字（1 秒あいたら空にする）
   * @param {string} digit 今回打った数字（'0'〜'9'）
   * @param {number} max
   * @returns {{ buffer: string, value: number }}
   */
  function typeDigit(buffer, digit, max) {
    const joined = (buffer + digit).slice(-2);
    if (Number(joined) <= max) return { buffer: joined.length >= 2 ? '' : joined, value: Number(joined) };
    return { buffer: digit, value: Math.min(Number(digit), max) };
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /**
   * リールを組み立てる。
   * @param {HTMLElement} root 中身を作る要素（role="spinbutton" と aria-label は HTML 側で付ける）
   * @param {{ max: number, onInput: (value: number) => void }} opts onInput は利用者が値を動かしたときだけ呼ぶ
   * @returns {{ get value(): number, set(value: number): void }}
   */
  function mount(root, { max, onInput }) {
    let value = 0;
    const prev = document.createElement('button');
    const current = document.createElement('span');
    const next = document.createElement('button');
    prev.type = 'button';
    next.type = 'button';
    prev.tabIndex = -1;
    next.tabIndex = -1;
    prev.className = 'reel-side';
    next.className = 'reel-side';
    current.className = 'reel-current';
    root.replaceChildren(prev, current, next);
    root.tabIndex = 0;
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', String(max));

    function draw() {
      prev.textContent = pad2(wrap(value - 1, max));
      current.textContent = pad2(value);
      next.textContent = pad2(wrap(value + 1, max));
      prev.setAttribute('aria-label', pad2(wrap(value - 1, max)));
      next.setAttribute('aria-label', pad2(wrap(value + 1, max)));
      root.setAttribute('aria-valuenow', String(value));
      root.setAttribute('aria-valuetext', pad2(value));
    }

    function change(nextValue) {
      const v = wrap(nextValue, max);
      if (v === value) return;
      value = v;
      draw();
      onInput(value);
    }

    const stepper = createWheelStepper();
    root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault(); // 設定画面ごとスクロールさせない
        const step = stepper(e);
        if (step !== 0) change(value + step);
      },
      { passive: false },
    );
    prev.addEventListener('click', () => {
      root.focus();
      change(value - 1);
    });
    next.addEventListener('click', () => {
      root.focus();
      change(value + 1);
    });

    let buffer = '';
    let bufferTimer = null;
    root.addEventListener('keydown', (e) => {
      const keys = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 };
      if (e.key in keys) {
        e.preventDefault();
        change(value + keys[e.key]);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        change(e.key === 'Home' ? 0 : max);
      } else if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        const r = typeDigit(buffer, e.key, max);
        buffer = r.buffer;
        clearTimeout(bufferTimer);
        bufferTimer = setTimeout(() => (buffer = ''), 1000);
        change(r.value);
      }
    });

    draw();
    return {
      get value() {
        return value;
      },
      /** 保存済みの値を映す（onInput は呼ばない） */
      set(v) {
        value = wrap(Number.isInteger(v) ? v : 0, max);
        draw();
      },
    };
  }

  globalThis.TimeReel = { wrap, createWheelStepper, typeDigit, mount };
})();
