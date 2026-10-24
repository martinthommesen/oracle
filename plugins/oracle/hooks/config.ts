// The oracle's settings: the /config rows (the manifest's userConfig), each
// overridden by an environment variable where one is set. The variables are how
// a cloud environment configures the oracle, since a cloud session reads no
// /config options from your machine.
//
// The engine fills in the manifest's defaults and keeps a picked field to its
// options; a variable gets no such check, so its effort is checked here.

import { parseExtraPrefixes } from './shell.ts'

/** The manifest's default model, for a field the user cleared. */
export const DEFAULT_MODEL = 'opus'

/** The effort levels, as the manifest's effort field offers them. */
export const EFFORTS = ['xhigh', 'max', 'high', 'medium', 'low', 'auto']

export type OracleConfig = {
  /** What the oracle runs on: an alias (opus, best, fable, sonnet, haiku), inherit, or a full model ID. */
  model: string
  /** Its effort level; undefined leaves the model's own default. */
  effort: string | undefined
  /** Command prefixes the user allowed beyond what Claude Code judges read-only. */
  extraCommands: string[][]
}

/** The environment variables that override the /config rows: ORACLE_MODEL, ORACLE_EFFORT, ORACLE_EXTRA_COMMANDS. */
export type OracleEnvironment = {
  model?: string | undefined
  effort?: string | undefined
  extraCommands?: string | undefined
}

// Model IDs and aliases as --model takes them: claude-opus-5-5, opus[1m],
// us.anthropic.claude-…, arn:aws:bedrock:…/…, a gateway's own name.
const MODEL_PATTERN = /^[A-Za-z0-9._:/@[\]-]{1,200}$/

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Reads the plugin's options and the variables that override them, keeping the
 * option (or the default model) with a warning where a value is unusable.
 */
export function readConfig(
  options: Readonly<Record<string, unknown>>,
  environment: OracleEnvironment = {},
): { config: OracleConfig; warnings: string[] } {
  const warnings: string[] = []

  let model = text(options.model) || DEFAULT_MODEL
  if (!MODEL_PATTERN.test(model)) {
    warnings.push(`"${model}" is not a model name; the oracle uses ${DEFAULT_MODEL}`)
    model = DEFAULT_MODEL
  }
  const modelVariable = text(environment.model)
  if (MODEL_PATTERN.test(modelVariable)) model = modelVariable
  else if (modelVariable !== '') warnings.push(`ORACLE_MODEL "${modelVariable}" is not a model name; the oracle uses ${model}`)

  let effort = text(options.effort)
  const effortVariable = text(environment.effort).toLowerCase()
  if (EFFORTS.includes(effortVariable)) effort = effortVariable
  else if (effortVariable !== '') warnings.push(`ORACLE_EFFORT "${effortVariable}" is not one of ${EFFORTS.join(', ')}; the oracle uses ${effort || 'auto'}`)

  // An empty variable clears the option's commands; one with no usable command keeps them.
  let extraCommands = parseExtraPrefixes(text(options.extra_commands))
  if (environment.extraCommands !== undefined) {
    const commandsVariable = text(environment.extraCommands)
    const parsed = parseExtraPrefixes(commandsVariable)
    if (commandsVariable === '' || parsed.length > 0) extraCommands = parsed
    else warnings.push(`ORACLE_EXTRA_COMMANDS "${commandsVariable}" names no usable command prefix; the oracle keeps the /config ones`)
  }

  return {
    config: {
      model,
      effort: effort === '' || effort === 'auto' ? undefined : effort,
      extraCommands,
    },
    warnings,
  }
}

/** How the configuration reads in a status line: `opus · xhigh`. */
export function describeConfig(config: OracleConfig): string {
  return config.effort === undefined ? config.model : `${config.model} · ${config.effort}`
}
