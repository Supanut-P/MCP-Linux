/** Inherit OS/runtime paths only; never provider keys, tokens or proxy credentials. */
export function createSafeProcessEnvironment(source: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'CODEX_HOME',
    'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY',
    ...(platform === 'win32' ? ['SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'] : []),
  ]);
  return Object.fromEntries(Object.entries(source).flatMap(([key, value]) => {
    const normalized = platform === 'win32' ? key.toUpperCase() : key;
    return value !== undefined && allowed.has(normalized) ? [[normalized, value]] : [];
  }));
}
