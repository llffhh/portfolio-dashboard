import { describe, it, expect } from 'vitest';
import {
  saveScenario, loadScenarios, syncLocalToSheet, markPendingUpload, MIGRATED_KEY, LocalScenarioStore
} from '../src/sellplanner-ui.js';

// SP-21: moving plans saved in this browser up to the Sheet, without losing
// any and without resurrecting ones deleted on another device.
function fakeStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
}

function fakeRemote(initial = [], { reject = [], down = false } = {}) {
  const items = [...initial];
  return {
    saved: [],
    async list() {
      if (down) throw new Error('E_SCENARIO_SYNC');
      return items.map((s) => ({ ...s }));
    },
    async save(s) {
      if (down) throw new Error('E_SCENARIO_SYNC');
      if (reject.includes(s.id)) throw new Error('E_SCENARIO_REJECTED');
      this.saved.push(s.id);
      items.push(s);
    },
    async remove() {}
  };
}

const sc = (id, name = id) => ({
  id, name, savedAt: '2026-09-10T00:00:00.000Z', strategyId: 'custom',
  locked: [], rows: [{ ticker: '甲', sellShares: 1 }], note: ''
});

describe("SP-21 — syncing this browser's plans to the Sheet", () => {
  it('first live load uploads local-only plans, skips ones already in the Sheet, keeps local copies', async () => {
    const st = fakeStorage();
    saveScenario(sc('a'), st);
    saveScenario(sc('b'), st);
    const remote = fakeRemote([sc('b')]);
    expect(await syncLocalToSheet(remote, st)).toEqual({ uploaded: 1, rejected: [] });
    expect(remote.saved).toEqual(['a']);
    expect(loadScenarios(st).map((s) => s.id)).toEqual(['a', 'b']);
    expect(st.getItem(MIGRATED_KEY)).not.toBeNull();
  });

  it('never resurrects a plan deleted on another device once the first sync is done', async () => {
    const st = fakeStorage();
    saveScenario(sc('a'), st);
    await syncLocalToSheet(fakeRemote(), st);
    const remote = fakeRemote([]); // 'a' has since been deleted elsewhere
    expect(await syncLocalToSheet(remote, st)).toEqual({ uploaded: 0, rejected: [] });
    expect(remote.saved).toEqual([]);
  });

  it('uploads a plan saved locally while the Sheet was down, on the next live load, exactly once', async () => {
    const st = fakeStorage();
    await syncLocalToSheet(fakeRemote(), st);
    saveScenario(sc('offline1'), st);
    markPendingUpload('offline1', st);
    const remote = fakeRemote();
    expect(await syncLocalToSheet(remote, st)).toEqual({ uploaded: 1, rejected: [] });
    expect(remote.saved).toEqual(['offline1']);
    expect(await syncLocalToSheet(fakeRemote(), st)).toEqual({ uploaded: 0, rejected: [] });
  });

  it('a plan the Sheet rejects is reported, does not block the others, and stays in this browser', async () => {
    const st = fakeStorage();
    saveScenario(sc('bad', 'Rejected one'), st);
    saveScenario(sc('good'), st);
    const remote = fakeRemote([], { reject: ['bad'] });
    expect(await syncLocalToSheet(remote, st)).toEqual({ uploaded: 1, rejected: ['Rejected one'] });
    expect(remote.saved).toEqual(['good']);
    expect(loadScenarios(st).map((s) => s.id)).toContain('bad');
  });

  it('if the Sheet is unreachable nothing is marked done, so the next load retries', async () => {
    const st = fakeStorage();
    saveScenario(sc('a'), st);
    await expect(syncLocalToSheet(fakeRemote([], { down: true }), st)).rejects.toThrow('E_SCENARIO_SYNC');
    expect(st.getItem(MIGRATED_KEY)).toBeNull();
    expect((await syncLocalToSheet(fakeRemote(), st)).uploaded).toBe(1);
  });

  it('LocalScenarioStore gives localStorage the same async interface as the Sheet store', async () => {
    const store = new LocalScenarioStore(fakeStorage());
    await store.save(sc('a'));
    expect((await store.list()).map((s) => s.id)).toEqual(['a']);
    await store.remove('a');
    expect(await store.list()).toEqual([]);
  });
});
