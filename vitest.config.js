import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .claude/worktrees/ の下（Claude Code の作業用の複製）のテストを二重に拾わない。node_modules などの既定の除外は残す
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
