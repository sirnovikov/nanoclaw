const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Bash: 'Running',
  Grep: 'Searching',
  Glob: 'Searching files',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching',
  Agent: 'Delegating to subagent',
};

export function formatToolStatus(toolName: string, input?: string): string {
  const verb = TOOL_VERBS[toolName] ?? `Using ${toolName}`;

  if (input) {
    return `_${verb}_ \`${input}\``;
  }
  return `_${verb}..._`;
}
