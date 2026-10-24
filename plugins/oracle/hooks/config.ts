// The oracle's settings, as the /config rows (the manifest's userConfig) hold them.

import { parseExtraPrefixes } from './readonly.ts'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export const DEFAULT_MODEL = 'opus'
export const DEFAULT_EFFORT: Effort = 'xhigh'

export type OracleConfig = {
  /** What the oracle runs on: an alias (opus, best, fable, sonnet, haiku), inherit, or a full model ID. */
  model: string
  /** Its effort level; undefined leaves the model's own default. */
  effort: Effort | undefined
  /** Command prefixes the user allowed beyond the built-in read-only set. */
  extraCommands: string[][]
}

// Model IDs and aliases as --model takes them: claude-opus-5-5, opus[1m],
// us.anthropic.claude-…, arn:aws:bedrock:…/…, a gateway's own name.
const MODEL_PATTERN = /^[A-Za-z0-9._:/@[\]-]{1,200}$/

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value)
}

/** Reads the plugin's options, falling back to defaults with a warning for what is unusable. */
export function readConfig(options: Readonly<Record<string, unknown>>): { config: OracleConfig; warnings: string[] } {
  const warnings: string[] = []

  let model = text(options.model)
  if (model === '') {
    model = DEFAULT_MODEL
  } else if (!MODEL_PATTERN.test(model)) {
    warnings.push(`"${model}" is not a model name; the oracle uses ${DEFAULT_MODEL}`)
    model = DEFAULT_MODEL
  }

  let effort: Effort | undefined = DEFAULT_EFFORT
  const chosen = text(options.effort).toLowerCase()
  if (chosen === 'auto') {
    effort = undefined
  } else if (isEffort(chosen)) {
    effort = chosen
  } else if (chosen !== '') {
    warnings.push(`"${chosen}" is not an effort level; the oracle uses ${DEFAULT_EFFORT}`)
  }

  return { config: { model, effort, extraCommands: parseExtraPrefixes(text(options.extra_commands)) }, warnings }
}

/** How the configuration reads in a status line: `opus · xhigh`. */
export function describeConfig(config: OracleConfig): string {
  return config.effort === undefined ? config.model : `${config.model} · ${config.effort}`
}
