// F-14：オフラインからの復帰検知（OS の報告・オフライン中の疎通確認）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNetworkWatch } from '../src/main/networkWatch.js';

const INTERVAL = 30 * 1000;

/** 状態を書き換えられる依存一式 */
function setup({ osOnline = true, offline = false, probeOk = false } = {}) {
  const s = { osOnline, offline, probeOk };
  const probe = vi.fn(async () => s.probeOk);
  const onRecover = vi.fn();
  const watch = createNetworkWatch({
    isOsOnline: () => s.osOnline,
    isOffline: () => s.offline,
    probe,
    onRecover,
    intervalMs: INTERVAL,
    log: { info() {} },
  });
  return { s, probe, onRecover, watch };
}

const tick = () => vi.advanceTimersByTimeAsync(INTERVAL);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('networkWatch / OS の報告', () => {
  it('OS が切断→接続に変わったら再試行する（接続のままなら何もしない）', async () => {
    const { s, onRecover, watch } = setup({ osOnline: false });
    watch.start();
    await tick();
    expect(onRecover).not.toHaveBeenCalled();
    s.osOnline = true;
    await tick();
    expect(onRecover).toHaveBeenCalledTimes(1);
    await tick();
    expect(onRecover).toHaveBeenCalledTimes(1);
  });
});

describe('networkWatch / オフライン中の疎通確認（net.isOnline() が true のまま変わらない環境）', () => {
  it('オフラインでなければ疎通確認しない', async () => {
    const { probe, onRecover, watch } = setup({ offline: false, probeOk: true });
    watch.start();
    await tick();
    await tick();
    expect(probe).not.toHaveBeenCalled();
    expect(onRecover).not.toHaveBeenCalled();
  });

  it('つながらない間は再試行せず、つながったら再試行する', async () => {
    const { s, probe, onRecover, watch } = setup({ offline: true, probeOk: false });
    watch.start();
    await tick();
    await tick();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onRecover).not.toHaveBeenCalled();
    s.probeOk = true;
    await tick();
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('オフラインのまま疎通確認が成功し続けても、再試行は1回だけ（API を30秒ごとに叩かない）', async () => {
    const { onRecover, watch } = setup({ offline: true, probeOk: true });
    watch.start();
    await tick();
    await tick();
    await tick();
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('再びつながらなくなってから戻ったら、もう一度再試行する', async () => {
    const { s, onRecover, watch } = setup({ offline: true, probeOk: true });
    watch.start();
    await tick();
    s.probeOk = false;
    await tick();
    s.probeOk = true;
    await tick();
    expect(onRecover).toHaveBeenCalledTimes(2);
  });

  it('オフラインを抜けて再びオフラインになったら、最初の疎通確認の成功で再試行する', async () => {
    const { s, onRecover, watch } = setup({ offline: true, probeOk: true });
    watch.start();
    await tick();
    s.offline = false;
    await tick();
    s.offline = true;
    await tick();
    expect(onRecover).toHaveBeenCalledTimes(2);
  });

  it('OS が切断を報告している間は疎通確認しない', async () => {
    const { probe, watch } = setup({ osOnline: false, offline: true, probeOk: true });
    watch.start();
    await tick();
    expect(probe).not.toHaveBeenCalled();
  });

  it('probe が reject しても落ちず、失敗として扱う', async () => {
    const { s, probe, onRecover, watch } = setup({ offline: true });
    probe.mockRejectedValueOnce(new Error('boom'));
    watch.start();
    await tick();
    expect(onRecover).not.toHaveBeenCalled();
    s.probeOk = true;
    await tick();
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('stop 後は何もしない', async () => {
    const { probe, onRecover, watch } = setup({ offline: true, probeOk: true });
    watch.start();
    watch.stop();
    await tick();
    expect(probe).not.toHaveBeenCalled();
    expect(onRecover).not.toHaveBeenCalled();
  });
});
