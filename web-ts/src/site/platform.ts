/**
 * Which install panel `#local` opens by default.
 *
 * Kept as its own module because it is the only part of the install copy that
 * JavaScript needs: the commands and expected output stay in the static markup
 * so there is no second source of truth to drift.
 */
export type InstallTab = 'unix' | 'windows' | 'docker';

export const INSTALL_TAB_IDS: readonly InstallTab[] = ['unix', 'windows', 'docker'];

interface NavigatorLike {
  userAgentData?: { platform?: string };
  platform?: string;
}

/**
 * Picks the install panel for the current platform.
 *
 * Pure, and takes the navigator as an argument so it can be tested without a
 * browser. Never probes the network, which keeps the static build's
 * `connect-src 'none'` honest.
 */
export function defaultTab(nav?: NavigatorLike): InstallTab {
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /win/i.test(name) ? 'windows' : 'unix';
}

/** DOM id of the tab button for a panel, shared by markup and wiring. */
export function tabButtonId(tab: InstallTab): string {
  return `local-tab-${tab}`;
}
