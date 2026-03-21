import { describe, expect, it } from 'vitest';

import { formatToolStatus } from './format-tool-status.js';

describe('formatToolStatus', () => {
  it('formats Read with file path', () => {
    expect(formatToolStatus('Read', 'src/index.ts')).toBe(
      '_Reading_ `src/index.ts`',
    );
  });

  it('formats Bash with command', () => {
    expect(formatToolStatus('Bash', 'npm run build')).toBe(
      '_Running_ `npm run build`',
    );
  });

  it('formats Edit with file path', () => {
    expect(formatToolStatus('Edit', 'src/types.ts')).toBe(
      '_Editing_ `src/types.ts`',
    );
  });

  it('formats Write with file path', () => {
    expect(formatToolStatus('Write', 'src/new-file.ts')).toBe(
      '_Writing_ `src/new-file.ts`',
    );
  });

  it('formats Grep without input', () => {
    expect(formatToolStatus('Grep')).toBe('_Searching..._');
  });

  it('formats Grep with pattern', () => {
    expect(formatToolStatus('Grep', 'TODO')).toBe('_Searching_ `TODO`');
  });

  it('formats Glob without input', () => {
    expect(formatToolStatus('Glob')).toBe('_Searching files..._');
  });

  it('formats WebSearch with query', () => {
    expect(formatToolStatus('WebSearch', 'node streams')).toBe(
      '_Searching the web_ `node streams`',
    );
  });

  it('formats WebFetch with URL', () => {
    expect(formatToolStatus('WebFetch', 'https://example.com')).toBe(
      '_Fetching_ `https://example.com`',
    );
  });

  it('formats Agent tool', () => {
    expect(formatToolStatus('Agent')).toBe('_Delegating to subagent..._');
  });

  it('formats unknown tool without input', () => {
    expect(formatToolStatus('SomeNewTool')).toBe('_Using SomeNewTool..._');
  });

  it('formats unknown tool with input', () => {
    expect(formatToolStatus('SomeNewTool', 'arg')).toBe(
      '_Using SomeNewTool_ `arg`',
    );
  });
});
