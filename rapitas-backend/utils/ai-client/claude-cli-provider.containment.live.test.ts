/** Real provider + OS launch/stop, with a deterministic disposable CLI rather than paid AI. */
import { expect, test, mock } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { observeProcess } from './aux-cli-ownership';

test.skipIf(
  process.platform !== 'win32' &&
    (process.platform !== 'linux' || !process.env.RAPITAS_AUX_CGROUP_ROOT),
)(
  'provider contains success, timeout, stream timeout and consumer cancellation',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rapitas-provider-containment-'));
    const priorData = process.env.RAPITAS_DATA_DIR;
    const priorTimeout = process.env.RAPITAS_AUX_AI_CLI_TIMEOUT_MS;
    const priorPids = process.env.RAPITAS_AUX_TEST_PIDS;
    process.env.RAPITAS_DATA_DIR = directory;
    process.env.RAPITAS_AUX_AI_CLI_TIMEOUT_MS = '5000';
    process.env.RAPITAS_AUX_TEST_PIDS = join(directory, 'pids.json');
    const cli = join(directory, process.platform === 'win32' ? 'fixture.cmd' : 'fixture.sh');
    await writeFile(
      cli,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${join(directory, 'fixture.cjs')}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${join(directory, 'fixture.cjs')}" "$@"\n`,
    );
    if (process.platform === 'linux') await chmod(cli, 0o700);
    await writeFile(
      join(directory, 'fixture.cjs'),
      `
const {spawn}=require('node:child_process');
const fs=require('node:fs');
let prompt=''; process.stdin.setEncoding('utf8');
process.stdin.on('data',s=>prompt+=s);
process.stdin.on('end',()=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:process.platform==='linux'});
 fs.writeFileSync(process.env.RAPITAS_AUX_TEST_PIDS,JSON.stringify({root:process.pid,child:child.pid}));
 if(process.argv.includes('stream-json')) console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ready'}]}}));
 if(prompt.includes('hang')) { setInterval(()=>{},1000); return; }
 console.log(JSON.stringify({result:'ok',usage:{input_tokens:1,output_tokens:1}})); process.exit(0);
});
`,
    );
    mock.module('../common/cli-path-resolver', () => ({ getClaudePathAsync: async () => cli }));
    try {
      const { callClaudeCli, callClaudeCliStream, isClaudeCliAvailable } =
        await import('./claude-cli-provider');
      const checkEmpty = async () => {
        const pids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8'));
        expect(await observeProcess(pids.root)).toEqual({ kind: 'absent' });
        expect(await observeProcess(pids.child)).toEqual({ kind: 'absent' });
        expect(
          JSON.parse(await readFile(join(directory, 'aux-cli-ownership.json'), 'utf8')).records,
        ).toEqual([]);
      };
      expect(await isClaudeCliAvailable()).toBe(true);
      await checkEmpty();
      await expect(
        callClaudeCli(undefined, [{ role: 'user', content: 'normal' }], undefined, 10),
      ).resolves.toMatchObject({ content: 'ok' });
      await checkEmpty();
      await expect(
        callClaudeCli(undefined, [{ role: 'user', content: 'hang' }], undefined, 10),
      ).rejects.toThrow('timed out');
      await checkEmpty();
      const timed = await callClaudeCliStream(
        undefined,
        [{ role: 'user', content: 'hang' }],
        undefined,
        10,
      );
      const timedReader = timed.getReader();
      let output = '';
      for (;;) {
        const part = await timedReader.read();
        if (part.done) break;
        output += new TextDecoder().decode(part.value);
      }
      expect(output).toContain('timed out');
      expect(output).not.toContain('[DONE]');
      await checkEmpty();
      const canceled = await callClaudeCliStream(
        undefined,
        [{ role: 'user', content: 'hang' }],
        undefined,
        10,
      );
      const reader = canceled.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
      await reader.cancel();
      await checkEmpty();
    } finally {
      for (const [key, value] of Object.entries({
        RAPITAS_DATA_DIR: priorData,
        RAPITAS_AUX_AI_CLI_TIMEOUT_MS: priorTimeout,
        RAPITAS_AUX_TEST_PIDS: priorPids,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const cleanup = resolve(directory);
      if (
        dirname(cleanup) !== resolve(tmpdir()) ||
        !basename(cleanup).startsWith('rapitas-provider-containment-')
      )
        throw new Error('Unsafe fixture cleanup');
      // Preserve ownership evidence on failure; never erase a hold while its process might remain.
      const registry = JSON.parse(
        await readFile(join(directory, 'aux-cli-ownership.json'), 'utf8').catch(
          () => '{"records":[{}]}',
        ),
      );
      if (registry.records.length === 0) await rm(cleanup, { recursive: true, force: true });
    }
  },
  60000,
);
