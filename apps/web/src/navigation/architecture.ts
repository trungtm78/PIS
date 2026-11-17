import architectureJson from '@design/03_Engineering/navigation_architecture.json';

/** One task group of a module in navigation_architecture.json: the screens by number and which of them are primary. */
export interface TaskGroup {
  title: string;
  description: string;
  ids: number[];
  primary: number[];
  parents: Record<string, number>;
}

export interface ModuleEntry {
  name: string;
  groups: TaskGroup[];
}

export interface LibraryGroup {
  id: string;
  name: string;
  icon: string;
  modules: string[];
}

/** The part of navigation_architecture.json the shell reads; the file is the single source of the navigation. */
export interface NavArchitecture {
  libraryGroups: LibraryGroup[];
  modules: Record<string, ModuleEntry>;
  /** [module, label, icon] */
  quickModules: [string, string, string][];
  /** module -> [screen number, title, icon?][]; the icon is optional and is drawn before the title of the shortcut. */
  contextualShortcuts: Record<string, [number, string, string?][]>;
  moduleDescriptions: Record<string, string>;
  adminLibraryModules: string[];
}

export const ARCHITECTURE: NavArchitecture = architectureJson as unknown as NavArchitecture;
