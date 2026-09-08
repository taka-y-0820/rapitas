import { describe, expect, test } from 'bun:test';
import { buildCodexArgs } from './process-runner-args';

describe('Codex noninteractive options', () => {
  test('passes explicit approval before exec without conflicting full-auto', () => {
    const { args } = buildCodexArgs({ approvalPolicy: 'never' }, 'C:/work', 'probe', '[test]');
    expect(args.slice(0, 3)).toEqual(['--ask-for-approval', 'never', 'exec']);
    expect(args).not.toContain('--full-auto');
    expect(args).toContain('workspace-write');
  });

  test('research forces never and captures its final artifact even with yolo configured', () => {
    const { args } = buildCodexArgs(
      {
        investigationMode: true,
        yolo: true,
        approvalPolicy: 'on-request',
        outputLastMessageFile: 'C:/out/plan.md',
      },
      'C:/work',
      'probe',
      '[test]',
    );
    expect(args.slice(0, 3)).toEqual(['--ask-for-approval', 'never', 'exec']);
    expect(args).toContain('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args[args.indexOf('--output-last-message') + 1]).toBe('C:/out/plan.md');
  });
});
