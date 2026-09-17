import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type SlackRecoveryAction = 'try_other_tabs' | 'keep_first_window' | 'reopen_window' | 'open_slack';
export interface SlackCheckerBrowser {
  evaluate(script: string, selection: 'first' | 'others'): Promise<string>;
  recover(action: Exclude<SlackRecoveryAction, 'try_other_tabs'>): Promise<void>;
}
export type AppleScriptRunner = (script: string) => Promise<string>;
const exec = promisify(execFile);
const appleString = (value: string): string => JSON.stringify(value);
const chrome = 'application id "com.google.Chrome"';

/** Never return osascript stderr: Chrome errors can contain page content or script inputs. */
export const runAppleScript: AppleScriptRunner = async script => {
  try {
    const result = await exec('/usr/bin/osascript', ['-e', script], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    throw new Error('Chrome automation failed or timed out; check Chrome permissions and Allow JavaScript from Apple Events.');
  }
};

export class ChromeSlackBrowser implements SlackCheckerBrowser {
  private oldestWindowId: number | undefined;
  constructor(private readonly workspaceUrl: string, private readonly run: AppleScriptRunner = runAppleScript) {}

  private async windows(): Promise<number[]> {
    const raw = await this.run(`if application id "com.google.Chrome" is not running then return ""
tell ${chrome} to return id of every window`);
    const ids = raw.trim() ? raw.split(',').map(id => Number(id.trim())) : [];
    if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Could not read Chrome windows.');
    if (this.oldestWindowId !== undefined && !ids.includes(this.oldestWindowId)) this.oldestWindowId = undefined;
    // Chrome's window order is front-to-back, not creation order. A sole observed window is unambiguous.
    if (ids.length === 1) this.oldestWindowId = ids[0];
    return ids;
  }

  async evaluate(script: string, selection: 'first' | 'others'): Promise<string> {
    await this.windows();
    return this.run(`if application id "com.google.Chrome" is not running then return "NO_SLACK_TAB"
set matchCount to 0
set lastResult to "NO_SLACK_TAB"
tell ${chrome}
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t) starts with "https://app.slack.com/" then
        set matchCount to matchCount + 1
        if ${selection === 'first' ? 'matchCount is 1' : 'matchCount > 1'} then
          try
            tell t to set lastResult to execute javascript ${appleString(script)}
          on error
            set lastResult to "CHROME_TAB_EXECUTION_FAILED"
          end try
          ${selection === 'first' ? 'return lastResult' : `if lastResult starts with ${appleString('{"ok":true,')} then return lastResult`}
        end if
      end if
    end repeat
  end repeat
end tell
return lastResult`);
  }

  async recover(action: Exclude<SlackRecoveryAction, 'try_other_tabs'>): Promise<void> {
    const ids = await this.windows();
    if (action === 'keep_first_window') {
      if (ids.length <= 1) return;
      if (this.oldestWindowId === undefined) {
        throw new Error('Chrome does not expose window creation times; the oldest of these existing windows is unknown. Try reopen_window if needed.');
      }
      await this.run(`tell ${chrome}
  repeat with w in (every window)
    if id of w is not ${this.oldestWindowId} then close w
  end repeat
end tell`);
    } else if (action === 'reopen_window') {
      await this.run(`tell ${chrome}
  close every window
  make new window
end tell`);
      await this.windows();
    } else {
      await this.run(`tell ${chrome}
  if (count of windows) is 0 then make new window
  tell front window to make new tab with properties {URL:${appleString(this.workspaceUrl)}}
end tell`);
    }
  }
}
