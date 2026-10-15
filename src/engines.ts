export const ALL_ENGINES = ['ffsubsync', 'autosubsync', 'alass', 'claudesynchro'];

// Engines chosen in the Settings page (stored in the database) take precedence over INCLUDE_ENGINES.
let uiEngines: string[] | null = null;

export function setEngineOverride(engines: string[] | null): void {
  uiEngines = engines && engines.length > 0 ? ALL_ENGINES.filter((engine) => engines.includes(engine)) : null;
}

export function envEngines(): string[] {
  const configured = process.env.INCLUDE_ENGINES?.split(',')
    .map((engine) => engine.trim())
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : ALL_ENGINES;
}

export function getEnabledEngines(): string[] {
  return uiEngines ?? envEngines();
}
