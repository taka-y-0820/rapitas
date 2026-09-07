/**
 * Agent Test Router
 *
 * Handles legacy connection test endpoint (POST /agents/:id/test) and the newer
 * POST /agents/:id/test-connection. Each agent type has a different testing strategy
 * (CLI --version check vs HTTP API ping).
 * Not responsible for agent config CRUD or model discovery.
 */

import { Elysia, t } from 'elysia';
import { prisma } from '../../../config';
import { resolveStoredSecret } from '../../../utils/common/secret-store';
import { logAgentConfigChange } from '../../../utils/agent/agent-audit-log';

/**
 * Spawns a CLI binary with --version and resolves with success/message.
 *
 * @param cliPath - Path or command name for the CLI binary / CLIバイナリのパスまたはコマンド名
 * @param label - Human-readable CLI name for error messages / エラーメッセージ用の表示名
 * @returns Success flag and descriptive message / 成功フラグと説明メッセージ
 */
async function testCliAvailability(
  cliPath: string,
  label: string,
): Promise<{ success: boolean; message: string }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    // NOTE: shell:false — args are already an array; a shell isn't needed to
    // invoke a binary/cmd-shim by name (Node resolves it via PATHEXT on
    // Windows), and not using one closes off shell metacharacter injection.
    const proc = spawn(cliPath, ['--version'], { shell: false });
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ success: false, message: `${label} timeout` });
    }, 10000);

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true, message: `${label} available: ${stdout.trim()}` });
      } else {
        resolve({ success: false, message: stderr || `Exit code: ${code}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, message: `${label} not found: ${err.message}` });
    });
  });
}

export const agentTestRouter = new Elysia()

  // Legacy connection test endpoint — tests the agent by type
  .post(
    '/agents/:id/test',
    async (context) => {
      const { set } = context;
      const { id } = context.params as { id: string };
      const agent = await prisma.aIAgentConfig.findUnique({
        where: { id: parseInt(id) },
      });

      if (!agent) {
        set.status = 404;
        return { success: false, message: 'Agent not found' };
      }

      try {
        switch (agent.agentType) {
          case 'claude-code': {
            const claudePath = process.env.CLAUDE_CODE_PATH || 'claude';
            return await testCliAvailability(claudePath, 'Claude CLI');
          }

          case 'anthropic-api': {
            if (!agent.apiKeyEncrypted) {
              return { success: false, message: 'API key is not configured' };
            }
            const apiKey = resolveStoredSecret(agent.apiKeyEncrypted);
            if (!apiKey) return { success: false, message: 'API key is not available' };
            const response = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: agent.modelId || 'claude-sonnet-4-20250514',
                max_tokens: 10,
                messages: [{ role: 'user', content: 'Hi' }],
              }),
            });
            if (response.ok) {
              return { success: true, message: 'Anthropic API connection successful' };
            }
            const errorBody = await response.json().catch(() => ({}));
            const errorMessage =
              errorBody && typeof errorBody === 'object' && 'error' in errorBody
                ? (errorBody as { error?: { message?: string } }).error?.message
                : undefined;
            return {
              success: false,
              message: `Anthropic API error: ${errorMessage || response.statusText}`,
            };
          }

          case 'openai': {
            if (!agent.apiKeyEncrypted) {
              return { success: false, message: 'API key is not configured' };
            }
            const apiKey = resolveStoredSecret(agent.apiKeyEncrypted);
            if (!apiKey) return { success: false, message: 'API key is not available' };
            const endpoint = agent.endpoint || 'https://api.openai.com/v1';
            const response = await fetch(`${endpoint}/models`, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (response.ok) {
              return { success: true, message: 'OpenAI API接続成功' };
            }
            const errorBody = await response.json().catch(() => ({}));
            const errorMessage =
              errorBody && typeof errorBody === 'object' && 'error' in errorBody
                ? (errorBody as { error?: { message?: string } }).error?.message
                : undefined;
            return {
              success: false,
              message: `OpenAI API error: ${errorMessage || response.statusText}`,
            };
          }

          case 'azure-openai': {
            if (!agent.apiKeyEncrypted || !agent.endpoint) {
              return {
                success: false,
                message: 'APIキーまたはエンドポイントが設定されていません',
              };
            }
            const apiKey = resolveStoredSecret(agent.apiKeyEncrypted);
            if (!apiKey) return { success: false, message: 'API key is not available' };
            const response = await fetch(`${agent.endpoint}?api-version=2024-02-15-preview`, {
              headers: { 'api-key': apiKey },
            });
            if (response.ok || response.status === 404) {
              return { success: true, message: 'Azure OpenAI API接続成功' };
            }
            return { success: false, message: `Azure OpenAI error: ${response.statusText}` };
          }

          case 'gemini': {
            if (!agent.apiKeyEncrypted) {
              // Gemini CLI can be verified without an API key
              const geminiPath = process.env.GEMINI_CLI_PATH || 'gemini';
              return await testCliAvailability(geminiPath, 'Gemini CLI');
            }
            const apiKey = resolveStoredSecret(agent.apiKeyEncrypted);
            if (!apiKey) return { success: false, message: 'API key is not available' };
            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
            );
            if (response.ok) {
              return { success: true, message: 'Gemini API接続成功' };
            }
            const errorBody = await response.json().catch(() => ({}));
            const errorMessage =
              errorBody && typeof errorBody === 'object' && 'error' in errorBody
                ? (errorBody as { error?: { message?: string } }).error?.message
                : undefined;
            return {
              success: false,
              message: `Gemini API error: ${errorMessage || response.statusText}`,
            };
          }

          case 'codex': {
            const codexPath = process.env.CODEX_CLI_PATH || 'codex';
            return await testCliAvailability(codexPath, 'Codex CLI');
          }

          default:
            return { success: false, message: `Unknown agent type: ${agent.agentType}` };
        }
      } catch (error) {
        await logAgentConfigChange({
          agentConfigId: parseInt(id),
          action: 'test_connection',
          changeDetails: {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
        return {
          success: false,
          message: `Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )

  // Newer connection test endpoint
  .post('/agents/:id/test-connection', async (context) => {
    const { id } = context.params as { id: string };
    const agent = await prisma.aIAgentConfig.findUnique({
      where: { id: parseInt(id) },
    });

    if (!agent) {
      context.set.status = 404;
      return { success: false, error: 'Agent not found' };
    }

    try {
      if (agent.agentType === 'claude-code') {
        const claudePath = process.env.CLAUDE_CODE_PATH || 'claude';
        const { spawn } = await import('child_process');

        const testResult = await new Promise<{
          success: boolean;
          output?: string;
          error?: string;
        }>((resolve) => {
          // NOTE: shell:false — see testCliAvailability() above for rationale.
          const proc = spawn(claudePath, ['--version'], { shell: false });
          let stdout = '';
          let stderr = '';

          const timeout = setTimeout(() => {
            proc.kill();
            resolve({ success: false, error: 'Timeout (10s)' });
          }, 10000);

          proc.stdout?.on('data', (data) => {
            stdout += data.toString();
          });
          proc.stderr?.on('data', (data) => {
            stderr += data.toString();
          });

          proc.on('close', (code) => {
            clearTimeout(timeout);
            resolve({
              success: code === 0,
              output: stdout.trim(),
              error: stderr.trim() || (code !== 0 ? `Exit code: ${code}` : undefined),
            });
          });

          proc.on('error', (err) => {
            clearTimeout(timeout);
            resolve({ success: false, error: err.message });
          });
        });

        return {
          success: testResult.success,
          agentType: agent.agentType,
          message: testResult.success
            ? `Claude Code CLI接続成功: ${testResult.output}`
            : `Claude Code CLI接続失敗: ${testResult.error}`,
          details: testResult,
        };
      }

      if (!agent.apiKeyEncrypted) {
        return {
          success: false,
          agentType: agent.agentType,
          message: 'APIキーが設定されていません',
        };
      }

      // An unimplemented probe provides no evidence of a successful connection.
      return {
        success: false,
        agentType: agent.agentType,
        message: `${agent.agentType}の接続テストはまだ実装されていません`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        agentType: agent.agentType,
        error: errorMsg,
        message: `接続テストに失敗しました: ${errorMsg}`,
      };
    }
  });
