export interface TrayMenuSnapshot {
  daemon: { running: boolean };
  auto_start: boolean;
  targets: readonly unknown[];
}

export function trayMenuStateKey(snapshot: TrayMenuSnapshot): string {
  return JSON.stringify([snapshot.daemon.running, snapshot.auto_start, snapshot.targets.length]);
}
