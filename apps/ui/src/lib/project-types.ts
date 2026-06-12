/**
 * Project and TrashedProject type definitions.
 *
 * Extracted from lib/electron.ts to break the electron.ts <-> app-store.ts
 * import cycle. Both modules now import from here instead of each other.
 */

export interface Project {
  id: string;
  name: string;
  path: string;
  lastOpened?: string;
  theme?: string; // Per-project theme override (uses ThemeMode from app-store)
  fontFamilySans?: string; // Per-project UI/sans font override
  fontFamilyMono?: string; // Per-project code/mono font override
  isFavorite?: boolean; // Pin project to top of dashboard
  icon?: string; // Lucide icon name for project identification
  customIconPath?: string; // Path to custom uploaded icon image in .aboardai/images/
  /**
   * Override the active Claude API profile for this project.
   * - undefined: Use global setting (activeClaudeApiProfileId)
   * - null: Explicitly use Direct Anthropic API (no profile)
   * - string: Use specific profile by ID
   * @deprecated Use phaseModelOverrides instead for per-phase model selection
   */
  activeClaudeApiProfileId?: string | null;
  /**
   * Per-phase model overrides for this project.
   * Keys are phase names (e.g., 'enhancementModel'), values are PhaseModelEntry.
   * If a phase is not present, the global setting is used.
   */
  phaseModelOverrides?: Partial<import('@aboardai/types').PhaseModelConfig>;
  /**
   * Override the default model for new feature cards in this project.
   * If not specified, falls back to the global defaultFeatureModel setting.
   */
  defaultFeatureModel?: import('@aboardai/types').PhaseModelEntry;
}

export interface TrashedProject extends Project {
  trashedAt: string;
  deletedFromDisk?: boolean;
}
