// Runs before first paint so a saved light/dark choice doesn't flash.
try {
  const theme = JSON.parse(localStorage.getItem('remote-thermostat-settings') || '{}').theme;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  /* Storage is optional. */
}
