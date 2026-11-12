/** A losing Electron instance may still resolve whenReady after quit(). */
export function acquireDesktopPrimaryInstance(app: {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}): boolean {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) app.quit();
  return acquired;
}
