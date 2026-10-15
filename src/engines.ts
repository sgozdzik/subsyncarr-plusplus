export const ALL_ENGINES = ['ffsubsync', 'autosubsync', 'alass', 'claudesynchro'];

export function getEnabledEngines(): string[] {
  const configured = process.env.INCLUDE_ENGINES?.split(',')
    .map((engine) => engine.trim())
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : ALL_ENGINES;
}
