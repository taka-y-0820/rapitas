/**
 * prompt-evolution-staged-trial テスト
 *
 * 限定試行のアーム割当を検証する。ブロックサイズ2の並べ替えブロック法で
 * バランスを保ちつつ順序がシード依存になること、カウンタが永続化され再起動後も
 * 継続すること、同一ロールに複数の staged 候補がある場合は古い候補から進める
 * こと、割当時点では injected=false であること。
 * Own file — mock.module is process-global.
 */
import { describe, it, test, expect, mock, beforeEach, afterEach } from 'bun:test';

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assignCandidateBudget } from './comparison/prompt-comparison-alpha-ledger';
import { readTrialManifest, reserveTrialSlot } from './comparison/prompt-comparison-trial-manifest';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '',
}));

interface EvoRow {
  id: number;
  basePromptKey: string;
  afterPrompt: string;
  evidenceJson: string | null;
  status: string;
}

let rows: EvoRow[] = [];
let findFirstArgs: unknown = null;

mock.module('../../config/database', () => ({
  ensureDatabaseConnection: mock(async () => {}),
  prisma: {
    promptEvolution: {
      findFirst: mock(
        (args: { where: { basePromptKey: string; status: string }; orderBy: { id: string } }) => {
          findFirstArgs = args;
          const matched = rows
            .filter(
              (r) => r.basePromptKey === args.where.basePromptKey && r.status === args.where.status,
            )
            .sort((a, b) => (args.orderBy.id === 'asc' ? a.id - b.id : b.id - a.id));
          return Promise.resolve(matched[0] ?? null);
        },
      ),
      update: mock((args: { where: { id: number }; data: Partial<EvoRow> }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return Promise.resolve(row);
      }),
    },
  },
}));

const { assignArm, getStagedRoleAddendumForTrial } =
  await import('./prompt-evolution-staged-trial');

const { initComparisonRecordForStaging, addendumVersionHash } =
  await import('./comparison/prompt-comparison-store');
let tmpDir: string;
let previousDataDir: string | undefined;

/** 決定論的にブロック順序が反転する2つのシードを実測で選ぶ。 */
function seedWhereCandidateIsFirst(): string {
  for (let i = 0; i < 1000; i++) {
    if (assignArm(`s${i}`, 0) === 'candidate') return `s${i}`;
  }
  throw new Error('no seed found');
}

function seedWhereCurrentIsFirst(): string {
  for (let i = 0; i < 1000; i++) {
    if (assignArm(`s${i}`, 0) === 'current') return `s${i}`;
  }
  throw new Error('no seed found');
}

function stagedRow(id: number, evidenceJson: string | null = '{}'): EvoRow {
  const row = {
    id,
    basePromptKey: 'workflow_role_implementer',
    afterPrompt: '- 提出前にlintを実行する',
    evidenceJson,
    status: 'staged',
  };
  assignCandidateBudget(id);
  initComparisonRecordForStaging({
    promptEvolutionId: id,
    role: 'implementer',
    createdAt: new Date(0).toISOString(),
  });
  let evidence: Record<string, unknown> = {};
  try {
    evidence = JSON.parse(evidenceJson ?? '{}');
  } catch {}
  for (let i = 0; i < Number(evidence.stagedSampleCount ?? 0); i++) {
    reserveTrialSlot(
      {
        promptEvolutionId: id,
        role: 'implementer',
        candidateVersion: addendumVersionHash(row.afterPrompt),
        controlVersion: null,
        seed: String(evidence.trialRandomSeed ?? 'seed'),
      },
      i + 1,
      () => true,
    );
  }
  return row;
}

function counterOf(id: number): unknown {
  return readTrialManifest(id)?.slots.length ?? 0;
}

