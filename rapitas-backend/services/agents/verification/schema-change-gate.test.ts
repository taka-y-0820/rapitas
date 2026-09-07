/**
 * schema-change-gate テスト
 *
 * 非該当/未計画NG/計画済OK/生成物パス除外/パス区切り正規化の5分岐を検証する。
 */
import { describe, it, expect } from 'bun:test';
import { schemaChangeGateCheck } from './schema-change-gate';

describe('schemaChangeGateCheck', () => {
  it('prisma/schema/ 配下の変更が無ければ null を返す', () => {
    expect(schemaChangeGateCheck(['src/foo.ts', 'src/bar.test.ts'], null)).toBeNull();
  });

  it('未計画のスキーマ変更は ok:false, errorCount:1 を返す', () => {
    const result = schemaChangeGateCheck(
      ['rapitas-backend/prisma/schema/pause.prisma'],
      ['src/foo.ts'],
    );
    expect(result?.ok).toBe(false);
    expect(result?.errorCount).toBe(1);
    expect(result?.name).toBe('schema-change');
    expect(result?.details).toContain('rapitas-backend/prisma/schema/pause.prisma');
  });

  it('plan.mdに明記されたスキーマ変更は ok:true を返す', () => {
    const result = schemaChangeGateCheck(
      ['rapitas-backend/prisma/schema/pause.prisma'],
      ['rapitas-backend/prisma/schema/pause.prisma'],
    );
    expect(result?.ok).toBe(true);
    expect(result?.errorCount).toBe(0);
  });

  it('生成物パス prisma/schema.desktop/ は非該当（null）', () => {
    expect(
      schemaChangeGateCheck(['rapitas-backend/prisma/schema.desktop/pause.prisma'], null),
    ).toBeNull();
  });

  it('Windowsパス区切り(\\\\)混入時も正規化して判定できる', () => {
    const result = schemaChangeGateCheck(['rapitas-backend\\prisma\\schema\\pause.prisma'], null);
    expect(result?.ok).toBe(false);
    expect(result?.errorCount).toBe(1);
  });

  it('planFilesがnull（軽量モード）の場合は無条件で未計画扱い', () => {
    const result = schemaChangeGateCheck(['rapitas-backend/prisma/schema/pause.prisma'], null);
    expect(result?.ok).toBe(false);
  });

  it('計画済み1件・未計画1件が混在する場合、未計画分のみerrorCountに計上する', () => {
    const result = schemaChangeGateCheck(
      ['rapitas-backend/prisma/schema/pause.prisma', 'rapitas-backend/prisma/schema/agents.prisma'],
      ['rapitas-backend/prisma/schema/pause.prisma'],
    );
    expect(result?.ok).toBe(false);
    expect(result?.errorCount).toBe(1);
    expect(result?.details).toContain('agents.prisma');
    expect(result?.details).not.toContain('pause.prisma');
  });
});
