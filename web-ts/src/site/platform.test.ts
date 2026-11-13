import { describe, expect, it } from 'vitest';
import { defaultTab, tabButtonId, INSTALL_TAB_IDS } from './platform';

describe('defaultTab', () => {
  it('opens the Windows panel for Windows platforms', () => {
    expect(defaultTab({ platform: 'Win32' })).toBe('windows');
    expect(defaultTab({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(defaultTab({ platform: 'windows' })).toBe('windows');
  });

  it('opens the macOS/Linux panel for everything else', () => {
    expect(defaultTab({ platform: 'MacIntel' })).toBe('unix');
    expect(defaultTab({ platform: 'Linux x86_64' })).toBe('unix');
    expect(defaultTab({ userAgentData: { platform: 'macOS' } })).toBe('unix');
  });

  it('prefers userAgentData over the deprecated platform string', () => {
    expect(defaultTab({ userAgentData: { platform: 'Windows' }, platform: 'Linux x86_64' })).toBe(
      'windows',
    );
  });

  it('falls back to the macOS/Linux panel when the platform is unknown', () => {
    expect(defaultTab({})).toBe('unix');
    expect(defaultTab()).toBe('unix');
  });
});

describe('tabButtonId', () => {
  it('matches the ids used in index.html', () => {
    for (const tab of INSTALL_TAB_IDS) {
      expect(tabButtonId(tab)).toBe(`local-tab-${tab}`);
    }
  });
});