beforeEach(() => {
  previousDataDir = process.env.RAPITAS_DATA_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-staged-manifest-'));
  process.env.RAPITAS_DATA_DIR = tmpDir;
  rows = [];
  findFirstArgs = null;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = previousDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getStagedRoleAddendumForTrial', () => {
  test('staged候補が無ければnull(承認済み経路には一切触れない)', async () => {
    rows = [{ ...stagedRow(1), status: 'approved' }];
    expect(await getStagedRoleAddendumForTrial('implementer', 10)).toBeNull();
    expect(findFirstArgs).toMatchObject({ where: { status: 'staged' } });
  });

  test('ブロックサイズ2で必ず各アーム1件ずつになる(バランスは保たれる)', async () => {
    rows = [stagedRow(1, JSON.stringify({ trialRandomSeed: seedWhereCandidateIsFirst() }))];
    const arms: string[] = [];
    for (let i = 0; i < 6; i++) {
      const trial = await getStagedRoleAddendumForTrial('implementer', 100 + i);
      arms.push(trial!.assignment.arm);
    }

    // 各ブロック(2件)に current と candidate が1件ずつ入る。
    for (let b = 0; b < 3; b++) {
      expect(new Set(arms.slice(b * 2, b * 2 + 2))).toEqual(new Set(['current', 'candidate']));
    }
    expect(arms.filter((a) => a === 'candidate')).toHaveLength(3);
    expect(counterOf(1)).toBe(6);
  });

  test('ブロック内の順序はシード依存で、単純な偶奇一致ではない', async () => {
    // 同じ位置(count=0)でもシードが違えばアームが変わる = 位置の関数ではない。
    const candidateFirst = seedWhereCandidateIsFirst();
    const currentFirst = seedWhereCurrentIsFirst();

    rows = [stagedRow(1, JSON.stringify({ trialRandomSeed: candidateFirst }))];
    const a = await getStagedRoleAddendumForTrial('implementer', 100);

    rows = [stagedRow(2, JSON.stringify({ trialRandomSeed: currentFirst }))];
    const b = await getStagedRoleAddendumForTrial('implementer', 100);

    expect(a?.assignment.arm).toBe('candidate');
    expect(b?.assignment.arm).toBe('current');
  });

  test('同じシードなら再起動後も同じ割当系列を再現する', async () => {
    const seed = seedWhereCandidateIsFirst();
    const first: string[] = [];
    rows = [stagedRow(1, JSON.stringify({ trialRandomSeed: seed }))];
    for (let i = 0; i < 6; i++) {
      first.push((await getStagedRoleAddendumForTrial('implementer', 100 + i))!.assignment.arm);
    }

    // 再起動を模して同じシードでカウンタ0からやり直す。
    const second: string[] = [];
    rows = [stagedRow(1, JSON.stringify({ trialRandomSeed: seed }))];
    for (let i = 0; i < 6; i++) {
      second.push((await getStagedRoleAddendumForTrial('implementer', 100 + i))!.assignment.arm);
    }

    expect(second).toEqual(first);
  });

  test('割当台帳は永続化され、再起動後も系列の続きから配分する', async () => {
    const seed = seedWhereCandidateIsFirst();
    // 3回分の割当済み状態から再開 = ブロック1(count=3)の続き。
    rows = [stagedRow(1, JSON.stringify({ stagedSampleCount: 3, trialRandomSeed: seed }))];

    const trial = await getStagedRoleAddendumForTrial('implementer', 200);

    expect(trial?.assignment.arm).toBe(assignArm(seed, 3));
    expect(counterOf(1)).toBe(4);
  });

  test('介入アームは追記文と版を返し、割当時点では injected=false のまま', async () => {
    rows = [stagedRow(1, JSON.stringify({ trialRandomSeed: seedWhereCandidateIsFirst() }))];

    const trial = await getStagedRoleAddendumForTrial('implementer', 300);

    expect(trial?.addendum).toBe('- 提出前にlintを実行する');
    expect(trial?.version).toBeString();
    // 実際に注入できたかは呼び出し側が確定させる（割当だけで介入済みとしない）。
    expect(trial?.assignment.injected).toBe(false);
    expect(trial?.assignment.injectedVersion).toBeNull();
  });

  test('対照アームは追記文も版も返さない', async () => {
    rows = [stagedRow(1, JSON.stringify({ trialRandomSeed: seedWhereCurrentIsFirst() }))];

    const trial = await getStagedRoleAddendumForTrial('implementer', 400);

    expect(trial?.assignment.arm).toBe('current');
    expect(trial?.addendum).toBeNull();
    expect(trial?.version).toBeNull();
  });

  test('既存の複数staged候補は古い順に進み、新着候補に追い越されない', async () => {
    const seed = seedWhereCandidateIsFirst();
    rows = [
      stagedRow(1, JSON.stringify({ stagedSampleCount: 1, trialRandomSeed: seed })),
      stagedRow(9, JSON.stringify({ stagedSampleCount: 1, trialRandomSeed: seed })),
    ];

    const trial = await getStagedRoleAddendumForTrial('implementer', 500);

    expect(trial?.assignment.promptEvolutionId).toBe(1);
    expect(counterOf(1)).toBe(2);
    expect(counterOf(9)).toBe(1);
    rows.push(stagedRow(10));
    expect(
      (await getStagedRoleAddendumForTrial('implementer', 501))?.assignment.promptEvolutionId,
    ).toBe(1);
    rows[0].status = 'rejected';
    expect(
      (await getStagedRoleAddendumForTrial('implementer', 502))?.assignment.promptEvolutionId,
    ).toBe(9);
  });

  test('追記文が空の候補は割当を作らない', async () => {
    rows = [{ ...stagedRow(1), afterPrompt: '   ' }];
    expect(await getStagedRoleAddendumForTrial('implementer', 600)).toBeNull();
  });
});

describe('assignArm', () => {
  it('keeps every block balanced regardless of the seed', () => {
    for (let i = 0; i < 50; i++) {
      const seed = `seed-${i}`;
      for (let block = 0; block < 5; block++) {
        const pair = [assignArm(seed, block * 2), assignArm(seed, block * 2 + 1)];
        expect(new Set(pair)).toEqual(new Set(['current', 'candidate']));
      }
    }
  });

  it('does not reduce to a fixed function of position', () => {
    // 位置0のアームがシードによって両方現れる = 偶奇固定ではない。
    const armsAtZero = new Set(Array.from({ length: 50 }, (_, i) => assignArm(`seed-${i}`, 0)));
    expect(armsAtZero.size).toBe(2);
  });

  it('is stable for the same (seed, count)', () => {
    expect(assignArm('abc', 7)).toBe(assignArm('abc', 7));
  });
});
