// The oracle's settings, as the /config rows (the manifest's userConfig) hold them.
//
// The engine fills in the manifest's defaults and keeps a picked field to its
// options, so only the free-text fields need reading here.

import { parseExtraPrefixes } from './shell.ts'

/** The manifest's default model, for a field the user cleared. */
export const DEFAULT_MODEL = 'opus'

export type OracleConfig = {
  /** What the oracle runs on: an alias (opus, best, fable, sonnet, haiku), inherit, or a full model ID. */
  model: string
  /** Its effort level; undefined leaves the model's own default. */
  effort: string | undefined
  /** Command prefixes the user allowed beyond what Claude Code judges read-only. */
  extraCommands: string[][]
}

// Model IDs and aliases as --model takes them: claude-opus-5-5, opus[1m],
// us.anthropic.claude-…, arn:aws:bedrock:…/…, a gateway's own name.
const MODEL_PATTERN = /^[A-Za-z0-9._:/@[\]-]{1,200}$/

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Reads the plugin's options, falling back to the default model with a warning when the model is unusable. */
export function readConfig(options: Readonly<Record<string, unknown>>): { config: OracleConfig; warnings: string[] } {
  const warnings: string[] = []

  let model = text(options.model) || DEFAULT_MODEL
  if (!MODEL_PATTERN.test(model)) {
    warnings.push(`"${model}" is not a model name; the oracle uses ${DEFAULT_MODEL}`)
    model = DEFAULT_MODEL
  }

  const effort = text(options.effort)
  return {
    config: {
      model,
      effort: effort === '' || effort === 'auto' ? undefined : effort,
      extraCommands: parseExtraPrefixes(text(options.extra_commands)),
    },
    warnings,
  }
}

/** How the configuration reads in a status line: `opus · xhigh`. */
export function describeConfig(config: OracleConfig): string {
  return config.effort === undefined ? config.model : `${config.model} · ${config.effort}`
}
