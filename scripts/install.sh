#!/usr/bin/env bash
# Installs the oracle plugin into ~/.claude/skills/oracle, where Claude Code
# loads it as a skills-directory plugin (oracle@skills-dir). It is for machines
# where you can't run /plugin, such as a Claude Code cloud environment, whose
# setup script runs:
#
#   curl -fsSL https://raw.githubusercontent.com/martinthommesen/oracle/main/scripts/install.sh | bash
#
# The files come from raw.githubusercontent.com, which a cloud environment's
# default (Trusted) network access allows. Set ORACLE_REF to install a tag or
# commit instead of main, and ORACLE_PLUGIN_DIR to install somewhere else.
set -euo pipefail

ref="${ORACLE_REF:-main}"
base="https://raw.githubusercontent.com/martinthommesen/oracle/${ref}/plugins/oracle"
target="${ORACLE_PLUGIN_DIR:-${HOME}/.claude/skills/oracle}"

# Everything the plugin loads. tests/plugin-files.spec.ts keeps this list in step with plugins/oracle/.
files=(
  .claude-plugin/plugin.json
  agents/oracle.md
  assets/icon.png
  hooks/config.ts
  hooks/hooks.json
  hooks/prompts.ts
  hooks/register.ts
  hooks/shell.ts
  hooks/thread.ts
  skills/oracle/SKILL.md
)

staging="$(mktemp -d)"
trap 'rm -rf "${staging}"' EXIT
for file in "${files[@]}"; do
  mkdir -p "${staging}/$(dirname "${file}")"
  curl -fsSL --retry 3 "${base}/${file}" -o "${staging}/${file}"
done

rm -rf "${target}"
mkdir -p "${target}"
cp -R "${staging}/." "${target}/"
echo "Installed the oracle plugin (${ref}) in ${target}"
