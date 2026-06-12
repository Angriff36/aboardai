/**
 * Project persistence helpers.
 *
 * Extracted from lib/electron.ts to break the electron.ts <-> app-store.ts
 * import cycle. Lives below both electron.ts and app-store.ts in the
 * dependency graph: imports only from lib/storage and lib/project-types.
 */

import type { Project, TrashedProject } from './project-types';
import { getJSON, setJSON, removeItem } from './storage';

// Local storage keys
const STORAGE_KEYS = {
  PROJECTS: 'aboardai_projects',
  CURRENT_PROJECT: 'aboardai_current_project',
  TRASHED_PROJECTS: 'aboardai_trashed_projects',
} as const;

export const getStoredProjects = (): Project[] => {
  return getJSON<Project[]>(STORAGE_KEYS.PROJECTS) ?? [];
};

export const saveProjects = (projects: Project[]): void => {
  setJSON(STORAGE_KEYS.PROJECTS, projects);
};

export const getCurrentProject = (): Project | null => {
  return getJSON<Project>(STORAGE_KEYS.CURRENT_PROJECT);
};

export const setCurrentProject = (project: Project | null): void => {
  if (project) {
    setJSON(STORAGE_KEYS.CURRENT_PROJECT, project);
  } else {
    removeItem(STORAGE_KEYS.CURRENT_PROJECT);
  }
};

export const addProject = (project: Project): void => {
  const projects = getStoredProjects();
  const existing = projects.findIndex((p) => p.path === project.path);
  if (existing >= 0) {
    projects[existing] = { ...project, lastOpened: new Date().toISOString() };
  } else {
    projects.push({ ...project, lastOpened: new Date().toISOString() });
  }
  saveProjects(projects);
};

export const removeProject = (projectId: string): void => {
  const projects = getStoredProjects().filter((p) => p.id !== projectId);
  saveProjects(projects);
};

export const getStoredTrashedProjects = (): TrashedProject[] => {
  return getJSON<TrashedProject[]>(STORAGE_KEYS.TRASHED_PROJECTS) ?? [];
};

export const saveTrashedProjects = (projects: TrashedProject[]): void => {
  setJSON(STORAGE_KEYS.TRASHED_PROJECTS, projects);
};
