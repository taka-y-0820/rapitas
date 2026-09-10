import type { AgentConfigInput } from '../agent-factory';
import type { OrchestratorContext, ExecutionOptions } from './types';
import { createLogger } from '../../../config/logger';
const logger = createLogger('task-executor');

/** Result of resolving agent configuration */
interface ResolvedAgentConfig {
  agentConfig: AgentConfigInput;
  resolvedAgentConfigId: number | undefined;
}

/**
 * Resolve agent configuration from options or database defaults.
 */
export async function resolveAgentConfig(
  ctx: OrchestratorContext,
  options: ExecutionOptions,
): Promise<ResolvedAgentConfig> {
  let agentConfig: AgentConfigInput = {
    type: 'claude-code',
    name: 'Claude Code Agent',
    workingDirectory: options.workingDirectory,
    timeout: options.timeout,
    dangerouslySkipPermissions: true,
  };
  // Only a positive id can be a real AIAgentConfig FK. Synthetic/built-in ids
  // (e.g. -1) and 0 must NOT be persisted as the FK — they'd violate the
  // foreign key on agentExecution.create.
  let resolvedAgentConfigId =
    options.agentConfigId && options.agentConfigId > 0 ? options.agentConfigId : undefined;

  if (options.agentConfigId && options.agentConfigId > 0) {
    const dbConfig = await ctx.prisma.aIAgentConfig.findUnique({
      where: { id: options.agentConfigId },
    });
    if (dbConfig) {
      agentConfig = await ctx.buildAgentConfigFromDb(dbConfig, options);
      resolvedAgentConfigId = dbConfig.id;
    } else {
      // A since-deleted config id. Keep the built-in Claude Code agentConfig
      // above and NULL the FK so agentExecution.create() doesn't blow up.
      logger.warn(
        `[TaskExecutor] agentConfigId ${options.agentConfigId} not found — falling back to built-in Claude Code (null FK)`,
      );
      resolvedAgentConfigId = undefined;
    }
  } else {
    // No usable explicit id (unset, 0, or a synthetic/built-in negative id):
    // prefer the DB default agent, else the built-in Claude Code with null FK.
    const defaultDbConfig = await ctx.prisma.aIAgentConfig.findFirst({
      where: { isDefault: true, isActive: true },
    });
    if (defaultDbConfig) {
      agentConfig = await ctx.buildAgentConfigFromDb(defaultDbConfig, options);
      resolvedAgentConfigId = defaultDbConfig.id;
      logger.info(
        `[TaskExecutor] Using default agent from DB: ${defaultDbConfig.name} (type: ${defaultDbConfig.agentType})`,
      );
    } else {
      logger.info(`[TaskExecutor] No default agent in DB, falling back to built-in Claude Code`);
      resolvedAgentConfigId = undefined;
    }
  }

  if (options.modelIdOverride) {
    agentConfig = { ...agentConfig, modelId: options.modelIdOverride };
  }

  // Continue the caller-supplied CLI session instead of cold-starting. Only the
  // claude-code agent understands this id shape (codex/gemini keep their own),
  // and executeTask() retries once without it if the CLI rejects it.
  if (options.resumeSessionId && agentConfig.type === 'claude-code') {
    agentConfig = { ...agentConfig, resumeSessionId: options.resumeSessionId };
  }

  // Forward investigation-mode flags onto the agent config
  if (options.investigationMode || options.investigationOutputType) {
    agentConfig = {
      ...agentConfig,
      investigationMode: options.investigationMode ?? agentConfig.investigationMode,
      investigationOutputType:
        options.investigationOutputType ?? agentConfig.investigationOutputType,
      outputLastMessageFile: options.outputLastMessageFile ?? agentConfig.outputLastMessageFile,
    };
  }

  return { agentConfig, resolvedAgentConfigId };
}
